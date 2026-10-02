import { EnrollmentStatus, ModuleAccessStatus, SessionStatus, SubmissionStatus, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { AuthServiceError } from "@/app/server/auth";
import { sendCuratorReminderNotification } from "@/app/server/notifications/email-service";
import { notificationService } from "@/app/server/notifications/notification-service";

export type StudentProgressRow = {
  id: string;
  isAdvanced: boolean;
  identities: Array<{ provider: string; username: string | null; displayName: string | null; avatarUrl: string | null }>;
  completedModules: number;
  totalModules: number;
  progressPercent: number;
  currentLessonTitle: string;
  pendingReviewCount: number;
  needsRevisionCount: number;
  needsAttention: boolean;
  lastActiveAt: string | null;
  lastReminderAt: string | null;
};

/** How long a student can go without activity before an unfinished cohort member is flagged — see needsAttention below. */
const INACTIVITY_THRESHOLD_DAYS = 7;

/** "Напомнить" on the "Прогресс" page is one click, no confirmation — this is what keeps it from being spammable. */
const REMINDER_COOLDOWN_HOURS = 24;

async function assertOwnerOrCurator(actorId: string): Promise<void> {
  const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { role: true, status: true } });
  if (!actor || actor.status !== UserStatus.ACTIVE || (actor.role !== UserRole.OWNER && actor.role !== UserRole.CURATOR)) {
    throw new AuthServiceError("FORBIDDEN", "Only an active owner or curator can view student progress");
  }
}

/**
 * Owner or curator — one row per actively-enrolled student in `practicumId`, built from three flat
 * queries (modules, enrollments+moduleAccesses, pending submissions) rather than one round-trip per
 * student, so this stays cheap no matter how large a cohort grows. "Прогресс %"/"Выполнено X/Y" both
 * come from the same COMPLETED-module count — a module with no EnrollmentModuleAccess row yet
 * resolves through Module.defaultAccess, the same fallback course-service.ts already applies when a
 * student loads their own dashboard, so this can never disagree with what the student themselves sees.
 */
export async function getStudentProgress(actorId: string, practicumId: string): Promise<StudentProgressRow[]> {
  await assertOwnerOrCurator(actorId);
  if (!practicumId) throw new AuthServiceError("INVALID_INPUT", "practicumId is required");

  const now = new Date();
  // Same "active, unexpired" test auth-service.ts#getStudentDirectory and course-service.ts#getForUser
  // use — keeps this roster consistent with what those already show.
  const activeEnrollmentFilter = { status: EnrollmentStatus.ACTIVE, OR: [{ accessUntil: null }, { accessUntil: { gt: now } }] };

  const [modules, enrollments, relevantSubmissions, recentReminders] = await Promise.all([
    prisma.module.findMany({
      // Theory track only (mirrors the student's own "Теория" tab — page.tsx's sectionOrder for
      // courseTrack==="theory": Welcome/Education/Q&A). Practice and Advanced modules run on their
      // own separate schedule with no fixed lesson count, so folding them into "Выполнено X/Y"
      // inflated the denominator with modules that aren't part of the curriculum this page tracks.
      where: { practicumId, section: { in: ["Welcome", "Education", "Q&A"] } },
      orderBy: { position: "asc" },
      select: { id: true, title: true, defaultAccess: true },
    }),
    prisma.enrollment.findMany({
      where: { practicumId, ...activeEnrollmentFilter },
      select: {
        studentId: true,
        student: {
          select: {
            isAdvanced: true,
            externalIdentities: { select: { provider: true, username: true, displayName: true, avatarUrl: true } },
            sessions: {
              where: { status: SessionStatus.ACTIVE, expiresAt: { gt: now } },
              orderBy: { lastActiveAt: "desc" },
              take: 1,
              select: { lastActiveAt: true },
            },
          },
        },
        moduleAccesses: { select: { moduleId: true, status: true } },
      },
    }),
    prisma.submission.findMany({
      where: { assignment: { practicumId }, status: { in: [SubmissionStatus.SUBMITTED, SubmissionStatus.IN_REVIEW, SubmissionStatus.NEEDS_REVISION] } },
      select: { studentId: true, status: true },
    }),
    // Newest first, so the reduce below keeps only each student's most recent reminder.
    prisma.notification.findMany({
      where: { type: "CURATOR_REMINDER", user: { enrollments: { some: { practicumId } } } },
      orderBy: { createdAt: "desc" },
      select: { userId: true, createdAt: true },
    }),
  ]);

  const submissionCounts = new Map<string, { pending: number; needsRevision: number }>();
  for (const submission of relevantSubmissions) {
    const entry = submissionCounts.get(submission.studentId) ?? { pending: 0, needsRevision: 0 };
    if (submission.status === SubmissionStatus.NEEDS_REVISION) entry.needsRevision += 1;
    else entry.pending += 1;
    submissionCounts.set(submission.studentId, entry);
  }

  const lastReminderByStudent = new Map<string, Date>();
  for (const reminder of recentReminders) {
    if (!lastReminderByStudent.has(reminder.userId)) lastReminderByStudent.set(reminder.userId, reminder.createdAt);
  }

  const totalModules = modules.length;

  return enrollments.map((enrollment) => {
    const accessByModule = new Map(enrollment.moduleAccesses.map((access) => [access.moduleId, access.status]));
    let completedModules = 0;
    let currentLessonTitle = totalModules > 0 ? "Завершено" : "Нет уроков";
    let foundCurrent = false;
    for (const courseModule of modules) {
      const status = accessByModule.get(courseModule.id) ?? courseModule.defaultAccess;
      if (status === ModuleAccessStatus.COMPLETED) {
        completedModules += 1;
      } else if (!foundCurrent) {
        currentLessonTitle = courseModule.title;
        foundCurrent = true;
      }
    }

    const counts = submissionCounts.get(enrollment.studentId) ?? { pending: 0, needsRevision: 0 };
    const progressPercent = totalModules > 0 ? Math.round((completedModules / totalModules) * 100) : 0;
    const lastActiveAt = enrollment.student.sessions[0]?.lastActiveAt ?? null;
    const daysSinceActive = lastActiveAt ? (now.getTime() - lastActiveAt.getTime()) / 86_400_000 : Infinity;
    const needsAttention = counts.needsRevision > 0 || (progressPercent < 100 && daysSinceActive > INACTIVITY_THRESHOLD_DAYS);

    return {
      id: enrollment.studentId,
      isAdvanced: enrollment.student.isAdvanced,
      identities: enrollment.student.externalIdentities,
      completedModules,
      totalModules,
      progressPercent,
      currentLessonTitle,
      pendingReviewCount: counts.pending,
      needsRevisionCount: counts.needsRevision,
      needsAttention,
      lastActiveAt: lastActiveAt ? lastActiveAt.toISOString() : null,
      lastReminderAt: lastReminderByStudent.get(enrollment.studentId)?.toISOString() ?? null,
    };
  });
}

