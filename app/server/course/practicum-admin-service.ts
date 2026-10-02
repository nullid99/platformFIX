import { MediaAssetStatus, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { AuthServiceError } from "@/app/server/auth";

export type PracticumSummary = { id: string; title: string; description: string | null; isActive: boolean; streamsPrivate: boolean; completedAt: Date | null; createdAt: Date };

const PRACTICUM_SUMMARY_SELECT = { id: true, title: true, description: true, isActive: true, streamsPrivate: true, completedAt: true, createdAt: true } as const;

async function assertOwner(actorId: string): Promise<void> {
  const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { role: true, status: true } });
  if (!actor || actor.status !== UserStatus.ACTIVE || actor.role !== UserRole.OWNER) {
    throw new AuthServiceError("FORBIDDEN", "Only an active owner can manage practicums");
  }
}

async function assertOwnerOrCurator(actorId: string): Promise<void> {
  const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { role: true, status: true } });
  if (!actor || actor.status !== UserStatus.ACTIVE || (actor.role !== UserRole.OWNER && actor.role !== UserRole.CURATOR)) {
    throw new AuthServiceError("FORBIDDEN", "Only an active owner or curator can view practicums");
  }
}

/**
 * Owner-only. Also points the owner's own workingPracticumId at the new practicum — they just
 * created it, so they're presumably about to build its content. A finished cohort's own
 * enrollments/modules/media keep pointing at its (now inactive) practicum forever — nothing about
 * their access changes. Kept out of practicum-service.ts (which auth-service.ts imports) so
 * importing AuthServiceError here can never form a cycle back through the auth barrel.
 */
export async function createNewPracticum(actorId: string, input: { title: string; description?: string }): Promise<PracticumSummary> {
  await assertOwner(actorId);
  const title = input.title?.trim().slice(0, 180);
  if (!title) throw new AuthServiceError("INVALID_INPUT", "title is required");
  const description = input.description?.trim().slice(0, 2_000) || null;

  return prisma.$transaction(async (tx) => {
    await tx.practicum.updateMany({ where: { isActive: true }, data: { isActive: false } });
    const practicum = await tx.practicum.create({ data: { title, description, isActive: true }, select: PRACTICUM_SUMMARY_SELECT });
    await tx.user.update({ where: { id: actorId }, data: { workingPracticumId: practicum.id } });
    return practicum;
  });
}

/**
 * Owner or curator — every past and present practicum, newest first. Owners use this to assign
 * the live-stream target; curators use it both to pick which practicum an invitation should
 * target and to pick their own working practicum (see setWorkingPracticum below).
 */
export async function listPracticums(actorId: string): Promise<PracticumSummary[]> {
  await assertOwnerOrCurator(actorId);
  return prisma.practicum.findMany({ orderBy: { createdAt: "desc" }, select: PRACTICUM_SUMMARY_SELECT });
}

/**
 * Owner or curator — points the caller's own content creation (module/schedule
 * event/standalone media/invitation default) at a specific practicum, independent of which one is
 * "active" for live streaming. Two staff members can each have a different one set at the same
 * time. `practicumId: null` clears the pick, falling back to the active practicum again — see
 * practicum-service.ts#getWorkingPracticumId.
 */
export async function setWorkingPracticum(actorId: string, practicumId: string | null): Promise<{ workingPracticumId: string | null }> {
  await assertOwnerOrCurator(actorId);
  if (practicumId) {
    const target = await prisma.practicum.findUnique({ where: { id: practicumId }, select: { id: true } });
    if (!target) throw new AuthServiceError("INVALID_INPUT", "Practicum does not exist");
  }
  const updated = await prisma.user.update({ where: { id: actorId }, data: { workingPracticumId: practicumId }, select: { workingPracticumId: true } });
  return updated;
}

/**
 * Owner-only — re-targets live streaming (LiveKit ingress, "Стримы") at an existing practicum
 * (including one already used before) instead of creating a fresh one. Every streaming resolver
 * reads getActivePracticumId live, so this alone moves the live target — it does NOT touch anyone's
 * workingPracticumId or where new content (modules/schedule/media/invitations) gets created.
 */
export async function setActivePracticum(actorId: string, practicumId: string): Promise<PracticumSummary> {
  await assertOwner(actorId);
  const target = await prisma.practicum.findUnique({ where: { id: practicumId }, select: { id: true, isActive: true } });
  if (!target) throw new AuthServiceError("INVALID_INPUT", "Practicum does not exist");
  if (target.isActive) {
    const current = await prisma.practicum.findUnique({ where: { id: practicumId }, select: PRACTICUM_SUMMARY_SELECT });
    if (!current) throw new AuthServiceError("INVALID_INPUT", "Practicum does not exist");
    return current;
  }

  return prisma.$transaction(async (tx) => {
    await tx.practicum.updateMany({ where: { isActive: true }, data: { isActive: false } });
    return tx.practicum.update({ where: { id: practicumId }, data: { isActive: true }, select: PRACTICUM_SUMMARY_SELECT });
  });
}

