import { Prisma } from "@/app/generated/prisma/client";
import { DiscussionStatus, DiscussionVisibility, StoredFileStatus, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { AuthServiceError } from "@/app/server/auth";
import { getStudentActivePracticum } from "@/app/server/course/practicum-service";
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
const MAX_ATTACHMENT_COUNT = 20;
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
    student: { select: { id: true, email: true, isAdvanced: true, externalIdentities: { select: { displayName: true, username: true, avatarUrl: true, provider: true }, orderBy: { createdAt: "asc" as const } } } },
    curator: { select: { id: true, email: true, externalIdentities: { select: { displayName: true, username: true }, orderBy: { createdAt: "asc" as const }, take: 1 } } },
    module: { select: { id: true, title: true, position: true, coverPath: true } },
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

function personName(person: { email: string | null; externalIdentities: Array<{ displayName: string | null; username: string | null }> } | null | undefined): string | null {
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
    if ((await getStudentActivePracticum(studentId))?.completedAt) throw new AuthServiceError("INVALID_INPUT", "Практикум завершён — новые вопросы уже не задать.");
    const title = requiredText(input.title, "title", MAX_TITLE_LENGTH);
    const body = requiredText(input.body, "body", MAX_BODY_LENGTH);
    const attachments = normalizeAttachments(input.attachments);
    const sourceUrl = optionalUrl(input.sourceUrl);
    const context = await this.validateContext(studentId, input.moduleId, input.assignmentId);
    const curatorId = await this.resolveCurator(studentId, input.curatorId);
    await this.assertFilesOwned(studentId, attachments);

    const thread = await prisma.$transaction(async (tx) => {
      const created = await tx.discussionThread.create({
        data: {
          studentId,
          curatorId,
          moduleId: context.moduleId,
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
    const staff = await this.staffRecipients(thread.curatorId ?? undefined);
    // "Новый вопрос" — a curator's own email opt-out (see notification-service.ts#updateEmailPreferences)
    // only applies to a brand-new thread, not the reply path below, which stays on the recipient's
    // provider/email presence alone — a curator already following an existing conversation.
    void Promise.all(staff.flatMap((recipient) => recipient.email && recipient.notifyNewQuestion ? [sendDiscussionNotification({
      to: recipient.email,
      threadTitle: thread.title,
      senderName: personName(thread.student) ?? "Ученик",
      body,
      threadId: thread.id,
    })] : [])).catch((error: unknown) => console.error("Discussion recipient lookup failed", error instanceof Error ? error.message : "unknown error"));
    void Promise.all(staff.map((recipient) => notificationService.create(recipient.id, "DISCUSSION_REPLY", `Новый вопрос: ${thread.title}`, body, thread.id)))
      .catch((error: unknown) => console.error("Discussion notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
    return this.toDto(thread);
  }

  public async listForStudent(studentId: string) {
    await this.assertActiveUser(studentId, UserRole.STUDENT);
    const [threads, activePracticum] = await Promise.all([
      prisma.discussionThread.findMany({ where: { studentId }, orderBy: { lastMessageAt: "desc" }, include: threadInclude() }),
      getStudentActivePracticum(studentId),
    ]);
    const practicumCompleted = Boolean(activePracticum?.completedAt);
    return threads.map((thread) => this.toDto(thread, { practicumCompleted }));
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
  // before a curator ever actually answered. Only threads the student agreed to share (COHORT —
  // the "Можно показать другим ученикам анонимно" box) — it used to ignore visibility, so a
  // student had no way to keep a personal question out of it (security review STG-1, 2026-10-17).
  public async listCohortForStudent(studentId: string) {
    await this.assertActiveUser(studentId, UserRole.STUDENT);
    const enrollment = await prisma.enrollment.findFirst({ where: { studentId, status: "ACTIVE" }, select: { practicumId: true } });
    if (!enrollment) return [];
    const threads = await prisma.discussionThread.findMany({
      where: {
        status: { in: [DiscussionStatus.ANSWERED, DiscussionStatus.CLOSED] },
        visibility: DiscussionVisibility.COHORT,
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
    // Only the student side goes read-only — any active curator can still reply/close out a
    // thread in a completed practicum (see practicum-service.ts#isPracticumCompleted).
    if (actor.role === UserRole.STUDENT && (await getStudentActivePracticum(actorId))?.completedAt) {
      throw new AuthServiceError("INVALID_INPUT", "Практикум завершён — писать в обсуждении уже нельзя.");
    }
    const attachments = normalizeAttachments(input.attachments);
    // A follow-up can be just a screenshot (2026-10-04: students couldn't attach anything after
    // the first question) — text is required only when nothing is attached.
    const body = attachments.length > 0 && typeof input.body === "string" && !input.body.trim() ? "" : requiredText(input.body, "body", MAX_BODY_LENGTH);
    const notificationBody = body || `Вложений: ${attachments.length}`;
    const sourceUrl = optionalUrl(input.sourceUrl);
    await this.assertFilesOwned(actorId, attachments);
    const status = actor.role === UserRole.STUDENT ? DiscussionStatus.WAITING : DiscussionStatus.ANSWERED;
    const thread = await prisma.$transaction(async (tx) => {
      await tx.discussionMessage.create({ data: { threadId, authorId: actorId, body, attachments: { create: this.attachmentData(attachments, sourceUrl) } } });
      await tx.discussionThread.update({ where: { id: threadId }, data: { status, lastMessageAt: new Date() } });
      return tx.discussionThread.findUniqueOrThrow({ where: { id: threadId }, include: threadInclude() });
    });
    // The actual person who just wrote this reply — not thread.curator, which is only the
    // thread's default addressee and can be a completely different curator (any active curator
    // can reply to any thread, see assertParticipant). Using thread.curator here previously
    // attributed the email to whoever the thread happened to be addressed to instead of whoever
    // actually replied.
    const senderName = personName(actor) ?? (actor.role === UserRole.STUDENT ? "Ученик" : "Куратор");
    const recipients = actor.role === UserRole.STUDENT
      ? await this.staffRecipients(thread.curatorId ?? undefined)
      : (thread.student.email ? [{ id: thread.studentId, email: thread.student.email }] : []);
    void Promise.all(recipients.flatMap((recipient) => recipient.email ? [sendDiscussionNotification({
      to: recipient.email,
      threadTitle: thread.title,
      senderName,
      body: notificationBody,
      threadId: thread.id,
    })] : [])).catch((error: unknown) => console.error("Discussion reply recipient lookup failed", error instanceof Error ? error.message : "unknown error"));
    void Promise.all(recipients.map((recipient) => notificationService.create(recipient.id, "DISCUSSION_REPLY", `${senderName}: ${thread.title}`, notificationBody, thread.id)))
      .catch((error: unknown) => console.error("Discussion reply notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
    // Known false when the replier is the student (the check above already threw otherwise);
    // resolved properly for a curator reply, whose own practicum status wasn't checked.
    const practicumCompleted = actor.role === UserRole.STUDENT ? false : Boolean((await getStudentActivePracticum(thread.studentId))?.completedAt);
    return this.toDto(thread, { practicumCompleted });
  }

  /**
   * Curator "Ответ не нужен" — the student only wrote "спасибо", nothing to answer (2026-10-06).
   * Marks the thread answered without posting a message or notifying anyone; the student can
   * still write again, which makes it WAITING as usual. Closing stays the student's own action.
   */
  public async markAnswered(actorId: string, threadId: string) {
    const actor = await this.assertParticipant(actorId, threadId);
    if (actor.role === UserRole.STUDENT) throw new AuthServiceError("FORBIDDEN", "Only staff can mark a discussion as answered");
    const thread = await prisma.discussionThread.update({ where: { id: threadId }, data: { status: DiscussionStatus.ANSWERED }, include: threadInclude() });
    const practicumCompleted = Boolean((await getStudentActivePracticum(thread.studentId))?.completedAt);
    return this.toDto(thread, { practicumCompleted });
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

  private async validateContext(studentId: string, moduleId?: string, assignmentId?: string) {
    const assignment = assignmentId ? await prisma.assignment.findUnique({
      where: { id: assignmentId },
      select: { id: true, moduleId: true, practicumId: true },
    }) : null;
    const courseModule = moduleId ? await prisma.module.findUnique({ where: { id: moduleId }, select: { id: true, practicumId: true } }) : null;
    const practicumId = assignment?.practicumId ?? courseModule?.practicumId;
    if (assignmentId && !assignment) throw new AuthServiceError("INVALID_INPUT", "assignmentId is invalid");
    if (moduleId && !courseModule) throw new AuthServiceError("INVALID_INPUT", "moduleId is invalid");
    if (assignment && moduleId && assignment.moduleId !== moduleId) throw new AuthServiceError("INVALID_INPUT", "Discussion context is inconsistent");
    if (practicumId) {
      const enrollment = await prisma.enrollment.findFirst({ where: { studentId, practicumId, status: "ACTIVE", OR: [{ accessUntil: null }, { accessUntil: { gt: new Date() } }] }, select: { id: true } });
      if (!enrollment) throw new AuthServiceError("FORBIDDEN", "Active enrollment is required");
    }
    return { moduleId: assignment?.moduleId ?? courseModule?.id, assignmentId: assignment?.id };
  }

  private async validateCurator(studentId: string, curatorId?: string): Promise<string | undefined> {
    if (!curatorId) return undefined;
    const curator = await prisma.user.findUnique({ where: { id: curatorId }, select: { id: true, role: true, status: true } });
    if (!curator || curator.status !== UserStatus.ACTIVE || (curator.role !== UserRole.CURATOR && curator.role !== UserRole.OWNER)) throw new AuthServiceError("INVALID_INPUT", "curatorId is invalid");
    return curator.id;
  }

  private async resolveCurator(studentId: string, curatorId?: string): Promise<string | undefined> {
    if (curatorId) return this.validateCurator(studentId, curatorId);
    return undefined;
  }

  // Students never pick a specific curatorId today (no picker in the UI), so this is who
  // actually hears about a new question/reply: the one explicitly-addressed curator if the
  // thread has one, otherwise every active curator/owner — matches assertParticipant's "any
  // active curator can view/reply to any thread", so nobody is silently left unnotified just
  // because a thread was never addressed to a specific person.
  private async staffRecipients(explicitCuratorId?: string): Promise<Array<{ id: string; email: string | null; notifyNewQuestion: boolean }>> {
    if (explicitCuratorId) {
      const curator = await prisma.user.findUnique({ where: { id: explicitCuratorId }, select: { id: true, email: true, notifyNewQuestion: true } });
      return curator ? [curator] : [];
    }
    return prisma.user.findMany({
      where: { role: { in: [UserRole.CURATOR, UserRole.OWNER] }, status: UserStatus.ACTIVE },
      select: { id: true, email: true, notifyNewQuestion: true },
    });
  }

  private async assertFilesOwned(ownerId: string, attachments: DiscussionAttachmentInput[]) {
    const fileIds = attachments.flatMap((attachment) => attachment.fileId ? [attachment.fileId] : []);
    if (fileIds.length === 0) return;
    const files = await prisma.storedFile.findMany({ where: { id: { in: fileIds }, ownerId, status: StoredFileStatus.UPLOADED }, select: { id: true } });
    if (files.length !== new Set(fileIds).size) throw new AuthServiceError("FORBIDDEN", "Attachment ownership is invalid");
  }

  private async assertParticipant(actorId: string, threadId: string) {
    const actor = await prisma.user.findUnique({
      where: { id: actorId },
      select: { id: true, role: true, status: true, email: true, externalIdentities: { select: { displayName: true, username: true }, orderBy: { createdAt: "asc" }, take: 1 } },
    });
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

  private toDto(thread: DiscussionThreadWithRelations, options: { anonymizeStudent?: boolean; practicumCompleted?: boolean } = {}) {
    const anonymizeStudent = options.anonymizeStudent ?? false;
    return {
      id: thread.id,
      title: thread.title,
      status: thread.status,
      // "Завершить поток" — read access to the thread's history is untouched; the reply/ask-a-
      // question box just hides behind this. See practicum-service.ts#isPracticumCompleted.
      practicumCompleted: options.practicumCompleted ?? false,
      visibility: thread.visibility,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      lastMessageAt: thread.lastMessageAt,
      module: thread.module ? { id: thread.module.id, title: thread.module.title, position: thread.module.position, coverPath: thread.module.coverPath } : null,
      assignment: thread.assignment ? { id: thread.assignment.id, title: thread.assignment.title } : null,
      student: anonymizeStudent
        ? { id: null, name: "Ученик потока", email: null, avatarUrl: null, isAdvanced: false }
        : { id: thread.student.id, name: personName(thread.student), email: thread.student.email, avatarUrl: personAvatarUrl(thread.student), isAdvanced: thread.student.isAdvanced },
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
