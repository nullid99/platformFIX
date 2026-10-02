import { Prisma } from "@/app/generated/prisma/client";
import {
  AssignmentStatus,
  EnrollmentStatus,
  MediaAssetKind,
  MediaAssetStatus,
  MediaAudience,
  ModuleAccessStatus,
  UserRole,
  UserStatus,
} from "@/app/generated/prisma/enums";
import { AuthServiceError } from "@/app/server/auth";
import { prisma } from "@/app/server/db";
import { activeStudentIds } from "@/app/server/notifications/recipient-service";
import { sendModuleOpenedNotification, sendNewMediaNotification } from "@/app/server/notifications/email-service";
import { notificationService } from "@/app/server/notifications/notification-service";
import { fileService } from "@/app/server/files";
import { deleteRecordingObjects } from "@/app/server/streams/livekit-client";
import { getWorkingPracticumId } from "./practicum-service";
import { isModuleOpenForStudent } from "./module-access";

type CourseAccess = {
  locked: boolean;
  progress: number;
  status: ModuleAccessStatus;
};

export type CreateVimeoMediaInput = {
  moduleId?: string;
  scheduleEventId?: string;
  // Which MediaGroup ("Бектест", "Пресессия"...) inside moduleId this belongs to — only
  // meaningful alongside moduleId, optional even then (falls back to "no block" for Практика
  // just like it always has for Теория, which never uses groups at all).
  groupId?: string;
  title: string;
  description?: string;
  kind: MediaAssetKind;
  audience?: MediaAudience;
  vimeoUrl: string;
};

export type CreateModuleInput = {
  title: string;
  description?: string;
  section?: string;
  coverPath?: string;
  // Initial named sections ("Бектест", "Пресессия"...) to create alongside the lesson — the
  // Программа page's block-picker step. Curator can still add/remove more later from the
  // lesson editor; this is just a convenience so the common ones don't need a second trip.
  mediaGroups?: string[];
};

export type UpdateModuleInput = { title: string; description?: string; qaQuestions?: string[] };
export type UpdateMediaClassificationInput = { kind: MediaAssetKind; audience?: MediaAudience; moduleId?: string; scheduleEventId?: string; groupId?: string };

function jsonStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeQaQuestions(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > 20) {
    throw new AuthServiceError("INVALID_INPUT", "qaQuestions are invalid");
  }
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.slice(0, 300));
}

/**
 * `assetId` is only used by the LIVEKIT_RECORDING branch: a presigned S3 URL expires and can only
 * be minted per-request, so this points the player at our own redirect route
 * (`GET /streams/recordings/:mediaId/play`, see streams.controller.ts) instead of embedding a
 * static URL the way the other providers do.
 */
function mediaEmbedUrl(provider: string, providerKey: string, assetId: string): string | null {
  if (provider.toUpperCase() === "VIMEO") {
    const match = /^(\d+)(?:\?h=([A-Za-z0-9]+))?$/.exec(providerKey);
    if (match?.[1]) {
      return `https://player.vimeo.com/video/${match[1]}${match[2] ? `?h=${encodeURIComponent(match[2])}` : ""}`;
    }
  }

  if (provider.toUpperCase() === "LIVEKIT_RECORDING") {
    return `/api/streams/recordings/${assetId}/play`;
  }

  return null;
}

/** BigInt doesn't survive JSON.stringify — every media DTO converts it to a plain number here (safe well past any realistic file size, unlike Postgres's own 2GB Int limit this column exists to avoid). */
function mediaByteSize(byteSize: bigint | null): number | null {
  return byteSize != null ? Number(byteSize) : null;
}

function mediaThumbnailUrl(provider: string, providerKey: string, assetId: string): string | null {
  if (provider.toUpperCase() === "VIMEO") {
    const videoId = providerKey.split("?", 1)[0];
    return /^\d+$/.test(videoId) ? `https://vumbnail.com/${videoId}.jpg` : null;
  }

  if (provider.toUpperCase() === "LIVEKIT_RECORDING") {
    return `/api/streams/recordings/${assetId}/thumbnail`;
  }

  return null;
}

function normalizeVimeoKey(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new AuthServiceError("INVALID_INPUT", "Vimeo URL is invalid");
  }

  if (!/(^|\.)vimeo\.com$/i.test(url.hostname)) {
    throw new AuthServiceError("INVALID_INPUT", "Vimeo URL is invalid");
  }

  const videoId = url.pathname.split("/").find((part) => /^\d+$/.test(part));
  if (!videoId) throw new AuthServiceError("INVALID_INPUT", "Vimeo video ID is missing");
  const privacyHash = url.searchParams.get("h");
  if (privacyHash && !/^[A-Za-z0-9]+$/.test(privacyHash)) {
    throw new AuthServiceError("INVALID_INPUT", "Vimeo privacy hash is invalid");
  }
  return privacyHash ? `${videoId}?h=${privacyHash}` : videoId;
}

function requiredText(value: string, field: string, maximumLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new AuthServiceError("INVALID_INPUT", `${field} is invalid`);
  }
  return normalized;
}

export class CourseService {
  public async getForCurator(userId: string, options?: { viewPracticumId?: string }) {
    await this.assertCurator(userId);
    return this.getForUser(userId, options);
  }

