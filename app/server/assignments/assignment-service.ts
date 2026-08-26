import { Prisma } from "@/app/generated/prisma/client";
import {
  AssignmentStatus,
  LessonType,
  StoredFileStatus,
  SubmissionStatus,
  UserRole,
  UserStatus,
} from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { AuthServiceError } from "@/app/server/auth";
import { assignmentPrerequisiteGate, seedOpenModuleAccess } from "@/app/server/course/module-access";
import { sendReviewNotification } from "@/app/server/notifications/email-service";
import { sendNewAssignmentNotification } from "@/app/server/notifications/email-service";
import { activeStudentEmails, activeStudentIds } from "@/app/server/notifications/recipient-service";
import { notificationService } from "@/app/server/notifications/notification-service";
import { nextSubmissionStatus } from "./assignment-transition";

type AssignmentMaterialInput =
  | { kind: "LINK"; title: string; url: string }
  | { kind: "FILE"; title: string; fileId: string };

type AssignmentInput = {
  lessonId?: string;
  title: string;
  description: string;
  moduleNumber: string;
  moduleTitle: string;
  deadline?: string;
  requirements: string[];
  allowedFormats: string[];
  materials?: AssignmentMaterialInput[];
};

type SubmissionInput = {
  answerText?: string;
  attachments?: Array<{ name: string; type: string; size: number }>;
  fileIds?: string[];
};

type AssignmentWithRelations = Prisma.AssignmentGetPayload<{
  include: {
    lesson: { include: { module: { select: { title: true; position: true; coverPath: true } } } };
    submissions: { include: { feedback: { select: { id: true, text: true, createdAt: true } }, fileAttachments: { include: { file: { select: { id: true, originalName: true, mimeType: true, byteSize: true } } } } } };
    materials: { orderBy: { position: "asc" } };
  };
}>;

type StudentHistoryFile = { id: string; originalName: string; mimeType: string; byteSize: number };
type StudentHistoryFeedback = { id: string; text: string; createdAt: Date };
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

