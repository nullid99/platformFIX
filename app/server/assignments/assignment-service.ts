import { Prisma } from "@/app/generated/prisma/client";
import {
  AssignmentStatus,
  DiscussionStatus,
  EnrollmentStatus,
  ModuleAccessStatus,
  StoredFileStatus,
  SubmissionStatus,
  UserRole,
  UserStatus,
} from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { AuthServiceError } from "@/app/server/auth";
import { assignmentPrerequisiteGate, isModuleOpenForStudent, seedOpenModuleAccess } from "@/app/server/course/module-access";
import { courseService } from "@/app/server/course/course-service";
import { getWorkingPracticumId, isPracticumCompleted } from "@/app/server/course/practicum-service";
import { sendNewAssignmentNotification, sendNewSubmissionNotification, sendReviewNotification } from "@/app/server/notifications/email-service";
import { activeStudentEmails, activeStudentIds } from "@/app/server/notifications/recipient-service";
import { notificationService } from "@/app/server/notifications/notification-service";
import { nextSubmissionStatus } from "./assignment-transition";

type AssignmentMaterialInput =
  | { kind: "LINK"; title: string; url: string }
  | { kind: "FILE"; title: string; fileId: string };

type AssignmentInput = {
  moduleId?: string;
  // Практическое задание: no lesson, no deadline, no requirements — see the type comment on
  // Assignment.isPractice in schema.prisma for the full picture.
  isPractice?: boolean;
  title: string;
  description: string;
  deadline?: string;
  requirements: string[];
  allowedFormats: string[];
  materials?: AssignmentMaterialInput[];
  // "ДЗ без проверки" — see Assignment.reviewRequired in schema.prisma. Ignored for a practice
  // assignment (never goes through this Submission-based flow either way).
  reviewRequired?: boolean;
};

type SubmissionInput = {
  answerText?: string;
  attachments?: Array<{ name: string; type: string; size: number }>;
  fileIds?: string[];
};

type FeedbackAttachmentInput = {
  fileId: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
};

type AssignmentWithRelations = Prisma.AssignmentGetPayload<{
  include: {
    module: { select: { title: true; position: true; coverPath: true } };
    submissions: { include: { feedback: { select: { id: true, text: true, createdAt: true, attachments: { orderBy: { createdAt: "asc" }, select: { id: true, originalName: true, mimeType: true, byteSize: true, fileId: true, file: { select: { status: true } } } } } }, fileAttachments: { include: { file: { select: { id: true, originalName: true, mimeType: true, byteSize: true } } } } } };
    materials: { orderBy: { position: "asc" } };
  };
}>;

type StudentHistoryFile = { id: string; originalName: string; mimeType: string; byteSize: number };
type StudentHistoryFeedbackAttachment = { id: string; originalName: string; mimeType: string; byteSize: number; url: string };
type StudentHistoryFeedback = { id: string; text: string; createdAt: Date; attachments: StudentHistoryFeedbackAttachment[] };
type StudentHistoryAttempt = {
  id: string;
  attempt: number;
  status: SubmissionStatus;
  answerText: string | null;
  submittedAt: Date | null;
  createdAt: Date;
  feedback: StudentHistoryFeedback[];
  files: StudentHistoryFile[];
};
type StudentHistoryGroup = StudentHistoryAttempt & {
  assignmentId: string;
  title: string;
  module: string;
  attempts: StudentHistoryAttempt[];
};

type QueueAttempt = {
  attempt: number;
  status: SubmissionStatus;
  submittedAt: Date | null;
  answerText: string | null;
  fileAttachments: Array<{ file: { id: string; originalName: string; mimeType: string; byteSize: number } }>;
  feedback: readonly { id: string; text: string; createdAt: Date; attachments: readonly { id: string; originalName: string; mimeType: string; byteSize: number; fileId: string; file: { status: StoredFileStatus } | null }[] }[];
};

const MAX_TEXT_LENGTH = 10_000;
const MAX_REQUIREMENTS = 20;
const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_NAME_LENGTH = 255;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

function requiredText(value: string, field: string, maxLength = 500): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new AuthServiceError("INVALID_INPUT", `${field} is invalid`);
  }
  return normalized;
}