/**
 * Owner or curator — the "Прогресс" page's "Напомнить" button. Re-derives the student's current
 * state itself (never trusts whatever the client last rendered) so a curator can't accidentally
 * remind someone who resolved their own situation seconds ago, and enforces the cooldown against
 * the Notification table directly rather than a dedicated column — that table is already the
 * source of truth getStudentProgress reads lastReminderAt from above.
 */
export async function sendStudentReminder(actorId: string, studentId: string, practicumId: string): Promise<{ lastReminderAt: string }> {
  await assertOwnerOrCurator(actorId);
  if (!practicumId) throw new AuthServiceError("INVALID_INPUT", "practicumId is required");

  const now = new Date();
  const recentReminder = await prisma.notification.findFirst({
    where: { userId: studentId, type: "CURATOR_REMINDER", createdAt: { gt: new Date(now.getTime() - REMINDER_COOLDOWN_HOURS * 3_600_000) } },
  });
  if (recentReminder) throw new AuthServiceError("INVALID_INPUT", "Напоминание этому ученику уже отправлялось за последние 24 часа");

  const rows = await getStudentProgress(actorId, practicumId);
  const row = rows.find((item) => item.id === studentId);
  if (!row) throw new AuthServiceError("INVALID_INPUT", "Ученик не найден в этом потоке");
  if (!row.needsAttention) throw new AuthServiceError("INVALID_INPUT", "Этому ученику сейчас не требуется напоминание");

  const body = row.needsRevisionCount > 0
    ? "Куратор ждёт исправленную версию домашнего задания — откройте «Задания», чтобы увидеть, что нужно доработать."
    : `Вы остановились на уроке «${row.currentLessonTitle}» — самое время продолжить.`;

  // The in-app bell is the one channel every student always has, so it's the only one that's
  // required — email is a bonus on top when there's an address on file (a Discord-only sign-up
  // may well not have one), never a reason to block the reminder outright.
  await notificationService.create(studentId, "CURATOR_REMINDER", "Куратор напоминает о практикуме", body);
  const student = await prisma.user.findUnique({ where: { id: studentId }, select: { email: true } });
  if (student?.email) await sendCuratorReminderNotification({ to: student.email, body });

  return { lastReminderAt: now.toISOString() };
}
