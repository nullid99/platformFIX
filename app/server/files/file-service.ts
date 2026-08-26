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
  "application/pdf",
  "video/mp4",
  "video/webm",
]);

type UploadInput = {
  originalName: string;
  mimeType: string;
  byteSize: number;
};

export type UploadPurpose = "submission" | "module-cover" | "chat";

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
    if (purpose === "module-cover") {
      const curator = await prisma.user.findUnique({ where: { id: ownerId }, select: { role: true } });
      if (!curator || (curator.role !== UserRole.CURATOR && curator.role !== UserRole.OWNER)) throw new AuthServiceError("FORBIDDEN", "Only a curator can upload a module cover");
    }
    if (purpose === "chat") await assertPracticumViewer(ownerId);
    const originalName = normalizeName(input.originalName);
    const mimeType = normalizeType(input.mimeType);
    const byteSize = assertSize(input.byteSize);
    if (purpose === "module-cover" && (!mimeType.startsWith("image/") || byteSize > 5 * 1024 * 1024)) throw new AuthServiceError("INVALID_INPUT", "Module cover must be an image up to 5 MB");
    if (purpose === "chat" && (!mimeType.startsWith("image/") || byteSize > 8 * 1024 * 1024)) throw new AuthServiceError("INVALID_INPUT", "Chat images must be up to 8 MB");
    const id = randomUUID();
    const storageKey = `${purpose === "module-cover" ? "module-covers/pending" : purpose === "chat" ? "chat" : "submissions"}/${ownerId}/${id}`;
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
    if (uniqueIds.length > 5) throw new AuthServiceError("INVALID_INPUT", "Too many files");
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

  public async deleteUnattached(actorId: string, fileId: string): Promise<void> {
    const file = await prisma.storedFile.findUnique({ where: { id: fileId }, include: { submissions: { select: { id: true } } } });
    if (!file || file.ownerId !== actorId || file.submissions.length > 0) throw new AuthServiceError("FORBIDDEN", "File cannot be deleted");
    await rm(storagePath(file.storageKey), { force: true });
    await prisma.storedFile.delete({ where: { id: fileId } });
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
            lesson: { module: { practicum: { enrollments: { some: { studentId: actorId, status: EnrollmentStatus.ACTIVE } } } } },
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
      if (actor.role !== UserRole.OWNER && !isLocalTestCurator && assigned === 0 && studentMaterialAccess === 0 && moduleCoverAccess === 0 && curatorModuleAccess === 0 && curatorStreamChatAccess === 0 && studentStreamChatAccess === 0 && curatorDiscussionAccess === 0 && studentDiscussionAccess === 0) throw new AuthServiceError("FORBIDDEN", "File access is not allowed");
    }
    return { id: file.id, storageKey: file.storageKey, originalName: file.originalName, mimeType: file.mimeType, byteSize: file.byteSize };
  }

  private async assertActiveUser(userId: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    if (!user || user.status !== UserStatus.ACTIVE) throw new AuthServiceError("FORBIDDEN", "Active session is required");
  }
}

export const fileService = new FileService();
