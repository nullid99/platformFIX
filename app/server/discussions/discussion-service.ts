import { Prisma } from "@/app/generated/prisma/client";
import { DiscussionStatus, DiscussionVisibility, StoredFileStatus, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { AuthServiceError } from "@/app/server/auth";
import { sendDiscussionNotification } from "@/app/server/notifications/email-service";
import { notificationService } from "@/app/server/notifications/notification-service";

type DiscussionAttachmentInput = {
  fileId?: string;
  sourceUrl?: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
};

export type CreateDiscussionInput = {
  title: string;
  body: string;
  moduleId?: string;
  lessonId?: string;
  assignmentId?: string;
  curatorId?: string;
  visibility?: "PRIVATE" | "COHORT";
  sourceUrl?: string;
  attachments?: DiscussionAttachmentInput[];
};

export type CreateDiscussionMessageInput = {
  body: string;
  sourceUrl?: string;
  attachments?: DiscussionAttachmentInput[];
};

const MAX_TITLE_LENGTH = 240;
const MAX_BODY_LENGTH = 10_000;
const MAX_ATTACHMENT_COUNT = 5;
const MAX_ATTACHMENT_NAME_LENGTH = 180;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "application/pdf", "video/mp4", "video/webm"]);

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new AuthServiceError("INVALID_INPUT", `${field} is invalid`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new AuthServiceError("INVALID_INPUT", `${field} is invalid`);
  return normalized;
}

function optionalUrl(value: string | undefined, field = "sourceUrl"): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { throw new AuthServiceError("INVALID_INPUT", `${field} is invalid`); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new AuthServiceError("INVALID_INPUT", `${field} is invalid`);
  return parsed.toString();
}

function normalizeAttachments(values: DiscussionAttachmentInput[] | undefined): DiscussionAttachmentInput[] {
  if (!values) return [];
  if (!Array.isArray(values) || values.length > MAX_ATTACHMENT_COUNT) throw new AuthServiceError("INVALID_INPUT", "attachments are invalid");
  return values.map((attachment) => {
    if (!attachment || typeof attachment !== "object") throw new AuthServiceError("INVALID_INPUT", "attachment is invalid");
    const originalName = requiredText(attachment.originalName, "attachment.originalName", MAX_ATTACHMENT_NAME_LENGTH);
    const mimeType = requiredText(attachment.mimeType, "attachment.mimeType", 100).toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(mimeType)) throw new AuthServiceError("INVALID_INPUT", "attachment.mimeType is not allowed");
    if (!Number.isSafeInteger(attachment.byteSize) || attachment.byteSize < 1 || attachment.byteSize > MAX_ATTACHMENT_SIZE) throw new AuthServiceError("INVALID_INPUT", "attachment.byteSize is invalid");
    const fileId = typeof attachment.fileId === "string" && attachment.fileId.trim() ? attachment.fileId.trim() : undefined;
    return { fileId, sourceUrl: optionalUrl(attachment.sourceUrl), originalName, mimeType, byteSize: attachment.byteSize };
  });
}

function threadInclude() {
  return {
    student: { select: { id: true, email: true, externalIdentities: { select: { displayName: true, username: true, avatarUrl: true, provider: true }, orderBy: { createdAt: "asc" as const } } } },
    curator: { select: { id: true, email: true, externalIdentities: { select: { displayName: true, username: true }, orderBy: { createdAt: "asc" as const }, take: 1 } } },
    module: { select: { id: true, title: true, position: true, coverPath: true } },
    lesson: { select: { id: true, title: true } },
    assignment: { select: { id: true, title: true } },
    messages: {
      orderBy: { createdAt: "asc" as const },
      include: {
        author: { select: { id: true, role: true, email: true, externalIdentities: { select: { displayName: true, username: true }, orderBy: { createdAt: "asc" as const }, take: 1 } } },
        attachments: { orderBy: { createdAt: "asc" as const }, include: { file: { select: { id: true, originalName: true, mimeType: true, byteSize: true, status: true } } } },
      },
    },
  } as const;
}