  public async createModule(actorId: string, input: CreateModuleInput) {
    await this.assertCurator(actorId);
    const title = requiredText(input.title, "title", 180);
    const description = input.description?.trim().slice(0, 5_000) || null;
    const section = ["Welcome", "Education", "Q&A", "Practice", "Advanced"].includes(input.section ?? "") ? input.section! : "Education";
    const coverPath = input.coverPath?.trim() || null;
    if (coverPath && (!coverPath.startsWith("/") || coverPath.length > 500)) {
      throw new AuthServiceError("INVALID_INPUT", "coverPath is invalid");
    }
    const practicumId = await getWorkingPracticumId(actorId);
    if (!practicumId) throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");
    const mediaGroupTitles = (input.mediaGroups ?? [])
      .map((groupTitle) => groupTitle.trim().slice(0, 80))
      .filter((groupTitle, index, all) => groupTitle.length > 0 && all.indexOf(groupTitle) === index)
      .slice(0, 12);

    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
        const lastModule = await tx.module.findFirst({ where: { practicumId }, orderBy: { position: "desc" }, select: { position: true } });
        const position = (lastModule?.position ?? -1) + 1;
        const courseModule = await tx.module.create({ data: { practicumId, title, description, section, coverPath, position } });
        const mediaGroups = [];
        for (const [groupPosition, groupTitle] of mediaGroupTitles.entries()) {
          mediaGroups.push(await tx.mediaGroup.create({ data: { moduleId: courseModule.id, title: groupTitle, position: groupPosition } }));
        }
        return {
          id: courseModule.id,
          number: String(position).padStart(2, "0"),
          position,
          section: courseModule.section,
          title: courseModule.title,
          description: courseModule.description,
          coverPath: courseModule.coverPath,
          locked: false,
          progress: 0,
          status: courseModule.defaultAccess,
          media: [],
          assignments: [],
          mediaGroups: mediaGroups.map((group) => ({ id: group.id, title: group.title, position: group.position, media: [] })),
        };
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("Unique constraint")) {
        throw new AuthServiceError("INVALID_INPUT", "Module position conflict, please retry");
      }
      throw error;
    }
    // No notification on creation (2026-10-02): a new lesson is always closed, and nothing inside
    // a closed lesson is announced. Students hear about it once the curator opens it — see
    // setModuleAccess ("Урок открыт" email + bell).
    return created;
  }

  /**
   * The module-wide "open/close for everyone" toggle. This is the one place that writes
   * Module.defaultAccess — the source of truth a newly-enrolling student inherits from
   * (see auth-service.ts's invitation acceptance) and what the curator's admin screen
   * reports. Students a curator individually overrode (setStudentModuleAccess) are
   * deliberately skipped here, same as anyone who already completed the module.
   */
  public async setModuleAccess(actorId: string, moduleId: string, unlocked: boolean) {
    await this.assertCurator(actorId);
    const courseModule = await prisma.module.findUnique({ where: { id: moduleId }, select: { id: true, practicumId: true, title: true, section: true } });
    if (!courseModule) throw new AuthServiceError("INVALID_INPUT", "Module does not exist");
    const now = new Date();
    const newlyOpenedStudentIds: string[] = [];
    const result = await prisma.$transaction(async (tx) => {
      await tx.module.update({ where: { id: moduleId }, data: { defaultAccess: unlocked ? ModuleAccessStatus.UNLOCKED : ModuleAccessStatus.LOCKED } });
      const enrollments = await tx.enrollment.findMany({ where: { practicumId: courseModule.practicumId, status: EnrollmentStatus.ACTIVE, OR: [{ accessUntil: null }, { accessUntil: { gt: now } }] }, select: { id: true, studentId: true, student: { select: { isAdvanced: true } } } });
      let affected = 0;
      for (const enrollment of enrollments) {
        // A non-Advanced student's access row still gets written (harmless — getForUser filters
        // the whole module out for them regardless of this row) but they're never added to the
        // notified list, so "Открыт урок: <Advanced lesson>" never reaches someone who can't
        // actually see it.
        const canSeeThisModule = courseModule.section !== "Advanced" || enrollment.student.isAdvanced;
        const existing = await tx.enrollmentModuleAccess.findUnique({ where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId } }, select: { status: true, isOverride: true } });
        if (existing?.isOverride || existing?.status === ModuleAccessStatus.COMPLETED) continue;
        if (!existing) {
          await tx.enrollmentModuleAccess.create({ data: { enrollmentId: enrollment.id, moduleId, status: unlocked ? ModuleAccessStatus.UNLOCKED : ModuleAccessStatus.LOCKED, unlockedAt: unlocked ? now : null } });
          affected += 1;
          if (unlocked && canSeeThisModule) newlyOpenedStudentIds.push(enrollment.studentId);
        } else if (unlocked && existing.status === ModuleAccessStatus.LOCKED) {
          await tx.enrollmentModuleAccess.update({ where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId } }, data: { status: ModuleAccessStatus.UNLOCKED, unlockedAt: now } });
          affected += 1;
          if (canSeeThisModule) newlyOpenedStudentIds.push(enrollment.studentId);
        } else if (!unlocked && existing.status === ModuleAccessStatus.UNLOCKED) {
          await tx.enrollmentModuleAccess.update({ where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId } }, data: { status: ModuleAccessStatus.LOCKED, unlockedAt: null } });
          affected += 1;
        }
      }
      return { moduleId, unlocked, affectedEnrollments: affected };
    });
    if (newlyOpenedStudentIds.length > 0) {
      void notificationService.createMany(newlyOpenedStudentIds, "MODULE_OPENED", `Открыт урок: ${courseModule.title}`, undefined, moduleId)
        .catch((error: unknown) => console.error("Module-opened notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
      void this.emailModuleOpened(newlyOpenedStudentIds, courseModule.title, moduleId);
    }
    return result;
  }

  /** "Урок открыт" email — the one email about a lesson; nothing is mailed while it's closed. */
  private async emailModuleOpened(studentIds: readonly string[], moduleTitle: string, moduleId: string): Promise<void> {
    try {
      const recipients = await prisma.user.findMany({ where: { id: { in: [...studentIds] }, email: { not: null } }, select: { email: true } });
      await Promise.all(recipients.map((recipient) => recipient.email && sendModuleOpenedNotification({ to: recipient.email, moduleTitle, moduleId })));
    } catch (error) {
      console.error("Module-opened email dispatch failed", error instanceof Error ? error.message : "unknown error");
    }
  }

  /**
   * Opens or closes one module for exactly one student, independent of the module's
   * defaultAccess — e.g. early access ahead of the cohort, or holding one student back.
   * Marked isOverride so the module-wide toggle above never silently reverts it.
   */
  public async setStudentModuleAccess(actorId: string, studentId: string, moduleId: string, unlocked: boolean) {
    await this.assertCurator(actorId);
    const courseModule = await prisma.module.findUnique({ where: { id: moduleId }, select: { id: true, practicumId: true, title: true } });
    if (!courseModule) throw new AuthServiceError("INVALID_INPUT", "Module does not exist");
    const enrollment = await prisma.enrollment.findFirst({
      where: { studentId, practicumId: courseModule.practicumId, status: EnrollmentStatus.ACTIVE },
      select: { id: true },
    });
    if (!enrollment) throw new AuthServiceError("INVALID_INPUT", "Student is not enrolled in this practicum");
    const now = new Date();
    const previous = await prisma.enrollmentModuleAccess.findUnique({ where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId } }, select: { status: true } });
    const wasOpen = previous?.status === ModuleAccessStatus.UNLOCKED || previous?.status === ModuleAccessStatus.COMPLETED;
    const access = await prisma.enrollmentModuleAccess.upsert({
      where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId } },
      update: { status: unlocked ? ModuleAccessStatus.UNLOCKED : ModuleAccessStatus.LOCKED, unlockedAt: unlocked ? now : null, isOverride: true },
      create: { enrollmentId: enrollment.id, moduleId, status: unlocked ? ModuleAccessStatus.UNLOCKED : ModuleAccessStatus.LOCKED, unlockedAt: unlocked ? now : null, isOverride: true },
      select: { status: true, isOverride: true },
    });
    if (unlocked && !wasOpen) {
      void notificationService.create(studentId, "MODULE_OPENED", `Открыт урок: ${courseModule.title}`, undefined, moduleId)
        .catch((error: unknown) => console.error("Module-opened notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
      void this.emailModuleOpened([studentId], courseModule.title, moduleId);
    }
    return { moduleId, studentId, status: access.status, isOverride: access.isOverride };
  }

  /**
   * Marks a module COMPLETED for one student and opens the content of the next module by
   * position — an assignment inside that next module still stays gated until IT is marked
   * completed too (see assignment-service.ts#submit). Called several ways: a curator's
   * explicit "Урок пройден" click for this one student, or automatically from
   * assignment-service.ts once every assignment in the module has been accepted for this
   * student — either a curator's #decide, or the student's own no-review #completeWithoutReview
   * (a module with no assignments, or one still missing an accepted submission, only completes
   * via the manual click).
   */
  public async markModuleCompletedForStudent(actorId: string, studentId: string, moduleId: string) {
    await this.assertCurator(actorId);
    return this.completeModuleForStudent(studentId, moduleId);
  }

  /**
   * The actual completion logic behind markModuleCompletedForStudent, without its curator
   * permission check — for the automatic triggers that aren't a curator's own click: a
   * curator accepting the last ungraded submission in a module (assignment-service.ts#decide)
   * and a student's own "Выполнено" click on a no-review assignment
   * (assignment-service.ts#completeWithoutReview). Both already know there's no curator actor
   * to check.
   */
  public async completeModuleForStudent(studentId: string, moduleId: string) {
    const courseModule = await prisma.module.findUnique({ where: { id: moduleId }, select: { id: true, practicumId: true, position: true } });
    if (!courseModule) throw new AuthServiceError("INVALID_INPUT", "Module does not exist");
    const enrollment = await prisma.enrollment.findFirst({
      where: { studentId, practicumId: courseModule.practicumId, status: EnrollmentStatus.ACTIVE },
      select: { id: true, student: { select: { isAdvanced: true } } },
    });
    if (!enrollment) throw new AuthServiceError("INVALID_INPUT", "Student is not enrolled in this practicum");
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      await tx.enrollmentModuleAccess.upsert({
        where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId } },
        update: { status: ModuleAccessStatus.COMPLETED, progress: 100, completedAt: now },
        create: { enrollmentId: enrollment.id, moduleId, status: ModuleAccessStatus.COMPLETED, progress: 100, unlockedAt: now, completedAt: now },
      });
      // "Next by position" skips over any Advanced module this student can't see — the shared
      // position sequence (Theory/Practice interleave on it too, see Module.position) otherwise
      // has no notion of the Advanced gate, and auto-unlocking + notifying about a module whose
      // very existence is meant to stay invisible would leak both. take: 50 bounds this to one
      // query in the realistic case of a handful of consecutive Advanced lessons.
      const subsequentModules = await tx.module.findMany({ where: { practicumId: courseModule.practicumId, position: { gt: courseModule.position } }, orderBy: { position: "asc" }, select: { id: true, title: true, section: true, defaultAccess: true }, take: 50 });
      const nextModule = subsequentModules.find((candidate) => candidate.section !== "Advanced" || enrollment.student.isAdvanced) ?? null;
      let nextModuleId: string | null = null;
      let nextModuleTitle: string | null = null;
      // Finishing a lesson never opens one the curator still has "Закрыт" in "Программа" (reported
      // 2026-10-02: a student's own "Выполнено" opened Market Logic ahead of schedule). Lessons
      // are opened by the curator for the whole поток; this only heals a missing/LOCKED row for a
      // lesson that's already open to everyone.
      if (nextModule && nextModule.defaultAccess === ModuleAccessStatus.UNLOCKED) {
        // Skips a next-module row the curator already set by hand (isOverride) — completing
        // the previous module shouldn't silently reopen something they deliberately closed.
        const existingNext = await tx.enrollmentModuleAccess.findUnique({ where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId: nextModule.id } }, select: { isOverride: true, status: true } });
        if (!existingNext) {
          await tx.enrollmentModuleAccess.create({ data: { enrollmentId: enrollment.id, moduleId: nextModule.id, status: ModuleAccessStatus.UNLOCKED, unlockedAt: now } });
          nextModuleId = nextModule.id;
          nextModuleTitle = nextModule.title;
        } else if (!existingNext.isOverride && existingNext.status === ModuleAccessStatus.LOCKED) {
          await tx.enrollmentModuleAccess.update({ where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId: nextModule.id } }, data: { status: ModuleAccessStatus.UNLOCKED, unlockedAt: now } });
          nextModuleId = nextModule.id;
          nextModuleTitle = nextModule.title;
        }
      }
      return { moduleId, studentId, status: ModuleAccessStatus.COMPLETED, nextModuleUnlocked: nextModuleId, nextModuleTitle };
    });
    if (result.nextModuleUnlocked) {
      void notificationService.create(studentId, "MODULE_OPENED", `Открыт урок: ${result.nextModuleTitle}`, undefined, result.nextModuleUnlocked)
        .catch((error: unknown) => console.error("Module-opened notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
    }
    return result;
  }

  /**
   * Bulk version of markModuleCompletedForStudent, for the module-wide "Программа" panel —
   * marks this module COMPLETED for every actively-enrolled student who isn't already
   * completed and unlocks the next module for each, so the curator doesn't have to open
   * every student's page one by one. Same next-module-override guard as the per-student call.
   */
  public async markModuleCompletedForAllStudents(actorId: string, moduleId: string) {
    await this.assertCurator(actorId);
    const courseModule = await prisma.module.findUnique({ where: { id: moduleId }, select: { id: true, practicumId: true, position: true } });
    if (!courseModule) throw new AuthServiceError("INVALID_INPUT", "Module does not exist");
    const now = new Date();
    const enrollments = await prisma.enrollment.findMany({ where: { practicumId: courseModule.practicumId, status: EnrollmentStatus.ACTIVE }, select: { id: true, studentId: true, student: { select: { isAdvanced: true } } } });
    // Same "skip an Advanced module this student can't see" rule as markModuleCompletedForStudent
    // — but here it has to be resolved per student, since which module counts as "next" now
    // depends on each student's own isAdvanced flag, not one shared answer for the whole cohort.
    const subsequentModules = await prisma.module.findMany({ where: { practicumId: courseModule.practicumId, position: { gt: courseModule.position } }, orderBy: { position: "asc" }, select: { id: true, title: true, section: true, defaultAccess: true }, take: 50 });
    // Same "never open a lesson the curator still has closed" rule as completeModuleForStudent.
    const nextModuleFor = (isAdvancedStudent: boolean) => {
      const candidate = subsequentModules.find((module) => module.section !== "Advanced" || isAdvancedStudent) ?? null;
      return candidate && candidate.defaultAccess === ModuleAccessStatus.UNLOCKED ? candidate : null;
    };

    let completedCount = 0;
    const newlyOpenedStudentIdsByModule = new Map<string, { title: string; studentIds: string[] }>();
    await prisma.$transaction(async (tx) => {
      for (const enrollment of enrollments) {
        const existing = await tx.enrollmentModuleAccess.findUnique({ where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId } }, select: { status: true } });
        if (existing?.status === ModuleAccessStatus.COMPLETED) continue;
        await tx.enrollmentModuleAccess.upsert({
          where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId } },
          update: { status: ModuleAccessStatus.COMPLETED, progress: 100, completedAt: now },
          create: { enrollmentId: enrollment.id, moduleId, status: ModuleAccessStatus.COMPLETED, progress: 100, unlockedAt: now, completedAt: now },
        });
        completedCount += 1;

        const nextModule = nextModuleFor(enrollment.student.isAdvanced);
        if (nextModule) {
          const existingNext = await tx.enrollmentModuleAccess.findUnique({ where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId: nextModule.id } }, select: { isOverride: true, status: true } });
          const opened = !existingNext || (!existingNext.isOverride && existingNext.status === ModuleAccessStatus.LOCKED);
          if (!existingNext) {
            await tx.enrollmentModuleAccess.create({ data: { enrollmentId: enrollment.id, moduleId: nextModule.id, status: ModuleAccessStatus.UNLOCKED, unlockedAt: now } });
          } else if (!existingNext.isOverride && existingNext.status === ModuleAccessStatus.LOCKED) {
            await tx.enrollmentModuleAccess.update({ where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId: nextModule.id } }, data: { status: ModuleAccessStatus.UNLOCKED, unlockedAt: now } });
          }
          if (opened) {
            const group = newlyOpenedStudentIdsByModule.get(nextModule.id) ?? { title: nextModule.title, studentIds: [] };
            group.studentIds.push(enrollment.studentId);
            newlyOpenedStudentIdsByModule.set(nextModule.id, group);
          }
        }
      }
    });
    if (newlyOpenedStudentIdsByModule.size > 0) {
      void Promise.all([...newlyOpenedStudentIdsByModule.entries()].map(([nextModuleId, group]) =>
        notificationService.createMany(group.studentIds, "MODULE_OPENED", `Открыт урок: ${group.title}`, undefined, nextModuleId),
      )).catch((error: unknown) => console.error("Module-opened notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
    }
    // Reported back to the curator's confirm-dialog summary as "which lesson opens next" —
    // there may now be more than one answer, but the primary (non-Advanced) case still has
    // exactly one, so report the module every non-Advanced student would see.
    const primaryNextModule = nextModuleFor(false);
    return { moduleId, completedCount, totalEnrollments: enrollments.length, nextModuleId: primaryNextModule?.id ?? null };
  }

  /** Every module's access state for one specific student — the data behind the per-student override panel on the curator's "Ученики" page. */
  public async listStudentModuleAccess(actorId: string, studentId: string) {
    await this.assertCurator(actorId);
    const enrollment = await prisma.enrollment.findFirst({
      where: { studentId, status: EnrollmentStatus.ACTIVE },
      orderBy: { createdAt: "asc" },
      select: { id: true, practicumId: true },
    });
    if (!enrollment) throw new AuthServiceError("INVALID_INPUT", "Student is not enrolled in a practicum");
    const modules = await prisma.module.findMany({
      where: { practicumId: enrollment.practicumId },
      orderBy: { position: "asc" },
      select: {
        id: true,
        title: true,
        position: true,
        defaultAccess: true,
        accessRecords: { where: { enrollmentId: enrollment.id }, take: 1, select: { status: true, isOverride: true } },
      },
    });
    return modules.map((courseModule) => {
      const access = courseModule.accessRecords[0];
      return {
        moduleId: courseModule.id,
        title: courseModule.title,
        number: String(courseModule.position).padStart(2, "0"),
        defaultAccess: courseModule.defaultAccess,
        status: access?.status ?? ModuleAccessStatus.LOCKED,
        isOverride: access?.isOverride ?? false,
      };
    });
  }

  public async getForUser(userId: string, options?: { viewPracticumId?: string }) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, status: true, isAdvanced: true },
    });

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new AuthServiceError("SESSION_INVALID", "User is not active");
    }
    // Curator/owner (getForCurator delegates straight into this method) always sees everything,
    // same as every other status filter in this method — isAdvanced is a student-only gate.
    const canSeeAdvanced = user.role !== UserRole.STUDENT || user.isAdvanced;

    const enrollment = user.role === UserRole.STUDENT
      ? await prisma.enrollment.findFirst({
        where: {
          studentId: userId,
          status: EnrollmentStatus.ACTIVE,
          OR: [{ accessUntil: null }, { accessUntil: { gt: new Date() } }],
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, practicumId: true },
      })
      : null;

    if (user.role === UserRole.STUDENT && !enrollment) {
      throw new AuthServiceError("FORBIDDEN", "Student is not enrolled in a practicum");
    }

    // Staff-only "просмотр архива": browse a specific (typically non-active) practicum's
    // content read-only, without touching which one is active — see practicum-service.ts and
    // the "Потоки" card. Ignored for a student session, so a stray/forged query param can't
    // redirect a student's own dashboard this way.
    let practicumId = enrollment?.practicumId ?? (await getWorkingPracticumId(userId));
    if (options?.viewPracticumId && (user.role === UserRole.OWNER || user.role === UserRole.CURATOR)) {
      const viewed = await prisma.practicum.findUnique({ where: { id: options.viewPracticumId }, select: { id: true } });
      if (!viewed) throw new AuthServiceError("INVALID_INPUT", "Practicum does not exist");
      practicumId = viewed.id;
    }

    if (!practicumId) {
      throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");
    }

    const practicum = await prisma.practicum.findUnique({
      where: { id: practicumId },
      include: {
        // moduleId/scheduleEventId both null — truly unassigned (Talks, or a stream nobody
        // targeted). Anything with a scheduleEventId is already surfaced under that event's own
        // `recordings` below; including it here too would list the same MediaAsset twice.
        mediaAssets: {
          where: user.role === UserRole.STUDENT
            ? { status: MediaAssetStatus.PUBLISHED, moduleId: null, scheduleEventId: null }
            : { status: { not: MediaAssetStatus.ARCHIVED }, moduleId: null, scheduleEventId: null },
          orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        },
        scheduleEvents: {
          orderBy: [{ date: "asc" }, { createdAt: "asc" }],
          include: {
            mediaAssets: {
              where: user.role === UserRole.STUDENT
                ? { status: MediaAssetStatus.PUBLISHED }
                : { status: { not: MediaAssetStatus.ARCHIVED } },
              orderBy: [{ position: "asc" }, { createdAt: "asc" }],
            },
          },
        },
        modules: {
          orderBy: { position: "asc" },
          include: {
            mediaAssets: {
              where: user.role === UserRole.STUDENT
                ? { status: MediaAssetStatus.PUBLISHED }
                : { status: { not: MediaAssetStatus.ARCHIVED } },
              orderBy: [{ position: "asc" }, { createdAt: "asc" }],
            },
            assignments: {
              where: user.role === UserRole.STUDENT
                ? { status: AssignmentStatus.PUBLISHED }
                : { status: { not: AssignmentStatus.ARCHIVED } },
              orderBy: { createdAt: "asc" },
              include: { materials: { orderBy: { position: "asc" } } },
            },
            // Only the current student's own row is ever needed — a curator/owner has no
            // enrollment of their own, so this resolves to zero rows for them; their view
            // of "is this open" comes from Module.defaultAccess below instead.
            accessRecords: { where: { enrollmentId: enrollment?.id ?? "__no-enrollment__" }, take: 1 },
            mediaGroups: {
              orderBy: { position: "asc" },
              include: {
                mediaAssets: {
                  where: user.role === UserRole.STUDENT
                    ? { status: MediaAssetStatus.PUBLISHED }
                    : { status: { not: MediaAssetStatus.ARCHIVED } },
                  orderBy: [{ position: "asc" }, { createdAt: "asc" }],
                },
              },
            },
          },
        },
      },
    });

    if (!practicum) {
      throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");
    }

    return {
      id: practicum.id,
      title: practicum.title,
      description: practicum.description,
      // Gates the student-facing "Advanced" track tab and the two Advanced filter chips in
      // "Записи" — see CourseView and StreamsView. Always true for curator/owner.
      isAdvanced: canSeeAdvanced,
      // "Завершить поток" — read access (modules, media, ДЗ below) stays exactly as-is; the
      // frontend uses this only to hide the ДЗ submission form/"Выполнено" button and the
      // discussion compose box. Always false for curator/owner (they're never blocked).
      practicumCompleted: user.role === UserRole.STUDENT && Boolean(practicum.completedAt),
      media: practicum.mediaAssets
        .filter((asset) => canSeeAdvanced || asset.audience !== MediaAudience.ADVANCED)
        .map((asset) => ({
          id: asset.id,
          scheduleEventId: asset.scheduleEventId,
          provider: asset.provider,
          kind: asset.kind,
          audience: asset.audience,
          status: asset.status,
          title: asset.title,
          description: asset.description,
          durationSec: asset.durationSec,
          byteSize: mediaByteSize(asset.byteSize),
          position: asset.position,
          libraryPosition: asset.libraryPosition,
          publishedAt: asset.publishedAt,
          createdAt: asset.createdAt,
          embedUrl: mediaEmbedUrl(asset.provider, asset.providerKey, asset.id),
          thumbnailUrl: mediaThumbnailUrl(asset.provider, asset.providerKey, asset.id),
        })),
      scheduleEvents: practicum.scheduleEvents.map((event) => {
        // A schedule-event recording can be tagged Advanced too (same publish form, same rule as
        // module-attached and unattached media) — filtered before recordingAvailable is derived,
        // so an Advanced-only recording doesn't show a misleading "recording available" badge to
        // a student who then finds no actual recording behind it.
        const visibleRecordings = canSeeAdvanced ? event.mediaAssets : event.mediaAssets.filter((asset) => asset.audience !== MediaAudience.ADVANCED);
        return {
        id: event.id,
        type: event.type,
        title: event.title,
        date: event.date.toISOString().slice(0, 10),
        time: event.time,
        description: event.description,
        live: event.live,
        coverPath: event.coverPath,
        streamEndedAt: event.streamEndedAt ? event.streamEndedAt.toISOString() : null,
        recordingAvailable: visibleRecordings.some((asset) => asset.status === MediaAssetStatus.PUBLISHED),
        recordings: visibleRecordings.map((asset) => ({
          id: asset.id,
          scheduleEventId: event.id,
          provider: asset.provider,
          kind: asset.kind,
          audience: asset.audience,
          title: asset.title,
          description: asset.description,
          durationSec: asset.durationSec,
          byteSize: mediaByteSize(asset.byteSize),
          position: asset.position,
          libraryPosition: asset.libraryPosition,
          status: asset.status,
          publishedAt: asset.publishedAt,
          createdAt: asset.createdAt,
          embedUrl: mediaEmbedUrl(asset.provider, asset.providerKey, asset.id),
          thumbnailUrl: mediaThumbnailUrl(asset.provider, asset.providerKey, asset.id),
        })),
        };
      }),
      modules: practicum.modules
        // A Theory/Practice/Q&A/Welcome module can still hold one Advanced-only recording (see
        // the mapMediaAsset filter below) without gating the whole lesson — only a module whose
        // entire SECTION is "Advanced" is hidden here.
        .filter((module) => canSeeAdvanced || module.section !== "Advanced")
        .map((module) => {
        const access = this.getModuleAccess(module.accessRecords[0], user.role, module.defaultAccess);
        const mapMediaAsset = (asset: (typeof module.mediaAssets)[number]) => ({
          id: asset.id,
          scheduleEventId: asset.scheduleEventId,
          groupId: asset.groupId,
          provider: asset.provider,
          kind: asset.kind,
          audience: asset.audience,
          status: asset.status,
          title: asset.title,
          description: asset.description,
          durationSec: asset.durationSec,
          byteSize: mediaByteSize(asset.byteSize),
          position: asset.position,
          libraryPosition: asset.libraryPosition,
          publishedAt: asset.publishedAt,
          createdAt: asset.createdAt,
          embedUrl: mediaEmbedUrl(asset.provider, asset.providerKey, asset.id),
          thumbnailUrl: mediaThumbnailUrl(asset.provider, asset.providerKey, asset.id),
        });
        const visibleMediaAssets = canSeeAdvanced ? module.mediaAssets : module.mediaAssets.filter((asset) => asset.audience !== MediaAudience.ADVANCED);
        const media = access.locked ? [] : visibleMediaAssets.map(mapMediaAsset);
        const mediaGroups = access.locked
          ? []
          : module.mediaGroups.map((group) => ({ id: group.id, title: group.title, position: group.position, media: (canSeeAdvanced ? group.mediaAssets : group.mediaAssets.filter((asset) => asset.audience !== MediaAudience.ADVANCED)).map(mapMediaAsset) }));
        const assignments = access.locked
          ? []
          : module.assignments.map((assignment) => ({
            id: assignment.id,
            title: assignment.title,
            description: assignment.description,
            requirements: jsonStrings(assignment.requirements),
            allowedFormats: jsonStrings(assignment.allowedFormats),
            deadline: assignment.deadline,
            materials: assignment.materials.map((material) => ({
              id: material.id,
              kind: material.kind,
              title: material.title,
              url: material.kind === "FILE" && material.fileId ? `/api/files/${material.fileId}/content` : material.url,
              mimeType: material.mimeType,
              byteSize: material.byteSize,
            })),
          }));

        return {
          id: module.id,
          number: String(module.position).padStart(2, "0"),
          position: module.position,
          section: module.section,
          title: module.title,
          description: module.description,
          coverPath: module.coverPath,
          locked: access.locked,
          progress: access.progress,
          status: access.status,
          media,
          mediaGroups,
          assignments,
          qaQuestions: jsonStrings(module.qaQuestions),
        };
      }),
    };
  }

  public async createVimeoMedia(actorId: string, input: CreateVimeoMediaInput) {
    await this.assertCurator(actorId);
    const moduleId = input.moduleId ? requiredText(input.moduleId, "moduleId", 100) : undefined;
    const scheduleEventId = input.scheduleEventId ? requiredText(input.scheduleEventId, "scheduleEventId", 100) : undefined;
    const groupId = input.groupId ? requiredText(input.groupId, "groupId", 100) : undefined;
    if (input.kind !== MediaAssetKind.TALKS && !moduleId && !scheduleEventId) throw new AuthServiceError("INVALID_INPUT", "moduleId or scheduleEventId is required for this media type");
    const title = requiredText(input.title, "title", 180);
    const description = input.description?.trim().slice(0, 2_000) || undefined;
    const providerKey = normalizeVimeoKey(input.vimeoUrl);
    const courseModule = moduleId
      ? await prisma.module.findUnique({ where: { id: moduleId }, select: { id: true, practicumId: true } })
      : null;
    if (moduleId && !courseModule) throw new AuthServiceError("INVALID_INPUT", "Module does not exist");
    if (groupId) {
      if (!moduleId) throw new AuthServiceError("INVALID_INPUT", "groupId requires moduleId");
      const group = await prisma.mediaGroup.findUnique({ where: { id: groupId }, select: { moduleId: true } });
      if (!group || group.moduleId !== moduleId) throw new AuthServiceError("INVALID_INPUT", "Block does not belong to this lesson");
    }
    const scheduleEvent = scheduleEventId ? await prisma.scheduleEvent.findUnique({ where: { id: scheduleEventId }, select: { id: true, practicumId: true } }) : null;
    if (scheduleEventId && !scheduleEvent) throw new AuthServiceError("INVALID_INPUT", "Schedule event does not exist");
    if (courseModule && scheduleEvent && courseModule.practicumId !== scheduleEvent.practicumId) throw new AuthServiceError("INVALID_INPUT", "Module and event belong to different practicums");
    const practicumId = courseModule?.practicumId ?? scheduleEvent?.practicumId ?? (await getWorkingPracticumId(actorId));
    if (!practicumId) throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");

    const lastMedia = await prisma.mediaAsset.findFirst({
      where: groupId ? { groupId } : scheduleEventId ? { scheduleEventId } : moduleId ? { moduleId, groupId: null } : { practicumId, moduleId: null, scheduleEventId: null },
      orderBy: { position: "desc" },
      select: { position: true },
    });

    const data = {
      practicumId,
      moduleId,
      scheduleEventId,
      groupId,
      provider: "VIMEO",
      providerKey,
      kind: input.kind,
      audience: input.audience === MediaAudience.ADVANCED ? MediaAudience.ADVANCED : MediaAudience.ALL,
      status: MediaAssetStatus.DRAFT,
      title,
      description,
      position: (lastMedia?.position ?? -1) + 1,
    };

    // "Удалить" only archives (archiveMedia keeps the row for view history/audit), but the
    // (provider, providerKey, moduleId) unique index still counts that archived row — so
    // re-adding the same Vimeo video to the same lesson after deleting it used to fail as a
    // "duplicate". Revive the archived row with the new form values instead of inserting.
    // Without a moduleId the index never collides (Postgres treats NULLs as distinct).
    const archivedTwin = moduleId
      ? await prisma.mediaAsset.findFirst({ where: { provider: "VIMEO", providerKey, moduleId, status: MediaAssetStatus.ARCHIVED }, select: { id: true } })
      : null;

    const media = await (archivedTwin
      ? prisma.mediaAsset.update({ where: { id: archivedTwin.id }, data: { ...data, groupId: groupId ?? null, scheduleEventId: scheduleEventId ?? null, description: description ?? null, publishedAt: null } })
      : prisma.mediaAsset.create({ data })
    ).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("Unique constraint")) {
        throw new AuthServiceError("INVALID_INPUT", "Это видео уже добавлено в этот урок");
      }
      throw error;
    });

    return this.toMediaDto(media);
  }

  /** Curator-only. Appends a new named block ("Бектест", "Пресессия"...) at the end of a lesson —
   * either from the "Программа" creation step or later from inside the lesson editor. */
  public async createMediaGroup(actorId: string, moduleId: string, title: string) {
    await this.assertCurator(actorId);
    const normalizedModuleId = requiredText(moduleId, "moduleId", 100);
    const normalizedTitle = requiredText(title, "title", 80);
    const courseModule = await prisma.module.findUnique({ where: { id: normalizedModuleId }, select: { id: true } });
    if (!courseModule) throw new AuthServiceError("INVALID_INPUT", "Module does not exist");
    const lastGroup = await prisma.mediaGroup.findFirst({ where: { moduleId: normalizedModuleId }, orderBy: { position: "desc" }, select: { position: true } });
    const group = await prisma.mediaGroup.create({ data: { moduleId: normalizedModuleId, title: normalizedTitle, position: (lastGroup?.position ?? -1) + 1 } });
    return { id: group.id, title: group.title, position: group.position, media: [] };
  }

  /** Curator-only. Its recordings aren't deleted — MediaAsset.groupId just falls back to null
   * (see the schema's onDelete: SetNull), same as deleting a Module never deletes its media. */
  public async deleteMediaGroup(actorId: string, groupId: string) {
    await this.assertCurator(actorId);
    const normalizedGroupId = requiredText(groupId, "groupId", 100);
    await prisma.mediaGroup.delete({ where: { id: normalizedGroupId } }).catch(() => {
      throw new AuthServiceError("INVALID_INPUT", "Block does not exist");
    });
    return { id: normalizedGroupId };
  }

  public async updateModule(actorId: string, moduleId: string, input: UpdateModuleInput) {
    await this.assertCurator(actorId);
    const title = requiredText(input.title, "title", 180);
    const description = input.description?.trim().slice(0, 5_000) || null;
    const data: Prisma.ModuleUpdateInput = { title, description };
    if (input.qaQuestions !== undefined) data.qaQuestions = normalizeQaQuestions(input.qaQuestions) as Prisma.InputJsonValue;
    return prisma.module.update({ where: { id: moduleId }, data, select: { id: true, title: true, description: true, qaQuestions: true } }).catch(() => {
      throw new AuthServiceError("INVALID_INPUT", "Module does not exist");
    });
  }

  public async deleteModule(actorId: string, moduleId: string) {
    await this.assertCurator(actorId);
    const normalizedModuleId = requiredText(moduleId, "moduleId", 100);
    const courseModule = await prisma.module.findUnique({
      where: { id: normalizedModuleId },
      select: { id: true, title: true, coverPath: true },
    });
    if (!courseModule) throw new AuthServiceError("INVALID_INPUT", "Module does not exist");

    // A hard delete must never remove student work. Draft/published assignments
    // without submissions are safe to remove together with their module.
    const submissionCount = await prisma.submission.count({
      where: { assignment: { moduleId: normalizedModuleId } },
    });
    if (submissionCount > 0) {
      throw new AuthServiceError("INVALID_INPUT", "Нельзя удалить блок: в его заданиях уже есть работы учеников");
    }

    await prisma.$transaction(async (tx) => {
      await tx.module.delete({ where: { id: normalizedModuleId } });
      await tx.auditLog.create({
        data: {
          actorId,
          action: "MODULE_DELETED",
          objectType: "MODULE",
          objectId: normalizedModuleId,
          metadata: { title: courseModule.title },
        },
      });
    });

    const coverFileId = courseModule.coverPath?.match(/^\/api\/files\/([^/]+)\/content$/)?.[1];
    if (coverFileId) await fileService.cleanupModuleCover(coverFileId, normalizedModuleId);
    return { id: normalizedModuleId, title: courseModule.title };
  }

  public async reorderModuleMedia(actorId: string, moduleId: string, mediaIds: string[]) {
    await this.assertCurator(actorId);
    const normalizedModuleId = requiredText(moduleId, "moduleId", 100);
    if (mediaIds.length > 100 || new Set(mediaIds).size !== mediaIds.length || mediaIds.some((id) => !id.trim() || id.length > 100)) {
      throw new AuthServiceError("INVALID_INPUT", "mediaIds is invalid");
    }

    const existing = await prisma.mediaAsset.findMany({ where: { moduleId: normalizedModuleId }, select: { id: true } });
    const existingIds = new Set(existing.map((media) => media.id));
    if (existingIds.size !== mediaIds.length || mediaIds.some((id) => !existingIds.has(id))) {
      throw new AuthServiceError("INVALID_INPUT", "Media does not belong to this module");
    }

    await prisma.$transaction(mediaIds.map((id, position) => prisma.mediaAsset.update({ where: { id }, data: { position } })));
    return { moduleId: normalizedModuleId, mediaIds };
  }

  /**
   * Manual order for the practicum-wide "Медиатека" overview (CuratorMediaLibraryView's "newest
   * first" / "manual" toggle) — separate from reorderModuleMedia above, since that list mixes
   * module-attached, schedule-event-attached, and unattached media that each already have their
   * own `position` sequence for a different purpose. Doesn't require the full set like
   * reorderModuleMedia does (the overview list is large and status-filtered on read, so an exact
   * match would be fragile) — just checks every given id actually belongs to this practicum.
   */
  public async reorderMediaLibrary(actorId: string, mediaIds: string[]) {
    await this.assertCurator(actorId);
    if (mediaIds.length === 0 || mediaIds.length > 300 || new Set(mediaIds).size !== mediaIds.length || mediaIds.some((id) => !id.trim() || id.length > 100)) {
      throw new AuthServiceError("INVALID_INPUT", "mediaIds is invalid");
    }

    const practicumId = await getWorkingPracticumId(actorId);
    if (!practicumId) throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");

    const owned = await prisma.mediaAsset.count({ where: { id: { in: mediaIds }, practicumId } });
    if (owned !== mediaIds.length) throw new AuthServiceError("INVALID_INPUT", "Media does not belong to this practicum");

    await prisma.$transaction(mediaIds.map((id, libraryPosition) => prisma.mediaAsset.update({ where: { id }, data: { libraryPosition } })));
    return { mediaIds };
  }

  public async publishMedia(actorId: string, mediaId: string) {
    await this.assertCurator(actorId);
    const existing = await prisma.mediaAsset.findUnique({ where: { id: mediaId }, select: { status: true } });
    if (!existing) throw new AuthServiceError("INVALID_INPUT", "Media does not exist");
    const media = await prisma.mediaAsset.update({
      where: { id: mediaId },
      data: { status: MediaAssetStatus.PUBLISHED, publishedAt: new Date() },
      include: {
        module: { select: { practicumId: true } },
        scheduleEvent: { select: { practicumId: true } },
      },
    }).catch(() => null);
    if (!media) throw new AuthServiceError("INVALID_INPUT", "Media does not exist");
    if (existing.status !== MediaAssetStatus.PUBLISHED) {
      const practicumId = media.module?.practicumId ?? media.scheduleEvent?.practicumId ?? media.practicumId;
      const moduleId = media.moduleId;
      // Gated the same way as NEW_ASSIGNMENT: a recording published into a module a student
      // hasn't unlocked yet must not tell them about it before it's actually visible to them —
      // that mismatch (notification arrives, item isn't in the list) was the reported bug. Media
      // attached to a schedule event instead of a module (Q&A recordings, mostly) has no
      // "closed lesson" to gate on, so those still go out to everyone, same as before.
      void (async () => {
        const candidateIds = await activeStudentIds(practicumId);
        const openIds = moduleId
          ? (await Promise.all(candidateIds.map(async (studentId) => ({ studentId, open: await isModuleOpenForStudent(prisma, studentId, practicumId, moduleId) }))))
              .filter((entry) => entry.open)
              .map((entry) => entry.studentId)
          : candidateIds;
        // isModuleOpenForStudent only checks unlock status, not the Advanced gate (that's a
        // separate axis — see MediaAudience) — an Advanced-tagged recording, module-attached or
        // not, must never announce its title to a non-Advanced student.
        // Same for a recording sitting in an Advanced lesson, whatever its own audience tag:
        // access rows for an Advanced lesson exist for non-Advanced students too.
        const inAdvancedLesson = moduleId ? (await prisma.module.findUnique({ where: { id: moduleId }, select: { section: true } }))?.section === "Advanced" : false;
        const notifiableIds = media.audience === MediaAudience.ADVANCED || inAdvancedLesson
          ? (await prisma.user.findMany({ where: { id: { in: openIds }, isAdvanced: true }, select: { id: true } })).map((student) => student.id)
          : openIds;
        if (notifiableIds.length === 0) return;
        const recipients = await prisma.user.findMany({ where: { id: { in: notifiableIds }, email: { not: null } }, select: { email: true } });
        await Promise.all(recipients.map((recipient) => recipient.email && sendNewMediaNotification({ to: recipient.email, mediaTitle: media.title ?? "Новая запись", kind: media.kind, mediaId: media.id })));
        await notificationService.createMany(notifiableIds, "NEW_MEDIA", `Новая запись: ${media.title ?? "без названия"}`, undefined, media.id);
      })().catch((error: unknown) => console.error("Media notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
    }
    return this.toMediaDto(media);
  }

  /** No practicum-equality gate here — a curator can archive a recording from any practicum, finished cohorts included. */
  public async archiveMedia(actorId: string, mediaId: string) {
    await this.assertCurator(actorId);
    const normalizedMediaId = requiredText(mediaId, "mediaId", 100);

    const existing = await prisma.mediaAsset.findUnique({
      where: { id: normalizedMediaId },
      select: {
        id: true,
        scheduleEventId: true,
        provider: true,
        providerKey: true,
        kind: true,
        audience: true,
        status: true,
        title: true,
        description: true,
        durationSec: true,
        byteSize: true,
        position: true,
        publishedAt: true,
        moduleId: true,
      },
    });
    if (!existing) throw new AuthServiceError("INVALID_INPUT", "Media does not exist");
    if (existing.status === MediaAssetStatus.ARCHIVED) return this.toMediaDto(existing);

    const archived = await prisma.$transaction(async (tx) => {
      const media = await tx.mediaAsset.update({
        where: { id: normalizedMediaId },
        data: { status: MediaAssetStatus.ARCHIVED },
        select: {
          id: true,
          scheduleEventId: true,
          provider: true,
          providerKey: true,
          kind: true,
          audience: true,
          status: true,
          title: true,
          description: true,
          durationSec: true,
          byteSize: true,
          position: true,
          publishedAt: true,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId,
          action: "MEDIA_ARCHIVED",
          objectType: "MEDIA_ASSET",
          objectId: normalizedMediaId,
          metadata: {
            title: existing.title,
            kind: existing.kind,
            moduleId: existing.moduleId,
            scheduleEventId: existing.scheduleEventId,
          },
        },
      });
      return media;
    });

    // A recording can be attached to several modules at once (attachMediaToModule copies
    // provider+providerKey onto a new row per module) — only wipe the actual file once none of
    // its sibling rows still need it. Best-effort: the row is already archived either way, so a
    // storage hiccup here just leaves an orphaned file for later cleanup rather than blocking.
    if (existing.provider.toUpperCase() === "LIVEKIT_RECORDING") {
      const stillReferenced = await prisma.mediaAsset.count({
        where: { provider: existing.provider, providerKey: existing.providerKey, status: { not: MediaAssetStatus.ARCHIVED }, id: { not: normalizedMediaId } },
      });
      if (stillReferenced === 0) {
        await deleteRecordingObjects(existing.providerKey).catch((error: unknown) => console.error("Recording storage cleanup failed", error instanceof Error ? error.message : "unknown error"));
      }
    }

    return this.toMediaDto(archived);
  }

  public async attachMediaToModule(actorId: string, mediaId: string, moduleId: string) {
    await this.assertCurator(actorId);
    const normalizedMediaId = requiredText(mediaId, "mediaId", 100);
    const normalizedModuleId = requiredText(moduleId, "moduleId", 100);
    const courseModule = await prisma.module.findUnique({ where: { id: normalizedModuleId }, select: { id: true, practicumId: true } });
    if (!courseModule) throw new AuthServiceError("INVALID_INPUT", "Module does not exist");
    const lastMedia = await prisma.mediaAsset.findFirst({ where: { moduleId: normalizedModuleId }, orderBy: { position: "desc" }, select: { position: true } });
    const source = await prisma.mediaAsset.findUnique({ where: { id: normalizedMediaId }, select: { provider: true, providerKey: true, kind: true, audience: true, status: true, title: true, description: true, durationSec: true, byteSize: true, publishedAt: true } });
    if (!source) throw new AuthServiceError("INVALID_INPUT", "Media does not exist");
    if (source.kind === MediaAssetKind.TALKS) throw new AuthServiceError("INVALID_INPUT", "Talks-запись нельзя привязать к уроку");
    const media = await prisma.mediaAsset.create({ data: { practicumId: courseModule.practicumId, moduleId: normalizedModuleId, provider: source.provider, providerKey: source.providerKey, kind: source.kind, audience: source.audience, status: source.status, title: source.title, description: source.description, durationSec: source.durationSec, byteSize: source.byteSize, publishedAt: source.publishedAt, position: (lastMedia?.position ?? -1) + 1 }, select: { id: true, provider: true, providerKey: true, kind: true, audience: true, status: true, title: true, description: true, durationSec: true, byteSize: true, position: true, publishedAt: true } }).catch(() => null);
    if (!media) throw new AuthServiceError("INVALID_INPUT", "Media does not exist");
    return this.toMediaDto(media);
  }

  /**
   * Reclassifies an existing media record in place (kind and/or module/event binding) —
   * unlike attachMediaToModule, this does not create a copy, so a stream mis-typed as
   * STREAM can be turned into QA without leaving a duplicate behind.
   */
  public async updateMediaClassification(actorId: string, mediaId: string, input: UpdateMediaClassificationInput) {
    await this.assertCurator(actorId);
    const normalizedMediaId = requiredText(mediaId, "mediaId", 100);
    const moduleId = input.moduleId ? requiredText(input.moduleId, "moduleId", 100) : undefined;
    const scheduleEventId = input.scheduleEventId ? requiredText(input.scheduleEventId, "scheduleEventId", 100) : undefined;
    const groupId = input.groupId ? requiredText(input.groupId, "groupId", 100) : undefined;
    if (input.kind !== MediaAssetKind.TALKS && !moduleId && !scheduleEventId) {
      throw new AuthServiceError("INVALID_INPUT", "moduleId or scheduleEventId is required for this media type");
    }

    const existing = await prisma.mediaAsset.findUnique({ where: { id: normalizedMediaId }, select: { id: true, practicumId: true } });
    if (!existing) throw new AuthServiceError("INVALID_INPUT", "Media does not exist");

    let practicumId = existing.practicumId;
    if (moduleId) {
      const courseModule = await prisma.module.findUnique({ where: { id: moduleId }, select: { id: true, practicumId: true } });
      if (!courseModule) throw new AuthServiceError("INVALID_INPUT", "Module does not exist");
      practicumId = courseModule.practicumId;
    }
    if (scheduleEventId) {
      const scheduleEvent = await prisma.scheduleEvent.findUnique({ where: { id: scheduleEventId }, select: { id: true, practicumId: true } });
      if (!scheduleEvent) throw new AuthServiceError("INVALID_INPUT", "Schedule event does not exist");
      practicumId = scheduleEvent.practicumId;
    }
    // Every reclassify call fully re-specifies the target (this endpoint replaces, not
    // merges), so a groupId left over from a previous module must not silently survive a
    // move to a different module/event — see createVimeoMedia for the same "requires
    // moduleId + must belong to it" rule.
    if (groupId) {
      if (!moduleId) throw new AuthServiceError("INVALID_INPUT", "groupId requires moduleId");
      const group = await prisma.mediaGroup.findUnique({ where: { id: groupId }, select: { moduleId: true } });
      if (!group || group.moduleId !== moduleId) throw new AuthServiceError("INVALID_INPUT", "Block does not belong to this lesson");
    }

    const lastMedia = await prisma.mediaAsset.findFirst({
      where: groupId ? { groupId } : scheduleEventId ? { scheduleEventId } : moduleId ? { moduleId, groupId: null } : { practicumId, moduleId: null, scheduleEventId: null },
      orderBy: { position: "desc" },
      select: { position: true },
    });

    const media = await prisma.mediaAsset.update({
      where: { id: normalizedMediaId },
      data: {
        kind: input.kind,
        audience: input.audience === MediaAudience.ADVANCED ? MediaAudience.ADVANCED : MediaAudience.ALL,
        moduleId: moduleId ?? null,
        scheduleEventId: scheduleEventId ?? null,
        groupId: groupId ?? null,
        practicumId,
        position: (lastMedia?.position ?? -1) + 1,
      },
      select: { id: true, provider: true, providerKey: true, kind: true, audience: true, status: true, title: true, description: true, durationSec: true, byteSize: true, position: true, publishedAt: true, scheduleEventId: true, groupId: true },
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("Unique constraint")) {
        throw new AuthServiceError("INVALID_INPUT", "Эта запись уже есть в выбранном уроке");
      }
      throw error;
    });

    return this.toMediaDto(media);
  }

  public async renameMedia(actorId: string, mediaId: string, title: string) {
    await this.assertCurator(actorId);
    const normalizedMediaId = requiredText(mediaId, "mediaId", 100);
    const normalizedTitle = requiredText(title, "title", 180);

    const existing = await prisma.mediaAsset.findUnique({ where: { id: normalizedMediaId }, select: { id: true } });
    if (!existing) throw new AuthServiceError("INVALID_INPUT", "Media does not exist");

    const media = await prisma.mediaAsset.update({
      where: { id: normalizedMediaId },
      data: { title: normalizedTitle },
      select: { id: true, provider: true, providerKey: true, kind: true, audience: true, status: true, title: true, description: true, durationSec: true, byteSize: true, position: true, publishedAt: true, scheduleEventId: true },
    });

    return this.toMediaDto(media);
  }

  private getModuleAccess(
    access: { status: ModuleAccessStatus; progress: number } | undefined,
    role: UserRole,
    defaultAccess: ModuleAccessStatus,
  ): CourseAccess {
    if (role !== UserRole.STUDENT) {
      // A curator/owner always sees full content while editing — "locked" never applies to
      // them — but the status they're shown is the module's real default-for-everyone
      // state, not a guess from some student's personal row.
      return { locked: false, progress: access?.progress ?? 0, status: defaultAccess };
    }

    const status = access?.status ?? ModuleAccessStatus.LOCKED;
    return {
      locked: status === ModuleAccessStatus.LOCKED,
      progress: Math.max(0, Math.min(100, access?.progress ?? 0)),
      status,
    };
  }

  private async assertCurator(userId: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
    if (!user || user.status !== UserStatus.ACTIVE || (user.role !== UserRole.CURATOR && user.role !== UserRole.OWNER)) {
      throw new AuthServiceError("FORBIDDEN", "Curator access required");
    }
  }

  /**
   * Called once per real video open (not per API fetch) — the audit trail behind the
   * on-screen watermark. If a recording leaks, cross-referencing who opened this exact
   * media around the leaked timestamp narrows down the source.
   */
  public async recordPlaybackEvent(userId: string, mediaId: string, context: { ipAddress?: string; userAgent?: string }) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
    if (!user || user.status !== UserStatus.ACTIVE) throw new AuthServiceError("FORBIDDEN", "User is not active");
    const media = await prisma.mediaAsset.findUnique({ where: { id: mediaId }, select: { id: true, practicumId: true, status: true } });
    if (!media || media.status !== MediaAssetStatus.PUBLISHED) throw new AuthServiceError("INVALID_INPUT", "Media does not exist");
    if (user.role === UserRole.STUDENT) {
      const enrollment = await prisma.enrollment.findFirst({
        where: { studentId: userId, practicumId: media.practicumId, status: EnrollmentStatus.ACTIVE, OR: [{ accessUntil: null }, { accessUntil: { gt: new Date() } }] },
        select: { id: true },
      });
      if (!enrollment) throw new AuthServiceError("FORBIDDEN", "Student is not enrolled in this practicum");
    }
    await prisma.mediaPlaybackEvent.create({
      data: { mediaAssetId: mediaId, userId, ipAddress: context.ipAddress?.slice(0, 100), userAgent: context.userAgent?.slice(0, 500) },
    });
  }

  /** Curator/owner lookup: who opened this specific video, and when — for tracing a leak. */
  public async listMediaViewers(actorId: string, mediaId: string) {
    const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { role: true, status: true } });
    if (!actor || actor.status !== UserStatus.ACTIVE || (actor.role !== UserRole.CURATOR && actor.role !== UserRole.OWNER)) {
      throw new AuthServiceError("FORBIDDEN", "Only an active owner or curator can view playback history");
    }
    const media = await prisma.mediaAsset.findUnique({ where: { id: mediaId }, select: { id: true, title: true } });
    if (!media) throw new AuthServiceError("INVALID_INPUT", "Media does not exist");
    const events = await prisma.mediaPlaybackEvent.findMany({
      where: { mediaAssetId: mediaId },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
        user: { select: { id: true, email: true, role: true, externalIdentities: { orderBy: { createdAt: "asc" }, take: 1, select: { displayName: true, username: true } } } },
      },
    });
    return {
      mediaTitle: media.title,
      events: events.map((event) => ({
        id: event.id,
        ipAddress: event.ipAddress,
        userAgent: event.userAgent,
        createdAt: event.createdAt,
        viewer: {
          id: event.user.id,
          role: event.user.role,
          name: event.user.externalIdentities[0]?.displayName ?? event.user.externalIdentities[0]?.username ?? event.user.email ?? "Без имени",
        },
      })),
    };
  }

  private toMediaDto(media: {
    id: string;
    provider: string;
    providerKey: string;
    scheduleEventId?: string | null;
    kind: MediaAssetKind;
    audience: MediaAudience;
    status: MediaAssetStatus;
    title: string | null;
    description: string | null;
    durationSec: number | null;
    byteSize: bigint | null;
    position: number;
    publishedAt: Date | null;
  }) {
    return {
      id: media.id,
      scheduleEventId: media.scheduleEventId ?? null,
      provider: media.provider,
      kind: media.kind,
      audience: media.audience,
      status: media.status,
      title: media.title,
      description: media.description,
      durationSec: media.durationSec,
      byteSize: mediaByteSize(media.byteSize),
      position: media.position,
      publishedAt: media.publishedAt,
      embedUrl: mediaEmbedUrl(media.provider, media.providerKey, media.id),
      thumbnailUrl: mediaThumbnailUrl(media.provider, media.providerKey, media.id),
    };
  }
}

export const courseService = new CourseService();
