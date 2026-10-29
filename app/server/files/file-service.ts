import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, rename, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { AssignmentStatus, EnrollmentStatus, IdentityProvider, ModuleAccessStatus, StoredFileStatus, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { AuthServiceError } from "@/app/server/auth";
import { assertPracticumViewer } from "@/app/server/streams/access";

const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_FILE_NAME_LENGTH = 180;
const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "video/mp4",
  "video/webm",
]);

type UploadInput = {
  originalName: string;
  mimeType: string;
  byteSize: number;
};

export type UploadPurpose = "submission" | "module-cover" | "chat" | "schedule-cover" | "schedule-cover-template";

type FileAccessRecord = {
  id: string;
  storageKey: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
};

function storageRoot(): string {
  const configured = process.env.FILE_STORAGE_ROOT?.trim();
  return resolve(configured || join(process.cwd(), ".storage", "private"));
}

function maxUploadBytes(): number {
  const configured = Number(process.env.MAX_UPLOAD_BYTES ?? DEFAULT_MAX_UPLOAD_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_UPLOAD_BYTES;
}

function normalizeName(value: string): string {
  const name = basename(value).trim();
  if (!name || name.length > MAX_FILE_NAME_LENGTH) throw new AuthServiceError("INVALID_INPUT", "File name is invalid");
  return name;
}

function normalizeType(value: string): string {
  const type = value.trim().toLowerCase();
  if (!ALLOWED_TYPES.has(type)) throw new AuthServiceError("INVALID_INPUT", "File type is not allowed");
  return type;
}

function assertSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maxUploadBytes()) throw new AuthServiceError("INVALID_INPUT", "File size is invalid");
  return value;
}

function storagePath(storageKey: string): string {
  const root = storageRoot();
  const path = resolve(root, storageKey);
  if (path !== root && !path.startsWith(root + String.fromCharCode(92)) && !path.startsWith(`${root}/`)) throw new AuthServiceError("INVALID_INPUT", "Storage key is invalid");
  return path;
}

export class FileService {
  public async createUpload(ownerId: string, input: UploadInput, purpose: UploadPurpose = "submission") {
    await this.assertActiveUser(ownerId);
    const isCuratorCover = purpose === "module-cover" || purpose === "schedule-cover" || purpose === "schedule-cover-template";
    if (isCuratorCover) {
      const curator = await prisma.user.findUnique({ where: { id: ownerId }, select: { role: true } });
      if (!curator || (curator.role !== UserRole.CURATOR && curator.role !== UserRole.OWNER)) throw new AuthServiceError("FORBIDDEN", "Only a curator can upload this cover");
    }
    if (purpose === "chat") await assertPracticumViewer(ownerId);
    const originalName = normalizeName(input.originalName);
    const mimeType = normalizeType(input.mimeType);
    const byteSize = assertSize(input.byteSize);
    if (isCuratorCover && (!mimeType.startsWith("image/") || byteSize > 5 * 1024 * 1024)) throw new AuthServiceError("INVALID_INPUT", "Cover image must be up to 5 MB");
    if (purpose === "chat" && (!mimeType.startsWith("image/") || byteSize > 8 * 1024 * 1024)) throw new AuthServiceError("INVALID_INPUT", "Chat images must be up to 8 MB");
    const id = randomUUID();
    const storagePrefixByPurpose: Record<UploadPurpose, string> = {
      submission: "submissions",
      "module-cover": "module-covers/pending",
      chat: "chat",
      "schedule-cover": "schedule-covers/pending",
      "schedule-cover-template": "schedule-cover-templates/pending",
    };
    const storageKey = `${storagePrefixByPurpose[purpose]}/${ownerId}/${id}`;
    const file = await prisma.storedFile.create({
      data: { id, ownerId, storageKey, originalName, mimeType, byteSize, status: StoredFileStatus.PENDING },
      select: { id: true },
    });
    return { id: file.id, uploadUrl: `/api/files/${file.id}/content` };
  }