function optionalText(value: string | undefined, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function parseDate(value: string | undefined): Date | undefined {
  const normalized = optionalText(value, 30);
  if (!normalized) return undefined;
  const date = new Date(`${normalized}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new AuthServiceError("INVALID_INPUT", "deadline is invalid");
  }
  return date;
}

function normalizeRequirements(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_REQUIREMENTS) {
    throw new AuthServiceError("INVALID_INPUT", "requirements are invalid");
  }
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.slice(0, 500));
}

function normalizeFormats(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > 10) {
    throw new AuthServiceError("INVALID_INPUT", "allowedFormats are invalid");
  }
  const allowed = new Set(["comment", "image", "video"]);
  return [...new Set(values.filter((value): value is string => allowed.has(value)))];
}

function normalizeMaterials(values: AssignmentInput["materials"]): NonNullable<AssignmentInput["materials"]> {
  if (!values) return [];
  if (!Array.isArray(values) || values.length > 5) throw new AuthServiceError("INVALID_INPUT", "materials are invalid");
  return values.map((material, index) => {
    if (!material || (material.kind !== "LINK" && material.kind !== "FILE")) throw new AuthServiceError("INVALID_INPUT", "material kind is invalid");
    const title = requiredText(material.title, `materials[${index}].title`, 180);
    if (material.kind === "LINK") {
      if (typeof material.url !== "string") throw new AuthServiceError("INVALID_INPUT", "material url is invalid");
      let parsed: URL;
      try { parsed = new URL(material.url); } catch { throw new AuthServiceError("INVALID_INPUT", "material url is invalid"); }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new AuthServiceError("INVALID_INPUT", "material url is invalid");
      return { kind: "LINK" as const, title, url: parsed.toString() };
    }
    if (typeof material.fileId !== "string" || !material.fileId.trim()) throw new AuthServiceError("INVALID_INPUT", "material file is invalid");
    return { kind: "FILE" as const, title, fileId: material.fileId.trim() };
  });
}

function normalizeAttachments(values: SubmissionInput["attachments"]): Array<{ name: string; type: string; size: number }> {
  if (!values) return [];
  if (!Array.isArray(values) || values.length > MAX_ATTACHMENT_COUNT) {
    throw new AuthServiceError("INVALID_INPUT", "attachments are invalid");
  }
  return values.map((attachment) => {
    const candidate = attachment as Partial<{ name: string; type: string; size: number }>;
    if (typeof candidate.name !== "string" || typeof candidate.type !== "string") {
      throw new AuthServiceError("INVALID_INPUT", "attachment metadata is invalid");
    }
    const name = requiredText(candidate.name, "attachment.name", MAX_ATTACHMENT_NAME_LENGTH);
    const type = requiredText(candidate.type, "attachment.type", 100);
    const size = candidate.size;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0 || size > MAX_ATTACHMENT_SIZE) {
      throw new AuthServiceError("INVALID_INPUT", "attachment.size is invalid");
    }
    return { name, type, size };
  });
}

function normalizeFileIds(values: SubmissionInput["fileIds"]): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new AuthServiceError("INVALID_INPUT", "fileIds are invalid");
  }
  const unique = [...new Set(values.map((value) => value.trim()))];
  if (unique.length > 5) throw new AuthServiceError("INVALID_INPUT", "Too many files");
  return unique;
}

function getRequirements(value: Prisma.JsonValue | null): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function getAttachments(value: Prisma.JsonValue | null): Array<{ name: string; type: string; size: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.type !== "string" || typeof record.size !== "number") return [];
    return [{ name: record.name, type: record.type, size: record.size }];
  });
}

function mapFeedback(feedback: readonly { id: string; text: string; createdAt: Date; attachments: readonly { id: string; originalName: string; mimeType: string; byteSize: number; fileId: string; file: { status: StoredFileStatus } | null }[] }[]): StudentHistoryFeedback[] {
  return feedback.map((item) => ({
    id: item.id,
    text: item.text,
    createdAt: item.createdAt,
    attachments: item.attachments
      .filter((attachment) => attachment.file?.status === StoredFileStatus.UPLOADED)
      .map((attachment) => ({ id: attachment.id, originalName: attachment.originalName, mimeType: attachment.mimeType, byteSize: attachment.byteSize, url: `/api/files/${attachment.fileId}/content` })),
  }));
}

function formatDate(date: Date | null): string {
  if (!date) return "Срок не указан";
  return `Срок: ${new Intl.DateTimeFormat("ru-RU").format(date)}`;
}

function assignmentStatusFromSubmission(status: SubmissionStatus | undefined): "На проверке" | "Нужна доработка" | "Не начато" | "Принято" {
  if (status === SubmissionStatus.ACCEPTED) return "Принято";
  if (status === SubmissionStatus.NEEDS_REVISION) return "Нужна доработка";
  if (status === SubmissionStatus.SUBMITTED || status === SubmissionStatus.IN_REVIEW) return "На проверке";
  return "Не начато";
}

// No thread yet → nothing sent. NEW/WAITING → it's with the curator (student is waiting on a
// reply, same as "На проверке" for a regular ДЗ). ANSWERED → the curator just replied, so it's
// the student's turn again — shown as "Принято" (student replies → "На проверке", curator
// replies → "Принято"; practice work deliberately has no "нужна доработка"/revision cycle, see
// the feature's design, so that status never applies here). CLOSED only ever happens by the
// student's own hand (see DiscussionService#close — a curator can't close a thread), so it lands
// on the same "Принято" state rather than a distinct one nothing in the UI can trigger anyway.
function practiceStatusFromDiscussion(status: DiscussionStatus | undefined): ReturnType<typeof assignmentStatusFromSubmission> {
  if (status === DiscussionStatus.CLOSED || status === DiscussionStatus.ANSWERED) return "Принято";
  if (status === DiscussionStatus.NEW || status === DiscussionStatus.WAITING) return "На проверке";
  return "Не начато";
}

function toneFromStatus(status: ReturnType<typeof assignmentStatusFromSubmission>): "blue" | "amber" | "gray" {
  if (status === "Нужна доработка") return "amber";
  if (status === "Не начато") return "gray";
  return "blue";
}

// "Мои задания" ordering for a student: whatever still needs their attention first (a
// resubmission is more urgent than a first attempt), then in lesson order so it reads as a
// to-do list instead of a feed sorted by whenever the curator happened to publish each one —
// previously createdAt desc could put a far-later, not-yet-started lesson's ДЗ above one the
// student had already submitted that same day.
const ASSIGNMENT_STATUS_PRIORITY: Record<ReturnType<typeof assignmentStatusFromSubmission>, number> = {
  "Нужна доработка": 0,
  "Не начато": 1,
  "На проверке": 2,
  "Принято": 3,
};

function latestSubmission<T extends { attempt: number }>(submissions: readonly T[]): T | undefined {
  return [...submissions].sort((left, right) => right.attempt - left.attempt)[0];
}

export class AssignmentService {
  public async listForStudent(studentId: string) {
    await this.assertActiveUser(studentId, UserRole.STUDENT);
    const enrollments = await prisma.enrollment.findMany({
      where: { studentId, status: EnrollmentStatus.ACTIVE, OR: [{ accessUntil: null }, { accessUntil: { gt: new Date() } }] },
      select: { practicumId: true },
    });
    const enrolledPracticumIds = enrollments.map((enrollment) => enrollment.practicumId);
    // "Завершить поток" — completed practicums still fully populate this list (read access is
    // untouched); toStudentDto just stamps practicumCompleted on each row so the submission
    // form/"Выполнено" button can hide themselves. A student is normally enrolled in exactly one
    // active practicum, but this stays a map rather than a single lookup for the (rare,
    // historically buggy — see the double-enrollment fix) case where they're in more than one.
    const practicumCompletionById = new Map(
      (await prisma.practicum.findMany({ where: { id: { in: enrolledPracticumIds } }, select: { id: true, completedAt: true } }))
        .map((practicum) => [practicum.id, Boolean(practicum.completedAt)] as const),
    );
    const assignments = await prisma.assignment.findMany({
      where: {
        status: AssignmentStatus.PUBLISHED,
        // A regular assignment is still module-gated below; a practice assignment has no module
        // to gate on, so eligibility is just "enrolled and active in the targeted practicum."
        OR: [{ isPractice: false }, { isPractice: true, practicumId: { in: enrolledPracticumIds } }],
      },
      orderBy: { createdAt: "desc" },
      include: {
        module: { select: { title: true, position: true, coverPath: true, practicumId: true } },
        submissions: {
          where: { studentId },
          orderBy: { attempt: "desc" },
          include: {
            feedback: { orderBy: { createdAt: "asc" }, select: { id: true, text: true, createdAt: true, attachments: { orderBy: { createdAt: "asc" }, select: { id: true, originalName: true, mimeType: true, byteSize: true, fileId: true, file: { select: { status: true } } } } } },
            fileAttachments: { orderBy: { position: "asc" }, include: { file: { select: { id: true, originalName: true, mimeType: true, byteSize: true } } } },
          },
        },
        materials: { orderBy: { position: "asc" } },
      },
    });
    const regularAssignments = assignments.filter((assignment) => !assignment.isPractice);
    const practiceAssignments = assignments.filter((assignment) => assignment.isPractice);

    // A module can hold several assignments (or a stream, or nothing) — completion is a
    // curator's explicit call (markModuleCompletedForStudent), so each assignment still
    // needs its own gate check against the module before it, not just "is the module open."
    const gateCache = new Map<string, string | null>();
    const openCache = new Map<string, boolean>();
    const orderedAssignments = [...regularAssignments].sort((left, right) => {
      const leftStatus = assignmentStatusFromSubmission(latestSubmission(left.submissions)?.status);
      const rightStatus = assignmentStatusFromSubmission(latestSubmission(right.submissions)?.status);
      const priorityDiff = ASSIGNMENT_STATUS_PRIORITY[leftStatus] - ASSIGNMENT_STATUS_PRIORITY[rightStatus];
      return priorityDiff !== 0 ? priorityDiff : left.module!.position - right.module!.position;
    });
    const regularResults = await Promise.all(orderedAssignments.map(async (assignment) => {
      if (!openCache.has(assignment.moduleId!)) {
        openCache.set(assignment.moduleId!, await isModuleOpenForStudent(prisma, studentId, assignment.module!.practicumId, assignment.moduleId!));
      }
      if (!openCache.get(assignment.moduleId!)) return null;
      const cacheKey = `${assignment.module!.practicumId}:${assignment.module!.position}`;
      if (!gateCache.has(cacheKey)) {
        gateCache.set(cacheKey, await assignmentPrerequisiteGate(prisma, studentId, assignment.module!.practicumId, assignment.module!.position));
      }
      return this.toStudentDto(assignment, gateCache.get(cacheKey) ?? null, undefined, undefined, practicumCompletionById.get(assignment.module!.practicumId) ?? false);
    }));

    const practiceResults = await this.attachDiscussionStatus(studentId, practiceAssignments, practicumCompletionById);
    // Theory (already ordered by priority/module position) then practice (recency order,
    // see attachDiscussionStatus) is the right relative order for everything still active —
    // but "Принято" (done, either kind) still needs to sink below all of that, not just below
    // the theory ones. A stable sort on "is this Принято" alone moves only the accepted items
    // down, without disturbing the two groups' own already-correct internal order.
    const combined = [...regularResults.filter((item): item is NonNullable<typeof item> => item !== null), ...practiceResults];
    return combined.sort((left, right) => Number(left.status === "Принято") - Number(right.status === "Принято"));
  }

  // Most-recently-created first (already the query's orderBy) — there's no module position or
  // Submission-derived status to sort by, unlike the regular-assignment gate loop above.
  private async attachDiscussionStatus(studentId: string, assignments: readonly AssignmentWithRelations[], practicumCompletionById: ReadonlyMap<string, boolean>) {
    if (assignments.length === 0) return [];
    const threads = await prisma.discussionThread.findMany({
      where: { studentId, assignmentId: { in: assignments.map((assignment) => assignment.id) } },
      orderBy: { lastMessageAt: "desc" },
      select: {
        assignmentId: true,
        status: true,
        // Surfaced on the assignment card itself so a status change (e.g. "Принято" after the
        // curator replies) doesn't leave the student wondering what was actually said without
        // clicking through into the discussion thread separately.
        messages: { orderBy: { createdAt: "desc" }, take: 1, select: { body: true, authorId: true, createdAt: true } },
      },
    });
    const statusByAssignment = new Map<string, DiscussionStatus>();
    const lastMessageByAssignment = new Map<string, { text: string; fromCurator: boolean; createdAt: Date }>();
    for (const thread of threads) {
      if (!thread.assignmentId) continue;
      if (!statusByAssignment.has(thread.assignmentId)) statusByAssignment.set(thread.assignmentId, thread.status);
      const latestMessage = thread.messages[0];
      if (latestMessage && !lastMessageByAssignment.has(thread.assignmentId)) {
        lastMessageByAssignment.set(thread.assignmentId, { text: latestMessage.body, fromCurator: latestMessage.authorId !== studentId, createdAt: latestMessage.createdAt });
      }
    }
    return assignments.map((assignment) => this.toStudentDto(assignment, null, statusByAssignment.get(assignment.id), lastMessageByAssignment.get(assignment.id) ?? null, practicumCompletionById.get(assignment.practicumId) ?? false));
  }

  public async listForCurator(actorId: string) {
    await this.assertCurator(actorId);
    const assignments = await prisma.assignment.findMany({
      where: { status: { not: AssignmentStatus.ARCHIVED } },
      orderBy: { createdAt: "desc" },
      include: {
        module: { select: { title: true, position: true, coverPath: true } },
        submissions: {
          include: {
            feedback: { orderBy: { createdAt: "asc" }, select: { id: true, text: true, createdAt: true, attachments: { orderBy: { createdAt: "asc" }, select: { id: true, originalName: true, mimeType: true, byteSize: true, fileId: true, file: { select: { status: true } } } } } },
            fileAttachments: { orderBy: { position: "asc" }, include: { file: { select: { id: true, originalName: true, mimeType: true, byteSize: true } } } },
          },
        },
        materials: { orderBy: { position: "asc" } },
      },
    });
    return assignments.map((assignment) => ({
      ...this.toStudentDto(assignment),
      publicationStatus: assignment.status,
    }));
  }

  public async create(actorId: string, input: AssignmentInput) {
    await this.assertCurator(actorId);
    const normalized = this.normalizeAssignmentInput(input);

    const assignment = await prisma.$transaction(async (tx) => {
      let practicumId: string;
      let moduleId: string | null = null;
      if (normalized.isPractice) {
        practicumId = (await getWorkingPracticumId(actorId)) ?? "";
        if (!practicumId) throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");
      } else {
        const courseModule = await tx.module.findUnique({ where: { id: normalized.moduleId }, select: { id: true, practicumId: true } });
        if (!courseModule) throw new AuthServiceError("INVALID_INPUT", "Module does not exist");
        practicumId = courseModule.practicumId;
        moduleId = courseModule.id;
      }
      const practicum = await tx.practicum.findUnique({ where: { id: practicumId } });
      if (!practicum) throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");
      const created = await tx.assignment.create({
        data: {
          moduleId,
          practicumId: practicum.id,
          isPractice: normalized.isPractice,
          title: normalized.title,
          description: normalized.description,
          requirements: normalized.requirements as Prisma.InputJsonValue,
          allowedFormats: normalized.allowedFormats as Prisma.InputJsonValue,
          deadline: normalized.deadline,
          status: AssignmentStatus.PUBLISHED,
          reviewRequired: normalized.reviewRequired,
        },
      });

      const fileMaterials = normalized.materials.filter((material) => material.kind === "FILE");
      const fileMetadata = new Map<string, { mimeType: string; byteSize: number }>();
      if (fileMaterials.length > 0) {
        const files = await tx.storedFile.findMany({ where: { id: { in: fileMaterials.map((material) => material.fileId) }, ownerId: actorId, status: StoredFileStatus.UPLOADED }, select: { id: true, originalName: true, mimeType: true, byteSize: true } });
        if (files.length !== fileMaterials.length) throw new AuthServiceError("FORBIDDEN", "Material file ownership is invalid");
        files.forEach((file) => fileMetadata.set(file.id, { mimeType: file.mimeType, byteSize: file.byteSize }));
      }
      if (normalized.materials.length > 0) {
        await tx.assignmentMaterial.createMany({ data: normalized.materials.map((material, materialIndex) => {
          return material.kind === "FILE"
            ? { assignmentId: created.id, kind: material.kind, title: material.title, fileId: material.fileId, mimeType: fileMetadata.get(material.fileId)?.mimeType, byteSize: fileMetadata.get(material.fileId)?.byteSize, position: materialIndex }
            : { assignmentId: created.id, kind: material.kind, title: material.title, url: material.url, position: materialIndex };
        }) });
      }

      // Practice assignments aren't gated behind a module, so there's no per-module access to
      // seed for them — every active student in the practicum already sees it via listForStudent.
      // Only students already in *this* поток: the old version upserted an Enrollment for every
      // active student on the platform, so creating one ДЗ on 2026-10-01 silently pulled two
      // students from a finished test cohort into the current one (with no real course access).
      // Joining a поток happens only through an invitation or the owner's role switch.
      if (!normalized.isPractice) {
        const enrollments = await tx.enrollment.findMany({
          where: { practicumId: practicum.id, status: EnrollmentStatus.ACTIVE, student: { role: UserRole.STUDENT, status: UserStatus.ACTIVE } },
          select: { id: true },
        });
        for (const enrollment of enrollments) {
          await seedOpenModuleAccess(tx, enrollment.id, practicum.id);
        }
      }
      return created.id;
    });

    const created = await prisma.assignment.findUniqueOrThrow({
      where: { id: assignment },
      include: {
        module: { select: { id: true, practicumId: true, title: true, position: true, coverPath: true } },
        submissions: {
          include: {
            feedback: { orderBy: { createdAt: "asc" }, select: { id: true, text: true, createdAt: true, attachments: { orderBy: { createdAt: "asc" }, select: { id: true, originalName: true, mimeType: true, byteSize: true, fileId: true, file: { select: { status: true } } } } } },
            fileAttachments: { orderBy: { position: "asc" }, include: { file: { select: { id: true, originalName: true, mimeType: true, byteSize: true } } } },
          },
        },
        materials: { orderBy: { position: "asc" } },
      },
    });
    if (created.isPractice) {
      // Bell + EMAIL, unlike a regular assignment below — a practice assignment is never hidden
      // behind a module lock, so there's no "notification arrived but the item isn't in my list"
      // risk, and email is exactly right for a heads-up about backtest/pre-session work to do
      // while waiting on the group (see the explicit ask that started this feature).
      void (async () => {
        const [studentIds, emails] = await Promise.all([activeStudentIds(created.practicumId), activeStudentEmails(created.practicumId)]);
        if (studentIds.length > 0) await notificationService.createMany(studentIds, "NEW_ASSIGNMENT", `Практическое задание: ${created.title}`, undefined, created.id);
        await Promise.all(emails.map((email) => sendNewAssignmentNotification({ to: email, assignmentTitle: created.title, assignmentId: created.id })));
      })().catch((error: unknown) => console.error("Practice assignment notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
    } else {
      // Bell only, deliberately no email — see email-service.ts's curated list. Notifying a
      // student about an assignment sitting behind a module they haven't unlocked yet produces
      // exactly "the notification arrived but the item isn't in my list" — listForStudent hides
      // the same assignment under this same isModuleOpenForStudent check, so this makes the two
      // agree on who's actually told about it.
      void (async () => {
        const candidateIds = await activeStudentIds(created.module!.practicumId);
        const openChecks = await Promise.all(candidateIds.map(async (studentId) => ({
          studentId,
          open: await isModuleOpenForStudent(prisma, studentId, created.module!.practicumId, created.moduleId!),
        })));
        const notifiableIds = openChecks.filter((entry) => entry.open).map((entry) => entry.studentId);
        if (notifiableIds.length === 0) return;
        await notificationService.createMany(notifiableIds, "NEW_ASSIGNMENT", `Новое задание: ${created.title}`, created.module!.title, created.id);
      })().catch((error: unknown) => console.error("Assignment notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
    }
    return this.toStudentDto(created);
  }

  public async update(actorId: string, assignmentId: string, input: Partial<AssignmentInput>) {
    await this.assertCurator(actorId);
    const current = await prisma.assignment.findUnique({ where: { id: assignmentId } });
    if (!current) throw new AuthServiceError("INVALID_INPUT", "Assignment does not exist");
    const data: Prisma.AssignmentUpdateInput = {};
    if (input.title !== undefined) data.title = requiredText(input.title, "title");
    if (input.description !== undefined) data.description = requiredText(input.description, "description", MAX_TEXT_LENGTH);
    if (input.deadline !== undefined) data.deadline = parseDate(input.deadline);
    if (input.requirements !== undefined) data.requirements = normalizeRequirements(input.requirements) as Prisma.InputJsonValue;
    if (input.allowedFormats !== undefined) data.allowedFormats = normalizeFormats(input.allowedFormats) as Prisma.InputJsonValue;
    if (input.reviewRequired !== undefined) data.reviewRequired = input.reviewRequired;
    const normalizedMaterials = input.materials === undefined ? undefined : normalizeMaterials(input.materials);
    const updated = await prisma.$transaction(async (tx) => {
      if (normalizedMaterials !== undefined) {
        const fileMaterials = normalizedMaterials.filter((material) => material.kind === "FILE");
        const fileMetadata = new Map<string, { mimeType: string; byteSize: number }>();
        if (fileMaterials.length > 0) {
          const files = await tx.storedFile.findMany({ where: { id: { in: fileMaterials.map((material) => material.fileId) }, ownerId: actorId, status: StoredFileStatus.UPLOADED }, select: { id: true, mimeType: true, byteSize: true } });
          if (files.length !== fileMaterials.length) throw new AuthServiceError("FORBIDDEN", "Material file ownership is invalid");
          files.forEach((file) => fileMetadata.set(file.id, { mimeType: file.mimeType, byteSize: file.byteSize }));
        }
        await tx.assignmentMaterial.deleteMany({ where: { assignmentId } });
        if (normalizedMaterials.length > 0) await tx.assignmentMaterial.createMany({ data: normalizedMaterials.map((material, position) => material.kind === "FILE" ? { assignmentId, kind: material.kind, title: material.title, fileId: material.fileId, mimeType: fileMetadata.get(material.fileId)?.mimeType, byteSize: fileMetadata.get(material.fileId)?.byteSize, position } : { assignmentId, kind: material.kind, title: material.title, url: material.url, position }) });
      }
      return tx.assignment.update({
        where: { id: assignmentId }, data,
        include: { module: { select: { title: true, position: true, coverPath: true } }, submissions: { orderBy: { attempt: "desc" }, take: 1, include: { feedback: { orderBy: { createdAt: "asc" }, select: { id: true, text: true, createdAt: true, attachments: { orderBy: { createdAt: "asc" }, select: { id: true, originalName: true, mimeType: true, byteSize: true, fileId: true, file: { select: { status: true } } } } } }, fileAttachments: { orderBy: { position: "asc" }, include: { file: { select: { id: true, originalName: true, mimeType: true, byteSize: true } } } } } }, materials: { orderBy: { position: "asc" } } },
      });
    });
    return this.toStudentDto(updated);
  }

  public async archive(actorId: string, assignmentId: string): Promise<void> {
    await this.assertCurator(actorId);
    const result = await prisma.assignment.updateMany({ where: { id: assignmentId, status: { not: AssignmentStatus.ARCHIVED } }, data: { status: AssignmentStatus.ARCHIVED } });
    if (result.count !== 1) throw new AuthServiceError("INVALID_INPUT", "Assignment does not exist");

    // decide() below only re-checks "is every assignment in this module now accepted" at the
    // moment a submission gets accepted — it never re-fires on its own afterwards. A student
    // blocked solely by THIS assignment (already-accepted everywhere else in the module) would
    // otherwise stay stuck behind the "Сначала сдайте ДЗ модуля X" gate forever, even though the
    // assignment that was supposedly missing no longer exists.
    void this.recheckModuleCompletionAfterArchive(actorId, assignmentId)
      .catch((error: unknown) => console.error("Module completion recheck after archive failed", error instanceof Error ? error.message : "unknown error"));
  }

  private async recheckModuleCompletionAfterArchive(actorId: string, assignmentId: string): Promise<void> {
    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      select: { moduleId: true, module: { select: { practicumId: true } } },
    });
    if (!assignment || !assignment.module || !assignment.moduleId) return;
    const { moduleId } = assignment;
    const { practicumId } = assignment.module;

    const moduleAssignments = await prisma.assignment.findMany({ where: { moduleId, status: AssignmentStatus.PUBLISHED }, select: { id: true } });
    if (moduleAssignments.length === 0) return;

    const enrollments = await prisma.enrollment.findMany({ where: { practicumId, status: EnrollmentStatus.ACTIVE }, select: { id: true, studentId: true } });
    for (const enrollment of enrollments) {
      const access = await prisma.enrollmentModuleAccess.findUnique({ where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId } }, select: { status: true } });
      if (access?.status === ModuleAccessStatus.COMPLETED) continue;
      const latestStatuses = await Promise.all(moduleAssignments.map((moduleAssignment) => prisma.submission.findFirst({ where: { assignmentId: moduleAssignment.id, studentId: enrollment.studentId }, orderBy: { attempt: "desc" }, select: { status: true } })));
      if (!latestStatuses.every((submission) => submission?.status === SubmissionStatus.ACCEPTED)) continue;
      await courseService.markModuleCompletedForStudent(actorId, enrollment.studentId, moduleId);
    }
  }

  public async submit(studentId: string, assignmentId: string, input: SubmissionInput) {
    await this.assertActiveUser(studentId, UserRole.STUDENT);
    const assignment = await prisma.assignment.findFirst({
      where: { id: assignmentId, status: AssignmentStatus.PUBLISHED },
      select: { id: true, title: true, moduleId: true, reviewRequired: true, module: { select: { position: true, practicumId: true } } },
    });
    // A practice assignment has no module — it's answered through its linked DiscussionThread
    // (see DiscussionService#create) instead of this formal submission flow.
    if (!assignment || !assignment.module || !assignment.moduleId) throw new AuthServiceError("INVALID_INPUT", "Assignment is not available");
    if (await isPracticumCompleted(assignment.module.practicumId)) throw new AuthServiceError("INVALID_INPUT", "Практикум завершён — отправка домашних заданий больше не доступна.");
    // A "ДЗ без проверки" assignment only ever goes through completeWithoutReview below —
    // this path is for the normal curator-reviewed form the student no longer sees for it.
    if (!assignment.reviewRequired) throw new AuthServiceError("INVALID_INPUT", "Assignment does not require a submission");
    if (!(await isModuleOpenForStudent(prisma, studentId, assignment.module.practicumId, assignment.moduleId))) throw new AuthServiceError("INVALID_INPUT", "Assignment is not available");
    const blockedByModuleTitle = await assignmentPrerequisiteGate(prisma, studentId, assignment.module.practicumId, assignment.module.position);
    if (blockedByModuleTitle) throw new AuthServiceError("INVALID_INPUT", `Сначала нужно сдать ДЗ модуля «${blockedByModuleTitle}»`);
    const answerText = optionalText(input.answerText, MAX_TEXT_LENGTH);
    const attachments = normalizeAttachments(input.attachments);
    const fileIds = normalizeFileIds(input.fileIds);
    const storedFiles = fileIds.length > 0
      ? await prisma.storedFile.findMany({ where: { id: { in: fileIds }, ownerId: studentId, status: StoredFileStatus.UPLOADED }, select: { id: true, originalName: true, mimeType: true, byteSize: true } })
      : [];
    if (storedFiles.length !== fileIds.length) throw new AuthServiceError("FORBIDDEN", "File ownership is invalid");
    const storedFileMetadata = storedFiles.map((file) => ({ name: file.originalName, type: file.mimeType, size: file.byteSize }));
    const storedNames = new Set(storedFileMetadata.map((file) => file.name));
    const metadataOnly = attachments.filter((attachment) => !storedNames.has(attachment.name));
    const allAttachments = [...metadataOnly, ...storedFileMetadata];
    if (!answerText && allAttachments.length === 0) throw new AuthServiceError("INVALID_INPUT", "Answer cannot be empty");

    const previous = await prisma.submission.findFirst({ where: { assignmentId, studentId }, orderBy: { attempt: "desc" }, select: { attempt: true, status: true, reviewerId: true, claimedAt: true } });
    if (previous && (previous.status === SubmissionStatus.SUBMITTED || previous.status === SubmissionStatus.IN_REVIEW)) throw new AuthServiceError("INVALID_INPUT", "Submission is already awaiting review");
    if (previous?.status === SubmissionStatus.ACCEPTED) throw new AuthServiceError("INVALID_INPUT", "Accepted assignment cannot be submitted again");
    const attempt = (previous?.attempt ?? 0) + 1;
    // A resubmission after "на доработку" goes straight back to the same curator who sent
    // it there — already claimed (IN_REVIEW), no need for them to press "Взять на проверку"
    // again. A first-time submission (no previous reviewer) still starts unclaimed.
    const carriedReviewerId = previous?.status === SubmissionStatus.NEEDS_REVISION ? previous.reviewerId : null;

    const submission = await prisma.$transaction(async (tx) => {
      const created = await tx.submission.create({
        data: {
          assignmentId,
          studentId,
          attempt,
          status: carriedReviewerId ? SubmissionStatus.IN_REVIEW : SubmissionStatus.SUBMITTED,
          answerText,
          attachments: allAttachments as Prisma.InputJsonValue,
          submittedAt: new Date(),
          reviewerId: carriedReviewerId,
          claimedAt: carriedReviewerId ? new Date() : null,
        },
        select: { id: true, attempt: true, status: true, submittedAt: true },
      });
      if (fileIds.length > 0) await tx.submissionAttachment.createMany({ data: fileIds.map((fileId, position) => ({ submissionId: created.id, fileId, position })) });
      return created;
    });
    // Only for a genuinely new, unclaimed submission — a revision resubmission goes straight back
    // to the same reviewer (carriedReviewerId above) who already knows about it from having sent
    // it back, so broadcasting to every curator here would just be noise.
    if (!carriedReviewerId) {
      void this.notifyStaffOfNewSubmission(studentId, assignmentId, assignment.title)
        .catch((error: unknown) => console.error("New submission notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
    }
    return submission;
  }

  /**
   * The "Выполнено" button on a "ДЗ без проверки" assignment — creates an already-ACCEPTED
   * Submission directly, with no curator involved, then runs the same "did every assignment in
   * this module just get accepted" check decide() runs after a curator's accept, so a
   * homework-less lesson can still unlock the next one. See Assignment.reviewRequired.
   */
  public async completeWithoutReview(studentId: string, assignmentId: string) {
    await this.assertActiveUser(studentId, UserRole.STUDENT);
    const assignment = await prisma.assignment.findFirst({
      where: { id: assignmentId, status: AssignmentStatus.PUBLISHED, isPractice: false },
      select: { id: true, moduleId: true, reviewRequired: true, module: { select: { position: true, practicumId: true } } },
    });
    if (!assignment || !assignment.module || !assignment.moduleId) throw new AuthServiceError("INVALID_INPUT", "Assignment is not available");
    if (await isPracticumCompleted(assignment.module.practicumId)) throw new AuthServiceError("INVALID_INPUT", "Практикум завершён — отправка домашних заданий больше не доступна.");
    if (assignment.reviewRequired) throw new AuthServiceError("INVALID_INPUT", "Assignment requires review");
    if (!(await isModuleOpenForStudent(prisma, studentId, assignment.module.practicumId, assignment.moduleId))) throw new AuthServiceError("INVALID_INPUT", "Assignment is not available");
    const blockedByModuleTitle = await assignmentPrerequisiteGate(prisma, studentId, assignment.module.practicumId, assignment.module.position);
    if (blockedByModuleTitle) throw new AuthServiceError("INVALID_INPUT", `Сначала нужно сдать ДЗ модуля «${blockedByModuleTitle}»`);

    const moduleId = assignment.moduleId;
    const previous = await prisma.submission.findFirst({ where: { assignmentId, studentId }, orderBy: { attempt: "desc" }, select: { id: true, attempt: true, status: true, submittedAt: true } });
    // Idempotent replay (double-click, stale tab retry) — nothing new to do, just hand back what's there.
    if (previous?.status === SubmissionStatus.ACCEPTED) return previous;
    const attempt = (previous?.attempt ?? 0) + 1;
    const submission = await prisma.submission.create({
      data: { assignmentId, studentId, attempt, status: SubmissionStatus.ACCEPTED, submittedAt: new Date() },
      select: { id: true, attempt: true, status: true, submittedAt: true },
    });

    // Mirrors decide()'s post-accept auto-completion below — this assignment just became
    // ACCEPTED without a curator ever deciding it, so the same "is every assignment in the
    // module now accepted" check needs to run here too.
    void (async () => {
      const moduleAssignments = await prisma.assignment.findMany({ where: { moduleId, status: AssignmentStatus.PUBLISHED }, select: { id: true } });
      if (moduleAssignments.length === 0) return;
      const latestStatuses = await Promise.all(moduleAssignments.map((moduleAssignment) => prisma.submission.findFirst({ where: { assignmentId: moduleAssignment.id, studentId }, orderBy: { attempt: "desc" }, select: { status: true } })));
      if (!latestStatuses.every((entry) => entry?.status === SubmissionStatus.ACCEPTED)) return;
      await courseService.completeModuleForStudent(studentId, moduleId);
    })().catch((error: unknown) => console.error("Auto module completion (no-review) failed", error instanceof Error ? error.message : "unknown error"));

    return submission;
  }

  private async notifyStaffOfNewSubmission(studentId: string, assignmentId: string, assignmentTitle: string): Promise<void> {
    const [student, staff] = await Promise.all([
      prisma.user.findUnique({ where: { id: studentId }, select: { externalIdentities: { orderBy: { createdAt: "asc" }, take: 1, select: { displayName: true, username: true } } } }),
      prisma.user.findMany({ where: { role: { in: [UserRole.CURATOR, UserRole.OWNER] }, status: UserStatus.ACTIVE }, select: { id: true, email: true, notifyNewSubmission: true } }),
    ]);
    if (staff.length === 0) return;
    const studentName = student?.externalIdentities[0]?.displayName ?? student?.externalIdentities[0]?.username ?? "Ученик";
    await Promise.all(staff.map((recipient) => notificationService.create(recipient.id, "NEW_SUBMISSION", `Новая работа на проверку: ${assignmentTitle}`, studentName, assignmentId)));
    await Promise.all(staff.flatMap((recipient) => recipient.email && recipient.notifyNewSubmission
      ? [sendNewSubmissionNotification({ to: recipient.email, assignmentTitle, studentName, assignmentId })]
      : []));
  }

  public async listQueue(actorId: string) {
    // Every active curator sees the full queue, same as owner — curators are no longer
    // partitioned to only their assigned students' submissions.
    await this.assertCurator(actorId);
    const submissions = await prisma.submission.findMany({
      where: {
        status: { in: [SubmissionStatus.SUBMITTED, SubmissionStatus.IN_REVIEW, SubmissionStatus.NEEDS_REVISION, SubmissionStatus.ACCEPTED] },
        assignment: { status: { not: AssignmentStatus.ARCHIVED } },
      },
      orderBy: { submittedAt: "desc" },
      include: {
        assignment: { include: { module: { select: { title: true, position: true, coverPath: true } } } },
        fileAttachments: { orderBy: { position: "asc" }, include: { file: { select: { id: true, originalName: true, mimeType: true, byteSize: true } } } },
        feedback: { select: { id: true, text: true, createdAt: true, attachments: { orderBy: { createdAt: "asc" }, select: { id: true, originalName: true, mimeType: true, byteSize: true, fileId: true, file: { select: { status: true } } } } } },
        student: { include: { externalIdentities: { orderBy: { createdAt: "asc" } } } },
        reviewer: { include: { externalIdentities: { orderBy: { createdAt: "asc" }, take: 1 } } },
      },
    });
    // The review queue is an action list, not an attempt history — but a curator picking up a
    // resubmission still needs to see what the student answered (and what an earlier reviewer
    // said) in prior rounds, so each past attempt's own answer/files/feedback rides along too.
    const latestByWork = new Map<string, (typeof submissions)[number]>();
    const historyByWork = new Map<string, QueueAttempt[]>();
    for (const submission of submissions) {
      const key = `${submission.assignmentId}:${submission.studentId}`;
      const history = historyByWork.get(key) ?? [];
      history.push({ attempt: submission.attempt, status: submission.status, submittedAt: submission.submittedAt, answerText: submission.answerText, fileAttachments: submission.fileAttachments, feedback: submission.feedback });
      historyByWork.set(key, history);
      const current = latestByWork.get(key);
      if (!current || submission.attempt > current.attempt) latestByWork.set(key, submission);
    }
    return [...latestByWork.entries()].map(([key, submission]) => this.toQueueDto(submission, historyByWork.get(key) ?? [], actorId));
  }

  public async claim(actorId: string, submissionId: string) {
    await this.assertCurator(actorId);
    try {
      return await prisma.$transaction(async (tx) => {
        const current = await tx.submission.findUnique({
          where: { id: submissionId },
          select: { id: true, studentId: true, status: true, reviewerId: true, claimedAt: true },
        });
        if (!current) throw new AuthServiceError("INVALID_INPUT", "Submission does not exist");
        if (current.status !== SubmissionStatus.SUBMITTED && current.status !== SubmissionStatus.NEEDS_REVISION && current.status !== SubmissionStatus.IN_REVIEW) {
          throw new AuthServiceError("INVALID_INPUT", "Submission is not awaiting review");
        }
        // No owner bypass here (unlike releaseClaim below) — otherwise a stale page (owner
        // hasn't refreshed since a curator claimed this) lets the owner silently steal the
        // claim with no error and no confirmation, while the same race the other way around
        // correctly rejects the curator. An owner who actually wants to take over already has
        // releaseClaim for that — two deliberate actions instead of an accidental one.
        if (current.reviewerId && current.reviewerId !== actorId) {
          throw new AuthServiceError("AUTH_CONFLICT", "Work is already being checked by another curator");
        }
        const updated = await tx.submission.update({
          where: { id: submissionId },
          data: { reviewerId: actorId, claimedAt: current.claimedAt ?? new Date(), status: SubmissionStatus.IN_REVIEW },
          select: { id: true, status: true, reviewerId: true, claimedAt: true },
        });
        return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof AuthServiceError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        throw new AuthServiceError("AUTH_CONFLICT", "Work was claimed by another curator. Refresh the queue");
      }
      throw error;
    }
  }

  public async releaseClaim(actorId: string, submissionId: string) {
    const actor = await this.assertCurator(actorId);
    const current = await prisma.submission.findUnique({ where: { id: submissionId }, select: { id: true, reviewerId: true, status: true, attempt: true } });
    if (!current) throw new AuthServiceError("INVALID_INPUT", "Submission does not exist");
    if (current.reviewerId !== actorId && actor.role !== UserRole.OWNER) throw new AuthServiceError("FORBIDDEN", "Only the assigned curator can release this work");
    // A curator who already sent a previous attempt of this same work back for revision is
    // automatically re-assigned to it on resubmission (see submit()'s carriedReviewerId) —
    // they can't bail out of that follow-up review, so the student doesn't lose the context
    // of who has already been working with them on it.
    if (current.attempt > 1 && actor.role !== UserRole.OWNER) throw new AuthServiceError("FORBIDDEN", "Нельзя отменить взятие: вы уже отправляли эту работу на доработку");
    return prisma.submission.update({
      where: { id: submissionId },
      data: { reviewerId: null, claimedAt: null, status: current.status === SubmissionStatus.IN_REVIEW ? SubmissionStatus.SUBMITTED : current.status },
      select: { id: true, status: true, reviewerId: true, claimedAt: true },
    });
  }

  public async listStudentHistory(actorId: string, studentId: string) {
    await this.assertCurator(actorId);
    const submissions = await prisma.submission.findMany({
      where: { studentId }, orderBy: [{ createdAt: "desc" }, { attempt: "desc" }], take: 100,
      include: { assignment: { include: { module: { select: { title: true, position: true } } } }, feedback: { orderBy: { createdAt: "asc" }, select: { id: true, text: true, createdAt: true, attachments: { orderBy: { createdAt: "asc" }, select: { id: true, originalName: true, mimeType: true, byteSize: true, fileId: true, file: { select: { status: true } } } } } }, fileAttachments: { orderBy: { position: "asc" }, include: { file: { select: { id: true, originalName: true, mimeType: true, byteSize: true } } } } },
    });
    const grouped = new Map<string, StudentHistoryGroup>();
    for (const submission of submissions) {
      const attempt: StudentHistoryAttempt = {
        id: submission.id,
        attempt: submission.attempt,
        status: submission.status,
        answerText: submission.answerText,
        submittedAt: submission.submittedAt,
        createdAt: submission.createdAt,
        feedback: mapFeedback(submission.feedback),
        files: submission.fileAttachments.map((attachment) => attachment.file),
      };
      const current = grouped.get(submission.assignmentId);
      if (!current) {
        grouped.set(submission.assignmentId, {
          ...attempt,
          assignmentId: submission.assignmentId,
          title: submission.assignment.title,
          // Same invariant as toQueueDto above — a Submission only ever belongs to a
          // regular assignment, which always has a module.
          module: `${String(submission.assignment.module!.position).padStart(2, "0")} · ${submission.assignment.module!.title}`,
          attempts: [attempt],
        });
        continue;
      }
      current.attempts.push(attempt);
      if (attempt.attempt > current.attempt) {
        Object.assign(current, attempt);
      }
    }

    return [...grouped.values()]
      .map((group) => ({
        ...group,
        attempts: [...group.attempts].sort((left, right) => left.attempt - right.attempt),
      }))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  public async decide(actorId: string, submissionId: string, decision: "accepted" | "revision", feedback?: string, checkedRequirements?: string[], attachments?: FeedbackAttachmentInput[]) {
    const actor = await this.assertCurator(actorId);
    if (attachments && attachments.length > 0) {
      for (const attachment of attachments) {
        requiredText(attachment.originalName, "attachment.originalName", MAX_ATTACHMENT_NAME_LENGTH);
        if (!Number.isSafeInteger(attachment.byteSize) || attachment.byteSize < 1 || attachment.byteSize > MAX_ATTACHMENT_SIZE) {
          throw new AuthServiceError("INVALID_INPUT", "attachment is invalid");
        }
      }
      const fileIds = attachments.map((attachment) => attachment.fileId);
      const files = await prisma.storedFile.findMany({ where: { id: { in: fileIds }, ownerId: actorId, status: StoredFileStatus.UPLOADED }, select: { id: true } });
      if (files.length !== new Set(fileIds).size) throw new AuthServiceError("FORBIDDEN", "Attachment ownership is invalid");
    }
    try {
      const result = await prisma.$transaction(async (tx) => {
        const current = await tx.submission.findUnique({
          where: { id: submissionId },
          include: { student: { select: { email: true } }, assignment: { include: { module: true } } },
        });
        if (!current) throw new AuthServiceError("INVALID_INPUT", "Submission does not exist");
        if (!current.reviewerId) throw new AuthServiceError("AUTH_CONFLICT", "Take the work for review before deciding");
        if (current.reviewerId !== actorId && actor.role !== UserRole.OWNER) throw new AuthServiceError("FORBIDDEN", "Work is assigned to another curator");
        const nextStatus = nextSubmissionStatus(current.status, decision) as SubmissionStatus;
        // Criteria are advisory, not a gate — a curator can accept even if not every box is
        // checked. We still snapshot what WAS checked at decision time so it stays visible
        // later that the work was accepted despite an unchecked criterion.
        const submission = await tx.submission.update({
          where: { id: submissionId },
          data: { status: nextStatus, checkedRequirements: checkedRequirements ? (checkedRequirements as Prisma.InputJsonValue) : undefined },
          select: { id: true, status: true },
        });
        if (feedback?.trim() || (attachments && attachments.length > 0)) {
          await tx.feedback.create({
            data: {
              submissionId,
              authorId: actorId,
              text: feedback?.trim().slice(0, MAX_TEXT_LENGTH) ?? "",
              attachments: attachments && attachments.length > 0 ? { create: attachments.map((attachment) => ({ fileId: attachment.fileId, originalName: attachment.originalName, mimeType: attachment.mimeType, byteSize: attachment.byteSize })) } : undefined,
            },
          });
        }

        return { ...submission, studentEmail: current.student.email, studentId: current.studentId, assignmentId: current.assignmentId, assignmentTitle: current.assignment.title, moduleId: current.assignment.moduleId };
      });
      if (result.studentEmail) void sendReviewNotification({ to: result.studentEmail, assignmentTitle: result.assignmentTitle, decision, feedback });
      void notificationService.create(
        result.studentId,
        "REVIEW_DECISION",
        decision === "accepted" ? `Задание принято: ${result.assignmentTitle}` : `Задание нужно доработать: ${result.assignmentTitle}`,
        feedback,
        result.assignmentId,
      ).catch((error: unknown) => console.error("Review notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
      // Accepting one submission doesn't complete the module by itself — a module can hold
      // several assignments — but once every one of them is accepted for this student, the
      // module counts as done and the next module unlocks for them, same as a curator
      // clicking "Урок пройден" by hand. Matches what the "Сначала сдайте ДЗ урока X" gate
      // message on the locked next assignment actually promises.
      if (decision === "accepted" && result.moduleId) {
        const moduleId = result.moduleId;
        void (async () => {
          const moduleAssignments = await prisma.assignment.findMany({ where: { moduleId, status: AssignmentStatus.PUBLISHED }, select: { id: true } });
          if (moduleAssignments.length === 0) return;
          const latestStatuses = await Promise.all(moduleAssignments.map((moduleAssignment) => prisma.submission.findFirst({ where: { assignmentId: moduleAssignment.id, studentId: result.studentId }, orderBy: { attempt: "desc" }, select: { status: true } })));
          if (!latestStatuses.every((submission) => submission?.status === SubmissionStatus.ACCEPTED)) return;
          await courseService.markModuleCompletedForStudent(actorId, result.studentId, moduleId);
        })().catch((error: unknown) => console.error("Auto module completion failed", error instanceof Error ? error.message : "unknown error"));
      }
      return { id: result.id, status: result.status };
    } catch (error) {
      if (error instanceof AuthServiceError) throw error;
      throw new AuthServiceError("INVALID_INPUT", "Submission cannot be reviewed");
    }
  }

  private normalizeAssignmentInput(input: AssignmentInput) {
    const isPractice = input.isPractice === true;
    return {
      isPractice,
      moduleId: isPractice ? undefined : requiredText(input.moduleId ?? "", "moduleId", 100),
      title: requiredText(input.title, "title"),
      description: requiredText(input.description, "description", MAX_TEXT_LENGTH),
      deadline: isPractice ? undefined : parseDate(input.deadline),
      requirements: isPractice ? [] : normalizeRequirements(input.requirements),
      allowedFormats: isPractice ? [] : normalizeFormats(input.allowedFormats),
      materials: normalizeMaterials(input.materials),
      reviewRequired: input.reviewRequired !== false,
    };
  }

  private async assertCurator(userId: string): Promise<{ role: UserRole }> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
    if (!user || user.status !== UserStatus.ACTIVE || (user.role !== UserRole.CURATOR && user.role !== UserRole.OWNER)) throw new AuthServiceError("FORBIDDEN", "Curator access required");
    return { role: user.role };
  }

  private async assertActiveUser(userId: string, role: UserRole): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
    if (!user || user.status !== UserStatus.ACTIVE || user.role !== role) throw new AuthServiceError("FORBIDDEN", "Student access required");
  }

  private toStudentDto(assignment: AssignmentWithRelations, blockedByModuleTitle: string | null = null, discussionStatus?: DiscussionStatus, lastMessage?: { text: string; fromCurator: boolean; createdAt: Date } | null, practicumCompleted = false) {
    const latest = latestSubmission(assignment.submissions ?? []);
    // A practice assignment never gets a Submission row (see submit()) — its "status" instead
    // tracks whose turn it is in the linked DiscussionThread (see DiscussionService#reply).
    const status = assignment.isPractice ? practiceStatusFromDiscussion(discussionStatus) : assignmentStatusFromSubmission(latest?.status);
    return {
      id: assignment.id,
      title: assignment.title,
      isPractice: assignment.isPractice,
      // "Завершить поток" — read access to everything below stays; the submit form/"Выполнено"
      // button just hide behind this. See practicum-service.ts#isPracticumCompleted.
      practicumCompleted,
      // "Выполнено" button vs. the normal submission form — see AssignmentService#completeWithoutReview.
      // Always true for a practice assignment (irrelevant there; it never uses this DTO's submission flow).
      reviewRequired: assignment.reviewRequired,
      // Practice-only — the latest message in the linked DiscussionThread, so the card can show
      // what was actually said without a click-through. Always null for a regular assignment.
      lastMessage: lastMessage ? { text: lastMessage.text, fromCurator: lastMessage.fromCurator, createdAt: lastMessage.createdAt } : null,
      module: assignment.module ? `${String(assignment.module.position).padStart(2, "0")} · ${assignment.module.title}` : "Практическое задание",
      coverPath: assignment.module?.coverPath ?? null,
      status,
      blockedByModuleTitle,
      tone: toneFromStatus(status),
      date: new Intl.DateTimeFormat("ru-RU").format(assignment.createdAt),
      deadline: formatDate(assignment.deadline),
      description: assignment.description,
      requirements: getRequirements(assignment.requirements),
      materials: assignment.materials.map((material) => ({
        id: material.id,
        kind: material.kind,
        title: material.title,
        url: material.kind === "FILE" && material.fileId ? `/api/files/${material.fileId}/content` : material.url,
        mimeType: material.mimeType,
        byteSize: material.byteSize,
      })),
      submission: latest && "answerText" in latest ? {
        attempt: latest.attempt,
        answerText: latest.answerText,
        submittedAt: latest.submittedAt,
        feedback: mapFeedback(latest.feedback),
        files: latest.fileAttachments.map((attachment) => attachment.file),
      } : undefined,
      // Every attempt, not just the latest — a resubmission after "на доработку" is a new
      // row (same assignment), and the student previously had no way to see earlier rounds.
      submissionHistory: [...(assignment.submissions ?? [])]
        .sort((left, right) => left.attempt - right.attempt)
        .filter((entry): entry is typeof entry & { answerText: string | null } => "answerText" in entry)
        .map((entry) => ({
          attempt: entry.attempt,
          status: assignmentStatusFromSubmission(entry.status),
          answerText: entry.answerText,
          submittedAt: entry.submittedAt,
          feedback: mapFeedback(entry.feedback),
          files: entry.fileAttachments.map((attachment) => attachment.file),
        })),
    };
  }

  // Submissions only ever exist for regular (non-practice) assignments — see submit()'s explicit
  // rejection of practice ones — so assignment.module is null here only in the type system, never
  // in practice; the "!" below reflects that invariant rather than asserting past a real gap.
  private toQueueDto(submission: Awaited<ReturnType<typeof prisma.submission.findFirst>> & { assignment: { title: string; requirements: unknown; reviewRequired: boolean; module: { title: string; position: number; coverPath: string | null } | null }; student: { isAdvanced: boolean; externalIdentities: Array<{ displayName: string | null; username: string | null; avatarUrl: string | null; provider: string }> }; reviewer: { id: string; email: string | null; externalIdentities: Array<{ displayName: string | null; username: string | null }> } | null; fileAttachments: Array<{ file: { id: string; originalName: string; mimeType: string; byteSize: number } }>; checkedRequirements?: Prisma.JsonValue }, attemptHistory: readonly QueueAttempt[], actorId: string) {
    const identity = submission.student.externalIdentities[0];
    const studentName = identity?.displayName ?? identity?.username ?? "Ученик";
    // Curators recognize students by face faster than by initials once a cohort grows past a
    // handful of people — prefer the Discord avatar (highest-fidelity provider) over whichever
    // identity happens to be oldest.
    const studentAvatarUrl = submission.student.externalIdentities.find((entry) => entry.provider === "DISCORD")?.avatarUrl ?? submission.student.externalIdentities[0]?.avatarUrl ?? null;
    const status = assignmentStatusFromSubmission(submission.status);
    const metadataAttachments = getAttachments(submission.attachments);
    const storedAttachments = submission.fileAttachments.map((item) => item.file);
    const attachmentNames = [...new Set([...metadataAttachments.map((item) => item.name), ...storedAttachments.map((item) => item.originalName)])];
    const reviewerId = submission.reviewerId;
    const reviewerName = submission.reviewer?.externalIdentities[0]?.displayName ?? submission.reviewer?.externalIdentities[0]?.username ?? submission.reviewer?.email ?? null;
    return {
      id: submission.id,
      studentName,
      studentInitials: studentName.slice(0, 2).toUpperCase(),
      studentAvatarUrl,
      studentIsAdvanced: submission.student.isAdvanced,
      assignmentTitle: submission.assignment.title,
      requirements: getRequirements(submission.assignment.requirements as Prisma.JsonValue),
      module: `${String(submission.assignment.module!.position).padStart(2, "0")} · ${submission.assignment.module!.title}`,
      coverPath: submission.assignment.module!.coverPath,
      status,
      tone: toneFromStatus(status),
      submittedAt: submission.submittedAt ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(submission.submittedAt) : "Без даты",
      attempt: `Попытка ${submission.attempt}`,
      studentNote: attachmentNames.map((name) => `Прикреплён файл: ${name}`).join(" · ") || "Ответ отправлен без файла.",
      answer: submission.answerText ?? "Ответ отправлен вложением.",
      attachments: attachmentNames,
      attachmentFiles: storedAttachments.map((item) => ({ id: item.id, name: item.originalName, type: item.mimeType, size: item.byteSize, url: `/api/files/${item.id}/content` })),
      attemptHistory: [...attemptHistory].sort((left, right) => left.attempt - right.attempt).map((attempt) => ({
        attempt: attempt.attempt,
        status: assignmentStatusFromSubmission(attempt.status),
        submittedAt: attempt.submittedAt ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(attempt.submittedAt) : "Без даты",
        answerText: attempt.answerText,
        files: attempt.fileAttachments.map((item) => ({ id: item.file.id, name: item.file.originalName, type: item.file.mimeType, size: item.file.byteSize, url: `/api/files/${item.file.id}/content` })),
        feedback: mapFeedback(attempt.feedback),
      })),
      reviewerId,
      reviewerName,
      // Lets the frontend disable "Принять/Вернуть на доработку" when someone else already
      // has this claimed — the server already rejects the decide()/claim() call in that
      // case, but the button used to stay clickable and just fail after a round trip.
      isReviewerSelf: reviewerId === null || reviewerId === actorId,
      // "Проверено вами" counts only work this curator actually accepted. A "ДЗ без проверки"
      // the student completed themselves is ACCEPTED with no reviewer at all, and the
      // isReviewerSelf above (null counts as "self" so an unclaimed item stays actionable) used
      // to credit every one of those to whoever was looking at the dashboard (2026-10-01).
      reviewedByMe: reviewerId === actorId,
      selfCompleted: submission.status === SubmissionStatus.ACCEPTED && reviewerId === null && !submission.assignment.reviewRequired,
      claimedAt: submission.claimedAt,
      checkedRequirements: Array.isArray(submission.checkedRequirements) ? (submission.checkedRequirements as string[]) : null,
      progress: "—",
    };
  }
}

export const assignmentService = new AssignmentService();
