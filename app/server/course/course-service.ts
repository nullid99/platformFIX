import {
  AssignmentStatus,
  EnrollmentStatus,
  MediaAssetKind,
  MediaAssetStatus,
  ModuleAccessStatus,
  UserRole,
  UserStatus,
} from "@/app/generated/prisma/enums";
import { AuthServiceError } from "@/app/server/auth";
import { prisma } from "@/app/server/db";
import { activeStudentIds } from "@/app/server/notifications/recipient-service";
import { sendNewModuleNotification, sendNewMediaNotification } from "@/app/server/notifications/email-service";
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
  title: string;
  description?: string;
  kind: MediaAssetKind;
  vimeoUrl: string;
};

export type CreateModuleInput = {
  title: string;
  description?: string;
  section?: string;
  coverPath?: string;
};

export type UpdateModuleInput = { title: string; description?: string };
export type UpdateMediaClassificationInput = { kind: MediaAssetKind; moduleId?: string; scheduleEventId?: string };

function jsonStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
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
    const section = ["Welcome", "Education", "Q&A", "Practice"].includes(input.section ?? "") ? input.section! : "Education";
    const coverPath = input.coverPath?.trim() || null;
    if (coverPath && (!coverPath.startsWith("/") || coverPath.length > 500)) {
      throw new AuthServiceError("INVALID_INPUT", "coverPath is invalid");
    }
    const practicumId = await getWorkingPracticumId(actorId);
    if (!practicumId) throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");

    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
        const lastModule = await tx.module.findFirst({ where: { practicumId }, orderBy: { position: "desc" }, select: { position: true } });
        const position = (lastModule?.position ?? -1) + 1;
        const courseModule = await tx.module.create({ data: { practicumId, title, description, section, coverPath, position } });
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
        };
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("Unique constraint")) {
        throw new AuthServiceError("INVALID_INPUT", "Module position conflict, please retry");
      }
      throw error;
    }
    // Announced to everyone immediately, unlike NEW_ASSIGNMENT/NEW_MEDIA — a fresh module is
    // always LOCKED by default (nobody has an EnrollmentModuleAccess row for it yet), so gating
    // this on isModuleOpenForStudent would mean it never fires at all. This is curriculum news
    // ("a new lesson exists"), not content-visibility news ("you can watch/submit this now").
    void (async () => {
      const studentIds = await activeStudentIds(practicumId);
      if (studentIds.length === 0) return;
      const recipients = await prisma.user.findMany({ where: { id: { in: studentIds }, email: { not: null } }, select: { email: true } });
      await Promise.all(recipients.map((recipient) => recipient.email && sendNewModuleNotification({ to: recipient.email, moduleTitle: created.title, moduleId: created.id })));
      await notificationService.createMany(studentIds, "NEW_MODULE", `Новый урок: ${created.title}`, undefined, created.id);
    })().catch((error: unknown) => console.error("Module notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
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
    const courseModule = await prisma.module.findUnique({ where: { id: moduleId }, select: { id: true, practicumId: true, title: true } });
    if (!courseModule) throw new AuthServiceError("INVALID_INPUT", "Module does not exist");
    const now = new Date();
    const newlyOpenedStudentIds: string[] = [];
    const result = await prisma.$transaction(async (tx) => {
      await tx.module.update({ where: { id: moduleId }, data: { defaultAccess: unlocked ? ModuleAccessStatus.UNLOCKED : ModuleAccessStatus.LOCKED } });
      const enrollments = await tx.enrollment.findMany({ where: { practicumId: courseModule.practicumId, status: EnrollmentStatus.ACTIVE, OR: [{ accessUntil: null }, { accessUntil: { gt: now } }] }, select: { id: true, studentId: true } });
      let affected = 0;
      for (const enrollment of enrollments) {
        const existing = await tx.enrollmentModuleAccess.findUnique({ where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId } }, select: { status: true, isOverride: true } });
        if (existing?.isOverride || existing?.status === ModuleAccessStatus.COMPLETED) continue;
        if (!existing) {
          await tx.enrollmentModuleAccess.create({ data: { enrollmentId: enrollment.id, moduleId, status: unlocked ? ModuleAccessStatus.UNLOCKED : ModuleAccessStatus.LOCKED, unlockedAt: unlocked ? now : null } });
          affected += 1;
          if (unlocked) newlyOpenedStudentIds.push(enrollment.studentId);
        } else if (unlocked && existing.status === ModuleAccessStatus.LOCKED) {
          await tx.enrollmentModuleAccess.update({ where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId } }, data: { status: ModuleAccessStatus.UNLOCKED, unlockedAt: now } });
          affected += 1;
          newlyOpenedStudentIds.push(enrollment.studentId);
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
    }
    return result;
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
    }
    return { moduleId, studentId, status: access.status, isOverride: access.isOverride };
  }

  /**
   * Marks a module COMPLETED for one student and opens the content of the next module by
   * position — an assignment inside that next module still stays gated until IT is marked
   * completed too (see assignment-service.ts#submit). Called two ways: a curator's explicit
   * "Урок пройден" click for this one student, or automatically from assignment-service.ts
   * #decide once every assignment in the module has been accepted for this student (a module
   * with no assignments, or one still missing an accepted submission, only completes via the
   * manual click).
   */
  public async markModuleCompletedForStudent(actorId: string, studentId: string, moduleId: string) {
    await this.assertCurator(actorId);
    const courseModule = await prisma.module.findUnique({ where: { id: moduleId }, select: { id: true, practicumId: true, position: true } });
    if (!courseModule) throw new AuthServiceError("INVALID_INPUT", "Module does not exist");
    const enrollment = await prisma.enrollment.findFirst({
      where: { studentId, practicumId: courseModule.practicumId, status: EnrollmentStatus.ACTIVE },
      select: { id: true },
    });
    if (!enrollment) throw new AuthServiceError("INVALID_INPUT", "Student is not enrolled in this practicum");
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      await tx.enrollmentModuleAccess.upsert({
        where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId } },
        update: { status: ModuleAccessStatus.COMPLETED, progress: 100, completedAt: now },
        create: { enrollmentId: enrollment.id, moduleId, status: ModuleAccessStatus.COMPLETED, progress: 100, unlockedAt: now, completedAt: now },
      });
      const nextModule = await tx.module.findFirst({ where: { practicumId: courseModule.practicumId, position: { gt: courseModule.position } }, orderBy: { position: "asc" }, select: { id: true, title: true } });
      let nextModuleId: string | null = null;
      let nextModuleTitle: string | null = null;
      if (nextModule) {
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
    const enrollments = await prisma.enrollment.findMany({ where: { practicumId: courseModule.practicumId, status: EnrollmentStatus.ACTIVE }, select: { id: true, studentId: true } });
    const nextModule = await prisma.module.findFirst({ where: { practicumId: courseModule.practicumId, position: { gt: courseModule.position } }, orderBy: { position: "asc" }, select: { id: true, title: true } });

    let completedCount = 0;
    const newlyOpenedStudentIds: string[] = [];
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

        if (nextModule) {
          const existingNext = await tx.enrollmentModuleAccess.findUnique({ where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId: nextModule.id } }, select: { isOverride: true, status: true } });
          if (!existingNext) {
            await tx.enrollmentModuleAccess.create({ data: { enrollmentId: enrollment.id, moduleId: nextModule.id, status: ModuleAccessStatus.UNLOCKED, unlockedAt: now } });
            newlyOpenedStudentIds.push(enrollment.studentId);
          } else if (!existingNext.isOverride && existingNext.status === ModuleAccessStatus.LOCKED) {
            await tx.enrollmentModuleAccess.update({ where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId: nextModule.id } }, data: { status: ModuleAccessStatus.UNLOCKED, unlockedAt: now } });
            newlyOpenedStudentIds.push(enrollment.studentId);
          }
        }
      }
    });
    if (newlyOpenedStudentIds.length > 0 && nextModule) {
      void notificationService.createMany(newlyOpenedStudentIds, "MODULE_OPENED", `Открыт урок: ${nextModule.title}`, undefined, nextModule.id)
        .catch((error: unknown) => console.error("Module-opened notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
    }
    return { moduleId, completedCount, totalEnrollments: enrollments.length, nextModuleId: nextModule?.id ?? null };
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
      select: { role: true, status: true },
    });

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new AuthServiceError("SESSION_INVALID", "User is not active");
    }

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
      media: practicum.mediaAssets.map((asset) => ({
        id: asset.id,
        scheduleEventId: asset.scheduleEventId,
        provider: asset.provider,
        kind: asset.kind,
        status: asset.status,
        title: asset.title,
        description: asset.description,
        durationSec: asset.durationSec,
        byteSize: mediaByteSize(asset.byteSize),
        position: asset.position,
        publishedAt: asset.publishedAt,
        embedUrl: mediaEmbedUrl(asset.provider, asset.providerKey, asset.id),
        thumbnailUrl: mediaThumbnailUrl(asset.provider, asset.providerKey, asset.id),
      })),
      scheduleEvents: practicum.scheduleEvents.map((event) => ({
        id: event.id,
        type: event.type,
        title: event.title,
        date: event.date.toISOString().slice(0, 10),
        time: event.time,
        description: event.description,
        live: event.live,
        coverPath: event.coverPath,
        recordingAvailable: event.mediaAssets.some((asset) => asset.status === MediaAssetStatus.PUBLISHED),
        recordings: event.mediaAssets.map((asset) => ({
          id: asset.id,
          scheduleEventId: event.id,
          provider: asset.provider,
          kind: asset.kind,
          title: asset.title,
          description: asset.description,
          durationSec: asset.durationSec,
          byteSize: mediaByteSize(asset.byteSize),
          position: asset.position,
          status: asset.status,
          publishedAt: asset.publishedAt,
          embedUrl: mediaEmbedUrl(asset.provider, asset.providerKey, asset.id),
          thumbnailUrl: mediaThumbnailUrl(asset.provider, asset.providerKey, asset.id),
        })),
      })),
      modules: practicum.modules.map((module) => {
        const access = this.getModuleAccess(module.accessRecords[0], user.role, module.defaultAccess);
        const media = access.locked
          ? []
          : module.mediaAssets.map((asset) => ({
            id: asset.id,
            scheduleEventId: asset.scheduleEventId,
            provider: asset.provider,
            kind: asset.kind,
            status: asset.status,
            title: asset.title,
            description: asset.description,
            durationSec: asset.durationSec,
            byteSize: mediaByteSize(asset.byteSize),
            position: asset.position,
            publishedAt: asset.publishedAt,
            embedUrl: mediaEmbedUrl(asset.provider, asset.providerKey, asset.id),
            thumbnailUrl: mediaThumbnailUrl(asset.provider, asset.providerKey, asset.id),
          }));
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
          assignments,
        };
      }),
    };
  }

  public async createVimeoMedia(actorId: string, input: CreateVimeoMediaInput) {
    await this.assertCurator(actorId);
    const moduleId = input.moduleId ? requiredText(input.moduleId, "moduleId", 100) : undefined;
    const scheduleEventId = input.scheduleEventId ? requiredText(input.scheduleEventId, "scheduleEventId", 100) : undefined;
    if (input.kind !== MediaAssetKind.TALKS && !moduleId && !scheduleEventId) throw new AuthServiceError("INVALID_INPUT", "moduleId or scheduleEventId is required for this media type");
    const title = requiredText(input.title, "title", 180);
    const description = input.description?.trim().slice(0, 2_000) || undefined;
    const providerKey = normalizeVimeoKey(input.vimeoUrl);
    const courseModule = moduleId
      ? await prisma.module.findUnique({ where: { id: moduleId }, select: { id: true, practicumId: true } })
      : null;
    if (moduleId && !courseModule) throw new AuthServiceError("INVALID_INPUT", "Module does not exist");
    const scheduleEvent = scheduleEventId ? await prisma.scheduleEvent.findUnique({ where: { id: scheduleEventId }, select: { id: true, practicumId: true } }) : null;
    if (scheduleEventId && !scheduleEvent) throw new AuthServiceError("INVALID_INPUT", "Schedule event does not exist");
    if (courseModule && scheduleEvent && courseModule.practicumId !== scheduleEvent.practicumId) throw new AuthServiceError("INVALID_INPUT", "Module and event belong to different practicums");
    const practicumId = courseModule?.practicumId ?? scheduleEvent?.practicumId ?? (await getWorkingPracticumId(actorId));
    if (!practicumId) throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");

    const lastMedia = await prisma.mediaAsset.findFirst({
      where: scheduleEventId ? { scheduleEventId } : moduleId ? { moduleId } : { practicumId, moduleId: null, scheduleEventId: null },
      orderBy: { position: "desc" },
      select: { position: true },
    });

    const media = await prisma.mediaAsset.create({
      data: {
        practicumId,
        moduleId,
        scheduleEventId,
        provider: "VIMEO",
        providerKey,
        kind: input.kind,
        status: MediaAssetStatus.DRAFT,
        title,
        description,
        position: (lastMedia?.position ?? -1) + 1,
      },
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("Unique constraint")) {
        throw new AuthServiceError("INVALID_INPUT", "This Vimeo video is already in the media library");
      }
      throw error;
    });

    return this.toMediaDto(media);
  }

  public async updateModule(actorId: string, moduleId: string, input: UpdateModuleInput) {
    await this.assertCurator(actorId);
    const title = requiredText(input.title, "title", 180);
    const description = input.description?.trim().slice(0, 5_000) || null;
    return prisma.module.update({ where: { id: moduleId }, data: { title, description }, select: { id: true, title: true, description: true } }).catch(() => {
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
        const notifiableIds = moduleId
          ? (await Promise.all(candidateIds.map(async (studentId) => ({ studentId, open: await isModuleOpenForStudent(prisma, studentId, practicumId, moduleId) }))))
              .filter((entry) => entry.open)
              .map((entry) => entry.studentId)
          : candidateIds;
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
    const source = await prisma.mediaAsset.findUnique({ where: { id: normalizedMediaId }, select: { provider: true, providerKey: true, kind: true, status: true, title: true, description: true, durationSec: true, byteSize: true, publishedAt: true } });
    if (!source) throw new AuthServiceError("INVALID_INPUT", "Media does not exist");
    if (source.kind === MediaAssetKind.TALKS) throw new AuthServiceError("INVALID_INPUT", "Talks-запись нельзя привязать к уроку");
    const media = await prisma.mediaAsset.create({ data: { practicumId: courseModule.practicumId, moduleId: normalizedModuleId, provider: source.provider, providerKey: source.providerKey, kind: source.kind, status: source.status, title: source.title, description: source.description, durationSec: source.durationSec, byteSize: source.byteSize, publishedAt: source.publishedAt, position: (lastMedia?.position ?? -1) + 1 }, select: { id: true, provider: true, providerKey: true, kind: true, status: true, title: true, description: true, durationSec: true, byteSize: true, position: true, publishedAt: true } }).catch(() => null);
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

    const lastMedia = await prisma.mediaAsset.findFirst({
      where: scheduleEventId ? { scheduleEventId } : moduleId ? { moduleId } : { practicumId, moduleId: null, scheduleEventId: null },
      orderBy: { position: "desc" },
      select: { position: true },
    });

    const media = await prisma.mediaAsset.update({
      where: { id: normalizedMediaId },
      data: {
        kind: input.kind,
        moduleId: moduleId ?? null,
        scheduleEventId: scheduleEventId ?? null,
        practicumId,
        position: (lastMedia?.position ?? -1) + 1,
      },
      select: { id: true, provider: true, providerKey: true, kind: true, status: true, title: true, description: true, durationSec: true, byteSize: true, position: true, publishedAt: true, scheduleEventId: true },
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
      select: { id: true, provider: true, providerKey: true, kind: true, status: true, title: true, description: true, durationSec: true, byteSize: true, position: true, publishedAt: true, scheduleEventId: true },
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
