import { UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { AuthServiceError } from "@/app/server/auth";

export type PracticumSummary = { id: string; title: string; description: string | null; isActive: boolean; createdAt: Date };

const PRACTICUM_SUMMARY_SELECT = { id: true, title: true, description: true, isActive: true, createdAt: true } as const;

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
 * Owner-only. A finished cohort's own enrollments/modules/media keep pointing at its (now
 * inactive) practicum forever — nothing about their access changes. Kept out of
 * practicum-service.ts (which auth-service.ts imports) so importing AuthServiceError here can
 * never form a cycle back through the auth barrel.
 */
export async function createNewPracticum(actorId: string, input: { title: string; description?: string }): Promise<PracticumSummary> {
  await assertOwner(actorId);
  const title = input.title?.trim().slice(0, 180);
  if (!title) throw new AuthServiceError("INVALID_INPUT", "title is required");
  const description = input.description?.trim().slice(0, 2_000) || null;

  return prisma.$transaction(async (tx) => {
    await tx.practicum.updateMany({ where: { isActive: true }, data: { isActive: false } });
    return tx.practicum.create({ data: { title, description, isActive: true }, select: PRACTICUM_SUMMARY_SELECT });
  });
}

/**
 * Owner or curator — every past and present practicum, newest first. Owners use this to switch
 * the active one; curators use it to pick which practicum an invitation should target.
 */
export async function listPracticums(actorId: string): Promise<PracticumSummary[]> {
  await assertOwnerOrCurator(actorId);
  return prisma.practicum.findMany({ orderBy: { createdAt: "desc" }, select: PRACTICUM_SUMMARY_SELECT });
}

/**
 * Owner-only — re-activates an existing practicum (including one already used before) instead of
 * creating a fresh one. Every curator-side "current practicum" resolver reads getActivePracticumId
 * live, so this alone is enough to move all new activity (and live-stream targeting) back onto it
 * — nothing else needs updating.
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