  public async attachToModuleCover(actorId: string, moduleId: string, fileId: string): Promise<{ moduleId: string; coverPath: string }> {
    const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { role: true, status: true } });
    if (!actor || actor.status !== UserStatus.ACTIVE || (actor.role !== UserRole.CURATOR && actor.role !== UserRole.OWNER)) throw new AuthServiceError("FORBIDDEN", "Only a curator can change module covers");
    const file = await prisma.storedFile.findUnique({ where: { id: fileId }, select: { id: true, ownerId: true, status: true, storageKey: true } });
    const courseModule = await prisma.module.findUnique({ where: { id: moduleId }, select: { id: true } });
    if (!courseModule) throw new AuthServiceError("INVALID_INPUT", "Module does not exist");
    if (!file || file.ownerId !== actorId || file.status !== StoredFileStatus.UPLOADED || !file.storageKey.startsWith("module-covers/pending/")) throw new AuthServiceError("FORBIDDEN", "This file cannot be used as a module cover");
    const storageKey = `module-covers/${moduleId}/${file.id}`;
    const coverPath = `/api/files/${file.id}/content`;
    const source = storagePath(file.storageKey);
    const target = storagePath(storageKey);
    await mkdir(resolve(target, ".."), { recursive: true });
    try {
      await rename(source, target);
      try {
        await prisma.$transaction([
          prisma.storedFile.update({ where: { id: file.id }, data: { storageKey } }),
          prisma.module.update({ where: { id: moduleId }, data: { coverPath } }),
        ]);
      } catch (error) {
        await rename(target, source).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (error instanceof AuthServiceError) throw error;
      throw new AuthServiceError("INVALID_INPUT", "Module cover file is unavailable");
    }
    return { moduleId, coverPath };
  }

  /** One-off cover for a single schedule event — see ScheduleService#create/#update. Unlike a
    * template, this never gets its own ScheduleCoverTemplate row. */
  public async attachToScheduleEventCover(actorId: string, eventId: string, fileId: string): Promise<string> {
    const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { role: true, status: true } });
    if (!actor || actor.status !== UserStatus.ACTIVE || (actor.role !== UserRole.CURATOR && actor.role !== UserRole.OWNER)) throw new AuthServiceError("FORBIDDEN", "Only a curator can change event covers");
    const file = await prisma.storedFile.findUnique({ where: { id: fileId }, select: { id: true, ownerId: true, status: true, storageKey: true } });
    if (!file || file.ownerId !== actorId || file.status !== StoredFileStatus.UPLOADED || !file.storageKey.startsWith("schedule-covers/pending/")) throw new AuthServiceError("FORBIDDEN", "This file cannot be used as an event cover");
    const storageKey = `schedule-covers/${eventId}/${file.id}`;
    const coverPath = `/api/files/${file.id}/content`;
    const source = storagePath(file.storageKey);
    const target = storagePath(storageKey);
    await mkdir(resolve(target, ".."), { recursive: true });
    try {
      await rename(source, target);
      try {
        await prisma.storedFile.update({ where: { id: file.id }, data: { storageKey } });
      } catch (error) {
        await rename(target, source).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (error instanceof AuthServiceError) throw error;
      throw new AuthServiceError("INVALID_INPUT", "Event cover file is unavailable");
    }
    return coverPath;
  }

  /** A reusable, platform-wide cover — see ScheduleCoverTemplate in schema.prisma. Deleting one
    * later (deleteScheduleCoverTemplate) only removes this row, never the file itself, so an
    * event that already copied its coverPath keeps working. */
  public async createScheduleCoverTemplate(actorId: string, fileId: string, label: string): Promise<{ id: string; label: string; coverPath: string }> {
    const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { role: true, status: true } });
    if (!actor || actor.status !== UserStatus.ACTIVE || (actor.role !== UserRole.CURATOR && actor.role !== UserRole.OWNER)) throw new AuthServiceError("FORBIDDEN", "Only a curator can manage cover templates");
    const normalizedLabel = label.trim().slice(0, 60);
    if (!normalizedLabel) throw new AuthServiceError("INVALID_INPUT", "label is required");
    const file = await prisma.storedFile.findUnique({ where: { id: fileId }, select: { id: true, ownerId: true, status: true, storageKey: true } });
    if (!file || file.ownerId !== actorId || file.status !== StoredFileStatus.UPLOADED || !file.storageKey.startsWith("schedule-cover-templates/pending/")) throw new AuthServiceError("FORBIDDEN", "This file cannot be used as a cover template");
    const created = await prisma.scheduleCoverTemplate.create({ data: { label: normalizedLabel, coverPath: "" }, select: { id: true } });
    const storageKey = `schedule-cover-templates/${created.id}/${file.id}`;
    const coverPath = `/api/files/${file.id}/content`;
    const source = storagePath(file.storageKey);
    const target = storagePath(storageKey);
    await mkdir(resolve(target, ".."), { recursive: true });
    try {
      await rename(source, target);
      await prisma.$transaction([
        prisma.storedFile.update({ where: { id: file.id }, data: { storageKey } }),
        prisma.scheduleCoverTemplate.update({ where: { id: created.id }, data: { coverPath } }),
      ]);
    } catch (error) {
      await prisma.scheduleCoverTemplate.delete({ where: { id: created.id } }).catch(() => undefined);
      await rename(target, source).catch(() => undefined);
      throw new AuthServiceError("INVALID_INPUT", "Cover template file is unavailable");
    }
    return { id: created.id, label: normalizedLabel, coverPath };
  }

  public async listScheduleCoverTemplates(): Promise<Array<{ id: string; label: string; coverPath: string }>> {
    return prisma.scheduleCoverTemplate.findMany({ orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { id: true, label: true, coverPath: true } });
  }

  /** Only removes the template row — the underlying file (if any) is left in place so an event
    * that already copied this template's coverPath keeps showing it. */
  public async deleteScheduleCoverTemplate(actorId: string, templateId: string): Promise<void> {
    const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { role: true, status: true } });
    if (!actor || actor.status !== UserStatus.ACTIVE || (actor.role !== UserRole.CURATOR && actor.role !== UserRole.OWNER)) throw new AuthServiceError("FORBIDDEN", "Only a curator can manage cover templates");
    await prisma.scheduleCoverTemplate.delete({ where: { id: templateId } }).catch(() => {
      throw new AuthServiceError("INVALID_INPUT", "Cover template does not exist");
    });
  }

  public async uploadContent(actorId: string, fileId: string, body: NodeJS.ReadableStream): Promise<void> {
    const file = await prisma.storedFile.findUnique({ where: { id: fileId }, select: { id: true, ownerId: true, storageKey: true, byteSize: true, status: true } });
    if (!file || file.ownerId !== actorId || file.status !== StoredFileStatus.PENDING) throw new AuthServiceError("FORBIDDEN", "File upload is not allowed");
    const target = storagePath(file.storageKey);
    await mkdir(resolve(target, ".."), { recursive: true });
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > maxUploadBytes()) callback(new Error("File is too large"));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(body, limiter, createWriteStream(target, { flags: "wx" }));
      if (received !== file.byteSize) throw new Error("Uploaded file size does not match metadata");
      await prisma.storedFile.update({ where: { id: file.id }, data: { status: StoredFileStatus.UPLOADED } });
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined);
      await prisma.storedFile.update({ where: { id: file.id }, data: { status: StoredFileStatus.FAILED } }).catch(() => undefined);
      if (error instanceof AuthServiceError) throw error;
      throw new AuthServiceError("INVALID_INPUT", error instanceof Error ? error.message : "File upload failed");
    }
  }

  public async attachToSubmission(studentId: string, submissionId: string, fileIds: string[]): Promise<void> {
    if (fileIds.length === 0) return;
    const uniqueIds = [...new Set(fileIds)];
    if (uniqueIds.length > 20) throw new AuthServiceError("INVALID_INPUT", "Too many files");
    const files = await prisma.storedFile.findMany({ where: { id: { in: uniqueIds }, ownerId: studentId, status: StoredFileStatus.UPLOADED }, select: { id: true } });
    if (files.length !== uniqueIds.length) throw new AuthServiceError("FORBIDDEN", "File ownership is invalid");
    await prisma.submissionAttachment.createMany({ data: uniqueIds.map((fileId, position) => ({ submissionId, fileId, position })) });
  }

  public async getReadable(actorId: string, fileId: string) {
    const file = await this.getAuthorizedFile(actorId, fileId);
    const path = storagePath(file.storageKey);
    const fileInfo = await stat(path).catch(() => null);
    if (!fileInfo?.isFile() || fileInfo.size !== file.byteSize) throw new AuthServiceError("INVALID_INPUT", "File is unavailable");
    return { ...file, stream: createReadStream(path) };
  }

  /**
   * Only a file nothing points at, and the row goes before the bytes: this used to check only
   * ДЗ attachments and `rm` first, so deleting a file attached to a discussion wiped it from disk
   * and then failed on the FK — the curator was left with a broken attachment (security review
   * STG-4, 2026-10-17).
   */
  public async deleteUnattached(actorId: string, fileId: string): Promise<void> {
    const file = await prisma.storedFile.findUnique({
      where: { id: fileId },
      select: {
        ownerId: true,
        storageKey: true,
        _count: { select: { submissions: true, assignmentMaterials: true, discussionAttachments: true, feedbackAttachments: true, streamMessages: true } },
      },
    });
    const attached = file ? Object.values(file._count).some((count) => count > 0) : false;
    if (!file || file.ownerId !== actorId || attached) throw new AuthServiceError("FORBIDDEN", "File cannot be deleted");
    await prisma.storedFile.delete({ where: { id: fileId } }).catch(() => {
      throw new AuthServiceError("FORBIDDEN", "File cannot be deleted");
    });
    await rm(storagePath(file.storageKey), { force: true });
  }

  /**
   * Uploads that never finished (PENDING — the browser never sent the bytes, or FAILED) after
   * `maxAgeMs`: row first, then whatever partial bytes exist. Neither status can be attached to
   * anything; the relation count is a belt-and-braces check (security review STG-5, 2026-10-17).
   */
  public async cleanupStaleUploads(maxAgeMs: number, now = new Date()): Promise<number> {
    const stale = await prisma.storedFile.findMany({
      where: { status: { in: [StoredFileStatus.PENDING, StoredFileStatus.FAILED] }, createdAt: { lt: new Date(now.getTime() - maxAgeMs) } },
      select: { id: true, storageKey: true, _count: { select: { submissions: true, assignmentMaterials: true, discussionAttachments: true, feedbackAttachments: true, streamMessages: true } } },
      take: 500,
    });
    let removed = 0;
    for (const file of stale) {
      if (Object.values(file._count).some((count) => count > 0)) continue;
      const deleted = await prisma.storedFile.deleteMany({ where: { id: file.id, status: { in: [StoredFileStatus.PENDING, StoredFileStatus.FAILED] } } });
      if (deleted.count === 0) continue;
      await rm(storagePath(file.storageKey), { force: true });
      removed += 1;
    }
    return removed;
  }

  /** Remove a module cover after the owning module has been deleted. */
  public async cleanupModuleCover(fileId: string, moduleId: string): Promise<void> {
    const file = await prisma.storedFile.findUnique({ where: { id: fileId }, select: { storageKey: true } });
    if (!file || file.storageKey !== `module-covers/${moduleId}/${fileId}`) return;
    await rm(storagePath(file.storageKey), { force: true }).catch(() => undefined);
    await prisma.storedFile.delete({ where: { id: fileId } }).catch(() => undefined);
  }

  private async getAuthorizedFile(actorId: string, fileId: string): Promise<FileAccessRecord> {
    const [actor, file] = await Promise.all([
      prisma.user.findUnique({ where: { id: actorId }, select: { role: true, status: true, externalIdentities: { where: { provider: IdentityProvider.LOCAL, providerSubject: "local-curator" }, select: { id: true } } } }),
      prisma.storedFile.findUnique({
        where: { id: fileId },
        include: {
          submissions: { include: { submission: { select: { studentId: true } } } },
          assignmentMaterials: { select: { assignmentId: true } },
          streamMessages: { select: { practicumId: true } },
          discussionAttachments: { select: { message: { select: { thread: { select: { studentId: true, module: { select: { practicumId: true } } } } } } } },
          feedbackAttachments: { select: { feedback: { select: { submission: { select: { studentId: true } } } } } },
        },
      }),
    ]);
    if (!actor || actor.status !== UserStatus.ACTIVE || !file || file.status !== StoredFileStatus.UPLOADED) throw new AuthServiceError("FORBIDDEN", "File access is not allowed");
    const isLocalTestCurator = process.env.NODE_ENV !== "production" && actor.role === UserRole.CURATOR && actor.externalIdentities.length > 0;
    const moduleCoverMatch = /^module-covers\/([^/]+)\/([^/]+)$/.exec(file.storageKey);
    const moduleCoverModuleId = moduleCoverMatch?.[1];
    const moduleCoverAccess = moduleCoverModuleId && actor.role === UserRole.STUDENT
      ? await prisma.enrollmentModuleAccess.count({ where: { moduleId: moduleCoverModuleId, status: ModuleAccessStatus.UNLOCKED, enrollment: { studentId: actorId, status: EnrollmentStatus.ACTIVE, OR: [{ accessUntil: null }, { accessUntil: { gt: new Date() } }] } } })
      : 0;
    const curatorModuleAccess = moduleCoverModuleId && (actor.role === UserRole.CURATOR || actor.role === UserRole.OWNER) ? 1 : 0;
    // A schedule-event cover (one-off or a reusable template) is decorative, shown on the
    // schedule page to whichever cohort can already see the event — already less exposed than
    // the fully-public static /event-covers/*.png files this replaces, so any active session
    // (any role, any practicum) is enough rather than re-deriving per-event enrollment here.
    const scheduleCoverAccess = /^schedule-covers\/|^schedule-cover-templates\//.test(file.storageKey) ? 1 : 0;
    if (file.ownerId !== actorId) {
      const studentIds = file.submissions.map((item) => item.submission.studentId);
      // Any active curator can open a submission's attachments, same as the review queue
      // (listQueue) now shows every submission regardless of who it's assigned to.
      const assigned = actor.role === UserRole.CURATOR && studentIds.length > 0 ? 1 : 0;
      const studentMaterialAccess = actor.role === UserRole.STUDENT && file.assignmentMaterials.length > 0
        ? await prisma.assignment.count({
          where: {
            id: { in: file.assignmentMaterials.map((material) => material.assignmentId) },
            status: AssignmentStatus.PUBLISHED,
            // practicumId is always set (see the schema comment on Assignment.practicumId) —
            // going through `module.practicum` instead always missed a practice assignment,
            // whose moduleId is null by design, so this check silently denied every material
            // attached to one (broken-image icon for the student, not a thrown/visible error).
            practicum: { enrollments: { some: { studentId: actorId, status: EnrollmentStatus.ACTIVE } } },
          },
        })
        : 0;
      const streamChatPracticumIds = file.streamMessages.map((message) => message.practicumId);
      const curatorStreamChatAccess = streamChatPracticumIds.length > 0 && (actor.role === UserRole.CURATOR || actor.role === UserRole.OWNER) ? 1 : 0;
      const studentStreamChatAccess = actor.role === UserRole.STUDENT && streamChatPracticumIds.length > 0
        ? await prisma.enrollment.count({ where: { studentId: actorId, practicumId: { in: streamChatPracticumIds }, status: EnrollmentStatus.ACTIVE, OR: [{ accessUntil: null }, { accessUntil: { gt: new Date() } }] } })
        : 0;
      // Any curator can review a discussion attachment (matches "every curator sees every
      // thread"). A student can too, but only if they're actively enrolled in the same
      // practicum as the thread — covers both the asker (if they aren't file.ownerId for
      // some reason) and the anonymous cohort feed, where a classmate reads someone else's
      // answered question and its attached screenshot.
      const discussionPracticumIds = file.discussionAttachments.flatMap((attachment) => attachment.message.thread.module ? [attachment.message.thread.module.practicumId] : []);
      const curatorDiscussionAccess = discussionPracticumIds.length > 0 && (actor.role === UserRole.CURATOR || actor.role === UserRole.OWNER) ? 1 : 0;
      const studentDiscussionAccess = actor.role === UserRole.STUDENT && discussionPracticumIds.length > 0
        ? await prisma.enrollment.count({ where: { studentId: actorId, practicumId: { in: discussionPracticumIds }, status: EnrollmentStatus.ACTIVE, OR: [{ accessUntil: null }, { accessUntil: { gt: new Date() } }] } })
        : 0;
      // A curator's feedback attachment (screenshot pasted while reviewing a submission)
      // needs to reach the student it was written for, plus any curator reviewing the
      // same submission — same access shape as the student's own submission attachments.
      const feedbackStudentIds = file.feedbackAttachments.map((attachment) => attachment.feedback.submission.studentId);
      const curatorFeedbackAccess = actor.role === UserRole.CURATOR && feedbackStudentIds.length > 0 ? 1 : 0;
      const studentFeedbackAccess = actor.role === UserRole.STUDENT && feedbackStudentIds.includes(actorId) ? 1 : 0;
      if (actor.role !== UserRole.OWNER && !isLocalTestCurator && assigned === 0 && studentMaterialAccess === 0 && moduleCoverAccess === 0 && curatorModuleAccess === 0 && curatorStreamChatAccess === 0 && studentStreamChatAccess === 0 && curatorDiscussionAccess === 0 && studentDiscussionAccess === 0 && curatorFeedbackAccess === 0 && studentFeedbackAccess === 0 && scheduleCoverAccess === 0) throw new AuthServiceError("FORBIDDEN", "File access is not allowed");
    }
    return { id: file.id, storageKey: file.storageKey, originalName: file.originalName, mimeType: file.mimeType, byteSize: file.byteSize };
  }

  private async assertActiveUser(userId: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    if (!user || user.status !== UserStatus.ACTIVE) throw new AuthServiceError("FORBIDDEN", "Active session is required");
  }
}

export const fileService = new FileService();