function parseModulePosition(value: string): number {
  const position = Number.parseInt(value, 10);
  if (!Number.isInteger(position) || position < 0 || position > 99) {
    throw new AuthServiceError("INVALID_INPUT", "moduleNumber is invalid");
  }
  return position;
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

function toneFromStatus(status: ReturnType<typeof assignmentStatusFromSubmission>): "blue" | "amber" | "gray" {
  if (status === "Нужна доработка") return "amber";
  if (status === "Не начато") return "gray";
  return "blue";
}

function latestSubmission<T extends { attempt: number }>(submissions: readonly T[]): T | undefined {
  return [...submissions].sort((left, right) => right.attempt - left.attempt)[0];
}

export class AssignmentService {
  public async listForStudent(studentId: string) {
    await this.assertActiveUser(studentId, UserRole.STUDENT);
    const assignments = await prisma.assignment.findMany({
      where: { status: AssignmentStatus.PUBLISHED },
      orderBy: { createdAt: "desc" },
      include: {
        lesson: { include: { module: { select: { title: true, position: true, coverPath: true, practicumId: true } } } },
        submissions: {
          where: { studentId },
          orderBy: { attempt: "desc" },
          include: {
            feedback: { orderBy: { createdAt: "asc" }, select: { id: true, text: true, createdAt: true } },
            fileAttachments: { orderBy: { position: "asc" }, include: { file: { select: { id: true, originalName: true, mimeType: true, byteSize: true } } } },
          },
        },
        materials: { orderBy: { position: "asc" } },
      },
    });
    // A module can hold several assignments (or a stream, or nothing) — completion is a
    // curator's explicit call (markModuleCompletedForStudent), so each assignment still
    // needs its own gate check against the module before it, not just "is the module open."
    const gateCache = new Map<string, string | null>();
    return Promise.all(assignments.map(async (assignment) => {
      const cacheKey = `${assignment.lesson.module.practicumId}:${assignment.lesson.module.position}`;
      if (!gateCache.has(cacheKey)) {
        gateCache.set(cacheKey, await assignmentPrerequisiteGate(prisma, studentId, assignment.lesson.module.practicumId, assignment.lesson.module.position));
      }
      return this.toStudentDto(assignment, gateCache.get(cacheKey) ?? null);
    }));
  }

  public async listForCurator(actorId: string) {
    await this.assertCurator(actorId);
    const assignments = await prisma.assignment.findMany({
      where: { status: { not: AssignmentStatus.ARCHIVED } },
      orderBy: { createdAt: "desc" },
      include: {
        lesson: { include: { module: { select: { title: true, position: true, coverPath: true } } } },
        submissions: {
          include: {
            feedback: { orderBy: { createdAt: "asc" }, select: { id: true, text: true, createdAt: true } },
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
    const position = parseModulePosition(normalized.moduleNumber);

    const assignment = await prisma.$transaction(async (tx) => {
      // Matching every other lookup in the app (course-service.ts, stream-service.ts) —
      // the earliest-created practicum, not a hardcoded title. A title match is fragile
      // across environments (staging's practicum is titled "Practicum 04", not "Практикум
      // 04") and silently spawned a second, disconnected practicum + module whenever it
      // missed, which is what produced "Lesson does not belong to this module": the
      // existing lessonId pointed at a lesson under the REAL module, not the phantom one
      // just created under the mismatched practicum.
      const practicum = await tx.practicum.findFirst({ orderBy: { createdAt: "asc" } });
      if (!practicum) throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");
      const courseModule = await tx.module.upsert({
        where: { practicumId_position: { practicumId: practicum.id, position } },
        update: { title: normalized.moduleTitle },
        create: { practicumId: practicum.id, position, title: normalized.moduleTitle },
      });
      const lesson = normalized.lessonId
        ? await tx.lesson.findFirst({ where: { id: normalized.lessonId, moduleId: courseModule.id } })
        : await tx.lesson.create({
            data: {
              moduleId: courseModule.id,
              position: (await tx.lesson.count({ where: { moduleId: courseModule.id } })) + 1,
              title: normalized.title,
              type: LessonType.ASSIGNMENT,
              description: normalized.description,
            },
          });
      if (!lesson) throw new AuthServiceError("INVALID_INPUT", "Lesson does not belong to this module");
      const created = await tx.assignment.create({
        data: {
          lessonId: lesson.id,
          title: normalized.title,
          description: normalized.description,
          requirements: normalized.requirements as Prisma.InputJsonValue,
          allowedFormats: normalized.allowedFormats as Prisma.InputJsonValue,
          deadline: normalized.deadline,
          status: AssignmentStatus.PUBLISHED,
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

      const students = await tx.user.findMany({ where: { role: UserRole.STUDENT, status: UserStatus.ACTIVE }, select: { id: true } });
      for (const student of students) {
        const studentEnrollment = await tx.enrollment.upsert({
          where: { studentId_practicumId: { studentId: student.id, practicumId: practicum.id } },
          update: {},
          create: { studentId: student.id, practicumId: practicum.id },
          select: { id: true },
        });
        await seedOpenModuleAccess(tx, studentEnrollment.id, practicum.id);
      }
      return created.id;
    });

    const created = await prisma.assignment.findUniqueOrThrow({
      where: { id: assignment },
      include: {
        lesson: { include: { module: { select: { id: true, practicumId: true, title: true, position: true, coverPath: true } } } },
        submissions: {
          include: {
            feedback: { orderBy: { createdAt: "asc" }, select: { id: true, text: true, createdAt: true } },
            fileAttachments: { orderBy: { position: "asc" }, include: { file: { select: { id: true, originalName: true, mimeType: true, byteSize: true } } } },
          },
        },
        materials: { orderBy: { position: "asc" } },
      },
    });
    void activeStudentEmails(created.lesson.module.practicumId)
      .then((emails) => Promise.all(emails.map((to) => sendNewAssignmentNotification({ to, assignmentTitle: created.title, moduleTitle: created.lesson.module.title, assignmentId: created.id }))))
      .catch((error: unknown) => console.error("Assignment recipient lookup failed", error instanceof Error ? error.message : "unknown error"));
    void activeStudentIds(created.lesson.module.practicumId)
      .then((studentIds) => notificationService.createMany(studentIds, "NEW_ASSIGNMENT", `Новое задание: ${created.title}`, created.lesson.module.title, created.id))
      .catch((error: unknown) => console.error("Assignment notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
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
        include: { lesson: { include: { module: { select: { title: true, position: true, coverPath: true } } } }, submissions: { orderBy: { attempt: "desc" }, take: 1, include: { feedback: { orderBy: { createdAt: "asc" }, select: { id: true, text: true, createdAt: true } }, fileAttachments: { orderBy: { position: "asc" }, include: { file: { select: { id: true, originalName: true, mimeType: true, byteSize: true } } } } } }, materials: { orderBy: { position: "asc" } } },
      });
    });
    return this.toStudentDto(updated);
  }

  public async archive(actorId: string, assignmentId: string): Promise<void> {
    await this.assertCurator(actorId);
    const result = await prisma.assignment.updateMany({ where: { id: assignmentId, status: { not: AssignmentStatus.ARCHIVED } }, data: { status: AssignmentStatus.ARCHIVED } });
    if (result.count !== 1) throw new AuthServiceError("INVALID_INPUT", "Assignment does not exist");
  }

  public async submit(studentId: string, assignmentId: string, input: SubmissionInput) {
    await this.assertActiveUser(studentId, UserRole.STUDENT);
    const assignment = await prisma.assignment.findFirst({
      where: { id: assignmentId, status: AssignmentStatus.PUBLISHED },
      select: { id: true, lesson: { select: { module: { select: { position: true, practicumId: true } } } } },
    });
    if (!assignment) throw new AuthServiceError("INVALID_INPUT", "Assignment is not available");
    const blockedByModuleTitle = await assignmentPrerequisiteGate(prisma, studentId, assignment.lesson.module.practicumId, assignment.lesson.module.position);
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

    return prisma.$transaction(async (tx) => {
      const submission = await tx.submission.create({
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
      if (fileIds.length > 0) await tx.submissionAttachment.createMany({ data: fileIds.map((fileId, position) => ({ submissionId: submission.id, fileId, position })) });
      return submission;
    });
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
        assignment: { include: { lesson: { include: { module: { select: { title: true, position: true, coverPath: true } } } } } },
        fileAttachments: { orderBy: { position: "asc" }, include: { file: { select: { id: true, originalName: true, mimeType: true, byteSize: true } } } },
        student: { include: { externalIdentities: { orderBy: { createdAt: "asc" }, take: 1 } } },
        reviewer: { include: { externalIdentities: { orderBy: { createdAt: "asc" }, take: 1 } } },
      },
    });
    // The review queue is an action list, not an attempt history. Keep only the
    // newest attempt for each student/assignment; the full history is exposed
    // from the student profile and assignment history endpoints.
    const latestByWork = new Map<string, (typeof submissions)[number]>();
    const historyByWork = new Map<string, QueueAttempt[]>();
    for (const submission of submissions) {
      const key = `${submission.assignmentId}:${submission.studentId}`;
      const history = historyByWork.get(key) ?? [];
      history.push({ attempt: submission.attempt, status: submission.status, submittedAt: submission.submittedAt });
      historyByWork.set(key, history);
      const current = latestByWork.get(key);
      if (!current || submission.attempt > current.attempt) latestByWork.set(key, submission);
    }
    return [...latestByWork.entries()].map(([key, submission]) => this.toQueueDto(submission, historyByWork.get(key) ?? [], actorId));
  }

  public async claim(actorId: string, submissionId: string) {
    const actor = await this.assertCurator(actorId);
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
        if (current.reviewerId && current.reviewerId !== actorId && actor.role !== UserRole.OWNER) {
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
    const current = await prisma.submission.findUnique({ where: { id: submissionId }, select: { id: true, reviewerId: true, status: true } });
    if (!current) throw new AuthServiceError("INVALID_INPUT", "Submission does not exist");
    if (current.reviewerId !== actorId && actor.role !== UserRole.OWNER) throw new AuthServiceError("FORBIDDEN", "Only the assigned curator can release this work");
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
      include: { assignment: { include: { lesson: { include: { module: { select: { title: true, position: true } } } } } }, feedback: { orderBy: { createdAt: "asc" }, select: { id: true, text: true, createdAt: true } }, fileAttachments: { orderBy: { position: "asc" }, include: { file: { select: { id: true, originalName: true, mimeType: true, byteSize: true } } } } },
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
        feedback: submission.feedback,
        files: submission.fileAttachments.map((attachment) => attachment.file),
      };
      const current = grouped.get(submission.assignmentId);
      if (!current) {
        grouped.set(submission.assignmentId, {
          ...attempt,
          assignmentId: submission.assignmentId,
          title: submission.assignment.title,
          module: `${String(submission.assignment.lesson.module.position).padStart(2, "0")} · ${submission.assignment.lesson.module.title}`,
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

  public async decide(actorId: string, submissionId: string, decision: "accepted" | "revision", feedback?: string, checkedRequirements?: string[]) {
    const actor = await this.assertCurator(actorId);
    try {
      const result = await prisma.$transaction(async (tx) => {
        const current = await tx.submission.findUnique({
          where: { id: submissionId },
          include: { student: { select: { email: true } }, assignment: { include: { lesson: { include: { module: true } } } } },
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
        if (feedback?.trim()) await tx.feedback.create({ data: { submissionId, authorId: actorId, text: feedback.trim().slice(0, MAX_TEXT_LENGTH) } });

        // Accepting a submission only accepts THAT submission — a module can hold several
        // assignments (or none at all), so only a curator can judge when the module itself
        // is done. See CourseService.markModuleCompletedForStudent, triggered by the
        // "Отметить модуль пройденным" button on the student's page.
        return { ...submission, studentEmail: current.student.email, studentId: current.studentId, assignmentId: current.assignmentId, assignmentTitle: current.assignment.title };
      });
      if (result.studentEmail) void sendReviewNotification({ to: result.studentEmail, assignmentTitle: result.assignmentTitle, decision, feedback });
      void notificationService.create(
        result.studentId,
        "REVIEW_DECISION",
        decision === "accepted" ? `Задание принято: ${result.assignmentTitle}` : `Задание нужно доработать: ${result.assignmentTitle}`,
        feedback,
        result.assignmentId,
      ).catch((error: unknown) => console.error("Review notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
      return { id: result.id, status: result.status };
    } catch (error) {
      if (error instanceof AuthServiceError) throw error;
      throw new AuthServiceError("INVALID_INPUT", "Submission cannot be reviewed");
    }
  }

  private normalizeAssignmentInput(input: AssignmentInput) {
    return {
      lessonId: input.lessonId?.trim() || undefined,
      title: requiredText(input.title, "title"),
      description: requiredText(input.description, "description", MAX_TEXT_LENGTH),
      moduleNumber: requiredText(input.moduleNumber, "moduleNumber", 10),
      moduleTitle: requiredText(input.moduleTitle, "moduleTitle"),
      deadline: parseDate(input.deadline),
      requirements: normalizeRequirements(input.requirements),
      allowedFormats: normalizeFormats(input.allowedFormats),
      materials: normalizeMaterials(input.materials),
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

  private toStudentDto(assignment: AssignmentWithRelations, blockedByModuleTitle: string | null = null) {
    const latest = latestSubmission(assignment.submissions ?? []);
    const status = assignmentStatusFromSubmission(latest?.status);
    return {
      id: assignment.id,
      title: assignment.title,
      module: `${String(assignment.lesson.module.position).padStart(2, "0")} · ${assignment.lesson.module.title}`,
      lessonTitle: assignment.lesson.title,
      coverPath: assignment.lesson.module.coverPath,
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
        feedback: latest.feedback,
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
          feedback: entry.feedback,
          files: entry.fileAttachments.map((attachment) => attachment.file),
        })),
    };
  }

  private toQueueDto(submission: Awaited<ReturnType<typeof prisma.submission.findFirst>> & { assignment: { title: string; requirements: unknown; lesson: { module: { title: string; position: number; coverPath: string | null } } }; student: { externalIdentities: Array<{ displayName: string | null; username: string | null }> }; reviewer: { id: string; email: string | null; externalIdentities: Array<{ displayName: string | null; username: string | null }> } | null; fileAttachments: Array<{ file: { id: string; originalName: string; mimeType: string; byteSize: number } }>; checkedRequirements?: Prisma.JsonValue }, attemptHistory: readonly QueueAttempt[], actorId: string) {
    const identity = submission.student.externalIdentities[0];
    const studentName = identity?.displayName ?? identity?.username ?? "Ученик";
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
      assignmentTitle: submission.assignment.title,
      requirements: getRequirements(submission.assignment.requirements as Prisma.JsonValue),
      module: `${String(submission.assignment.lesson.module.position).padStart(2, "0")} · ${submission.assignment.lesson.module.title}`,
      coverPath: submission.assignment.lesson.module.coverPath,
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
      })),
      reviewerId,
      reviewerName,
      // Lets the frontend disable "Принять/Вернуть на доработку" when someone else already
      // has this claimed — the server already rejects the decide()/claim() call in that
      // case, but the button used to stay clickable and just fail after a round trip.
      isReviewerSelf: reviewerId === null || reviewerId === actorId,
      claimedAt: submission.claimedAt,
      checkedRequirements: Array.isArray(submission.checkedRequirements) ? (submission.checkedRequirements as string[]) : null,
      progress: "—",
    };
  }
}

export const assignmentService = new AssignmentService();