type DiscussionThreadWithRelations = Prisma.DiscussionThreadGetPayload<{ include: ReturnType<typeof threadInclude> }>;

function personName(person: DiscussionThreadWithRelations["student"] | DiscussionThreadWithRelations["curator"]): string | null {
  if (!person) return null;
  return person.externalIdentities[0]?.displayName ?? person.externalIdentities[0]?.username ?? person.email;
}

// Curators recognize students by face faster than by initials once a cohort grows past a
// handful of people — prefer the Discord avatar (highest-fidelity provider) over whichever
// identity happens to be oldest.
function personAvatarUrl(person: DiscussionThreadWithRelations["student"]): string | null {
  const identities = person.externalIdentities;
  return identities.find((identity) => identity.provider === "DISCORD")?.avatarUrl ?? identities[0]?.avatarUrl ?? null;
}

export class DiscussionService {
  public async create(studentId: string, input: CreateDiscussionInput) {
    await this.assertActiveUser(studentId, UserRole.STUDENT);
    const title = requiredText(input.title, "title", MAX_TITLE_LENGTH);
    const body = requiredText(input.body, "body", MAX_BODY_LENGTH);
    const attachments = normalizeAttachments(input.attachments);
    const sourceUrl = optionalUrl(input.sourceUrl);
    const context = await this.validateContext(studentId, input.moduleId, input.lessonId, input.assignmentId);
    const curatorId = await this.resolveCurator(studentId, input.curatorId);
    await this.assertFilesOwned(studentId, attachments);

    const thread = await prisma.$transaction(async (tx) => {
      const created = await tx.discussionThread.create({
        data: {
          studentId,
          curatorId,
          moduleId: context.moduleId,
          lessonId: context.lessonId,
          assignmentId: context.assignmentId,
          title,
          status: DiscussionStatus.NEW,
          visibility: input.visibility === "COHORT" ? DiscussionVisibility.COHORT : DiscussionVisibility.PRIVATE,
          messages: { create: { authorId: studentId, body, attachments: { create: this.attachmentData(attachments, sourceUrl) } } },
        },
        include: threadInclude(),
      });
      return tx.discussionThread.findUniqueOrThrow({ where: { id: created.id }, include: threadInclude() });
    });
    const curatorEmails = thread.curator?.email ? [thread.curator.email] : [];
    void Promise.all(curatorEmails.map((to) => sendDiscussionNotification({
      to,
      threadTitle: thread.title,
      senderName: personName(thread.student) ?? "Ученик",
      body,
      threadId: thread.id,
    }))).catch((error: unknown) => console.error("Discussion recipient lookup failed", error instanceof Error ? error.message : "unknown error"));
    if (thread.curatorId) {
      void notificationService.create(thread.curatorId, "DISCUSSION_REPLY", `Новый вопрос: ${thread.title}`, body, thread.id)
        .catch((error: unknown) => console.error("Discussion notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
    }
    return this.toDto(thread);
  }

  public async listForStudent(studentId: string) {
    await this.assertActiveUser(studentId, UserRole.STUDENT);
    const threads = await prisma.discussionThread.findMany({ where: { studentId }, orderBy: { lastMessageAt: "desc" }, include: threadInclude() });
    return threads.map((thread) => this.toDto(thread));
  }

  public async listForCurator(curatorId: string) {
    // Every active curator sees every thread — curators are no longer partitioned by
    // which student/thread was routed to them.
    await this.assertCurator(curatorId);
    const threads = await prisma.discussionThread.findMany({ orderBy: { lastMessageAt: "desc" }, include: threadInclude() });
    return threads.map((thread) => this.toDto(thread));
  }

  // Anonymous cross-student "FAQ" feed: once a curator has answered a question, the
  // rest of the cohort can read it (context + curator's real answer) without ever
  // learning who asked or how many other students exist — only the asking student's
  // identity is stripped, not the curator's. ANSWERED and CLOSED both qualify (the
  // asker closing a settled thread shouldn't pull it out of the shared feed), but
  // WAITING doesn't — that means the student replied again and the conversation is
  // back in flux — and the `messages.some` guard keeps out threads a student closed
  // before a curator ever actually answered.
  public async listCohortForStudent(studentId: string) {
    await this.assertActiveUser(studentId, UserRole.STUDENT);
    const enrollment = await prisma.enrollment.findFirst({ where: { studentId, status: "ACTIVE" }, select: { practicumId: true } });
    if (!enrollment) return [];
    const threads = await prisma.discussionThread.findMany({
      where: {
        status: { in: [DiscussionStatus.ANSWERED, DiscussionStatus.CLOSED] },
        studentId: { not: studentId },
        module: { practicumId: enrollment.practicumId },
        messages: { some: { author: { role: { in: [UserRole.CURATOR, UserRole.OWNER] } } } },
      },
      orderBy: { lastMessageAt: "desc" },
      include: threadInclude(),
    });
    return threads.map((thread) => this.toDto(thread, { anonymizeStudent: true }));
  }

  public async reply(actorId: string, threadId: string, input: CreateDiscussionMessageInput) {
    const actor = await this.assertParticipant(actorId, threadId);
    const body = requiredText(input.body, "body", MAX_BODY_LENGTH);
    const attachments = normalizeAttachments(input.attachments);
    const sourceUrl = optionalUrl(input.sourceUrl);
    await this.assertFilesOwned(actorId, attachments);
    const status = actor.role === UserRole.STUDENT ? DiscussionStatus.WAITING : DiscussionStatus.ANSWERED;
    const thread = await prisma.$transaction(async (tx) => {
      await tx.discussionMessage.create({ data: { threadId, authorId: actorId, body, attachments: { create: this.attachmentData(attachments, sourceUrl) } } });
      await tx.discussionThread.update({ where: { id: threadId }, data: { status, lastMessageAt: new Date() } });
      return tx.discussionThread.findUniqueOrThrow({ where: { id: threadId }, include: threadInclude() });
    });
    const recipients = actor.role === UserRole.STUDENT
      ? (thread.curator?.email ? [thread.curator.email] : [])
      : (thread.student.email ? [thread.student.email] : []);
    void Promise.all(recipients.map((to) => sendDiscussionNotification({
      to,
      threadTitle: thread.title,
      senderName: actor.role === UserRole.STUDENT ? personName(thread.student) ?? "Ученик" : personName(thread.curator) ?? "Куратор",
      body,
      threadId: thread.id,
    }))).catch((error: unknown) => console.error("Discussion reply recipient lookup failed", error instanceof Error ? error.message : "unknown error"));
    const recipientId = actor.role === UserRole.STUDENT ? thread.curatorId : thread.studentId;
    if (recipientId) {
      const senderName = actor.role === UserRole.STUDENT ? personName(thread.student) ?? "Ученик" : personName(thread.curator) ?? "Куратор";
      void notificationService.create(recipientId, "DISCUSSION_REPLY", `${senderName}: ${thread.title}`, body, thread.id)
        .catch((error: unknown) => console.error("Discussion reply notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
    }
    return this.toDto(thread);
  }

  public async close(studentId: string, threadId: string) {
    const actor = await this.assertParticipant(studentId, threadId);
    if (actor.role !== UserRole.STUDENT) throw new AuthServiceError("FORBIDDEN", "Only the student can close this discussion");
    const thread = await prisma.$transaction(async (tx) => {
      await tx.discussionThread.update({ where: { id: threadId }, data: { status: DiscussionStatus.CLOSED, lastMessageAt: new Date() } });
      return tx.discussionThread.findUniqueOrThrow({ where: { id: threadId }, include: threadInclude() });
    });
    return this.toDto(thread);
  }

  private attachmentData(attachments: DiscussionAttachmentInput[], sourceUrl?: string) {
    const data = attachments.map((attachment) => ({ fileId: attachment.fileId, sourceUrl: attachment.sourceUrl, originalName: attachment.originalName, mimeType: attachment.mimeType, byteSize: attachment.byteSize }));
    if (sourceUrl) data.push({ fileId: undefined, sourceUrl, originalName: "Ссылка на материал", mimeType: "text/uri-list", byteSize: 0 });
    return data;
  }

  private async validateContext(studentId: string, moduleId?: string, lessonId?: string, assignmentId?: string) {
    const assignment = assignmentId ? await prisma.assignment.findUnique({
      where: { id: assignmentId },
      select: { id: true, lessonId: true, lesson: { select: { moduleId: true, module: { select: { practicumId: true } } } } },
    }) : null;
    const lesson = lessonId ? await prisma.lesson.findUnique({ where: { id: lessonId }, select: { id: true, moduleId: true, module: { select: { practicumId: true } } } }) : null;
    const courseModule = moduleId ? await prisma.module.findUnique({ where: { id: moduleId }, select: { id: true, practicumId: true } }) : null;
    const practicumId = assignment?.lesson.module.practicumId ?? lesson?.module.practicumId ?? courseModule?.practicumId;
    if (assignmentId && !assignment) throw new AuthServiceError("INVALID_INPUT", "assignmentId is invalid");
    if (lessonId && !lesson) throw new AuthServiceError("INVALID_INPUT", "lessonId is invalid");
    if (moduleId && !courseModule) throw new AuthServiceError("INVALID_INPUT", "moduleId is invalid");
    if (assignment && lessonId && assignment.lessonId !== lessonId) throw new AuthServiceError("INVALID_INPUT", "Discussion context is inconsistent");
    if (lesson && moduleId && lesson.moduleId !== moduleId) throw new AuthServiceError("INVALID_INPUT", "Discussion context is inconsistent");
    if (practicumId) {
      const enrollment = await prisma.enrollment.findFirst({ where: { studentId, practicumId, status: "ACTIVE", OR: [{ accessUntil: null }, { accessUntil: { gt: new Date() } }] }, select: { id: true } });
      if (!enrollment) throw new AuthServiceError("FORBIDDEN", "Active enrollment is required");
    }
    return { moduleId: assignment?.lesson.moduleId ?? lesson?.moduleId ?? courseModule?.id, lessonId: assignment?.lessonId ?? lesson?.id, assignmentId: assignment?.id };
  }

  private async validateCurator(studentId: string, curatorId?: string): Promise<string | undefined> {
    if (!curatorId) return undefined;
    const curator = await prisma.user.findUnique({ where: { id: curatorId }, select: { id: true, role: true, status: true } });
    if (!curator || curator.status !== UserStatus.ACTIVE || (curator.role !== UserRole.CURATOR && curator.role !== UserRole.OWNER)) throw new AuthServiceError("INVALID_INPUT", "curatorId is invalid");
    return curator.id;
  }

  private async resolveCurator(studentId: string, curatorId?: string): Promise<string | undefined> {
    if (curatorId) return this.validateCurator(studentId, curatorId);
    const assignment = await prisma.curatorAssignment.findFirst({
      where: { studentId },
      orderBy: { createdAt: "asc" },
      select: { curatorId: true },
    });
    return assignment?.curatorId;
  }

  private async assertFilesOwned(ownerId: string, attachments: DiscussionAttachmentInput[]) {
    const fileIds = attachments.flatMap((attachment) => attachment.fileId ? [attachment.fileId] : []);
    if (fileIds.length === 0) return;
    const files = await prisma.storedFile.findMany({ where: { id: { in: fileIds }, ownerId, status: StoredFileStatus.UPLOADED }, select: { id: true } });
    if (files.length !== new Set(fileIds).size) throw new AuthServiceError("FORBIDDEN", "Attachment ownership is invalid");
  }

  private async assertParticipant(actorId: string, threadId: string) {
    const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { id: true, role: true, status: true } });
    const thread = await prisma.discussionThread.findUnique({ where: { id: threadId }, select: { studentId: true, curatorId: true, status: true } });
    if (!actor || actor.status !== UserStatus.ACTIVE || !thread) throw new AuthServiceError("FORBIDDEN", "Discussion access is not allowed");
    // Any active curator can view/reply to any thread — curators are no longer restricted
    // to only the threads routed to them (thread.curatorId is still recorded, just used as
    // the default addressee shown to the student, not an access gate).
    const allowed = (actor.role === UserRole.STUDENT && thread.studentId === actorId)
      || actor.role === UserRole.OWNER
      || actor.role === UserRole.CURATOR;
    if (allowed && thread.status === DiscussionStatus.CLOSED) throw new AuthServiceError("FORBIDDEN", "Discussion is closed");
    if (allowed) return actor;
    throw new AuthServiceError("FORBIDDEN", "Discussion access is not allowed");
  }

  private async assertCurator(userId: string) {
    const actor = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, status: true } });
    if (!actor || actor.status !== UserStatus.ACTIVE || (actor.role !== UserRole.CURATOR && actor.role !== UserRole.OWNER)) throw new AuthServiceError("FORBIDDEN", "Curator access required");
    return actor;
  }

  private async assertActiveUser(userId: string, role: UserRole) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
    if (!user || user.status !== UserStatus.ACTIVE || user.role !== role) throw new AuthServiceError("FORBIDDEN", "Student access required");
  }

  private toDto(thread: DiscussionThreadWithRelations, options: { anonymizeStudent?: boolean } = {}) {
    const anonymizeStudent = options.anonymizeStudent ?? false;
    return {
      id: thread.id,
      title: thread.title,
      status: thread.status,
      visibility: thread.visibility,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      lastMessageAt: thread.lastMessageAt,
      module: thread.module ? { id: thread.module.id, title: thread.module.title, position: thread.module.position, coverPath: thread.module.coverPath } : null,
      lesson: thread.lesson ? { id: thread.lesson.id, title: thread.lesson.title } : null,
      assignment: thread.assignment ? { id: thread.assignment.id, title: thread.assignment.title } : null,
      student: anonymizeStudent
        ? { id: null, name: "Ученик потока", email: null, avatarUrl: null }
        : { id: thread.student.id, name: personName(thread.student), email: thread.student.email, avatarUrl: personAvatarUrl(thread.student) },
      curator: thread.curator ? { id: thread.curator.id, name: personName(thread.curator), email: thread.curator.email } : null,
      messages: thread.messages.map((message) => {
        const isStudentAuthor = message.author.role === UserRole.STUDENT;
        return {
          id: message.id,
          authorId: anonymizeStudent && isStudentAuthor ? null : message.authorId,
          authorRole: message.author.role,
          authorName: anonymizeStudent && isStudentAuthor ? "Ученик потока" : personName(message.author),
          body: message.body,
          createdAt: message.createdAt,
          attachments: message.attachments.map((attachment) => ({
            id: attachment.id,
            originalName: attachment.originalName,
            mimeType: attachment.mimeType,
            byteSize: attachment.byteSize,
            sourceUrl: attachment.sourceUrl,
            fileId: attachment.file?.status === StoredFileStatus.UPLOADED ? attachment.file.id : null,
            contentUrl: attachment.file?.status === StoredFileStatus.UPLOADED ? `/api/files/${attachment.file.id}/content` : null,
          })),
        };
      }),
    };
  }
}

export const discussionService = new DiscussionService();