/**
 * Owner or curator — per-practicum "private stream" switch (see stream-visibility.ts for the
 * read side that stream-service.ts and the live notifier actually gate on). Deliberately
 * per-practicum, not global: a curator flips this on for a personal/1:1 session on the cohort
 * they're currently streaming to, and it must not silently carry over to whichever practicum
 * becomes active next — each row keeps its own value, defaulting to off for a brand-new one.
 */
export async function setPracticumStreamsPrivate(actorId: string, practicumId: string, streamsPrivate: boolean): Promise<PracticumSummary> {
  await assertOwnerOrCurator(actorId);
  const target = await prisma.practicum.findUnique({ where: { id: practicumId }, select: { id: true } });
  if (!target) throw new AuthServiceError("INVALID_INPUT", "Practicum does not exist");
  return prisma.practicum.update({ where: { id: practicumId }, data: { streamsPrivate }, select: PRACTICUM_SUMMARY_SELECT });
}

/**
 * Owner or curator, reversible — "Завершить поток" on the Потоки screen. Sets/clears
 * Practicum.completedAt, which every write path (assignment submission, discussion create/reply)
 * checks and refuses on — see practicum-service.ts#isPracticumCompleted. Read access (modules, ДЗ
 * history, recordings) is untouched; nothing here needs to know about it.
 */
export async function setPracticumCompleted(actorId: string, practicumId: string, completed: boolean): Promise<PracticumSummary> {
  await assertOwnerOrCurator(actorId);
  const target = await prisma.practicum.findUnique({ where: { id: practicumId }, select: { id: true } });
  if (!target) throw new AuthServiceError("INVALID_INPUT", "Practicum does not exist");
  return prisma.practicum.update({ where: { id: practicumId }, data: { completedAt: completed ? new Date() : null }, select: PRACTICUM_SUMMARY_SELECT });
}

export type PracticumDeletionImpact = {
  id: string;
  title: string;
  isActive: boolean;
  enrollments: number;
  modules: number;
  scheduleEvents: number;
  mediaAssets: number;
  assignments: number;
};

/**
 * Owner-only — what deletePracticum below would actually destroy, for the confirmation screen on
 * "Потоки". Every one of these tables cascades from Practicum in schema.prisma, so this list is
 * exactly what a delete wipes: not an estimate.
 */
export async function getPracticumDeletionImpact(actorId: string, practicumId: string): Promise<PracticumDeletionImpact> {
  await assertOwner(actorId);
  const practicum = await prisma.practicum.findUnique({ where: { id: practicumId }, select: { id: true, title: true, isActive: true } });
  if (!practicum) throw new AuthServiceError("INVALID_INPUT", "Practicum does not exist");
  const [enrollments, modules, scheduleEvents, mediaAssets, assignments] = await Promise.all([
    prisma.enrollment.count({ where: { practicumId } }),
    prisma.module.count({ where: { practicumId } }),
    prisma.scheduleEvent.count({ where: { practicumId } }),
    // Archived media (curator already deleted the recording — see course-service.ts#archiveMedia,
    // which also wipes the actual file) is an empty row with nothing left to actually lose. Only
    // count what deleting the practicum would really take away, or this warns about content
    // that's already gone.
    prisma.mediaAsset.count({ where: { practicumId, status: { not: MediaAssetStatus.ARCHIVED } } }),
    prisma.assignment.count({ where: { practicumId } }),
  ]);
  return { id: practicum.id, title: practicum.title, isActive: practicum.isActive, enrollments, modules, scheduleEvents, mediaAssets, assignments };
}

/**
 * Owner-only, permanent — every enrollment, module, assignment, submission, schedule event,
 * media asset and discussion under this practicum cascades away with it (see schema.prisma's
 * onDelete: Cascade on each). Two independent guards against a costly slip on top of the
 * frontend's own confirmation UI, since this route is reachable directly:
 *  - the currently-active (live-streaming) practicum can't be deleted out from under
 *    assertCuratorPracticum/getActivePracticumId, which assume one always exists — reassign
 *    "Назначить для эфиров" to another practicum first;
 *  - confirmTitle must match the practicum's exact title, the same "type the name" gate GitHub
 *    uses for repo deletion, re-checked server-side since a client-only check is trivially
 *    bypassed by calling the endpoint directly.
 */
export async function deletePracticum(actorId: string, practicumId: string, confirmTitle: string): Promise<void> {
  await assertOwner(actorId);
  const practicum = await prisma.practicum.findUnique({ where: { id: practicumId }, select: { id: true, title: true, isActive: true } });
  if (!practicum) throw new AuthServiceError("INVALID_INPUT", "Practicum does not exist");
  if (practicum.isActive) {
    throw new AuthServiceError("INVALID_INPUT", "Нельзя удалить поток, назначенный для эфиров — сначала назначьте другой поток для эфиров");
  }
  if (confirmTitle.trim() !== practicum.title) {
    throw new AuthServiceError("INVALID_INPUT", "Название потока введено неверно");
  }
  await prisma.practicum.delete({ where: { id: practicumId } });
}
