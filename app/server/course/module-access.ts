import { Prisma } from "@/app/generated/prisma/client";
import { ModuleAccessStatus } from "@/app/generated/prisma/enums";

/**
 * A module access row isn't created until a curator's per-module toggle (or an individual
 * override) touches it — a fresh enrollment otherwise starts with zero rows and every
 * module reads as locked regardless of Module.defaultAccess. Called wherever an Enrollment
 * gets created (invitation acceptance, the assignment-creation safety-net upsert) so a
 * student's first visit shows whatever is already open to the cohort. skipDuplicates makes
 * it safe to re-run for an already-enrolled student too, healing anyone left behind by
 * modules opened after they first joined.
 *
 * Kept dependency-free of the auth and assignment services (which both call this) to avoid
 * a circular import — they'd otherwise end up importing each other through course-service.
 */
export async function seedOpenModuleAccess(tx: Prisma.TransactionClient, enrollmentId: string, practicumId: string): Promise<void> {
  const openModules = await tx.module.findMany({ where: { practicumId, defaultAccess: ModuleAccessStatus.UNLOCKED }, select: { id: true } });
  if (openModules.length === 0) return;
  await tx.enrollmentModuleAccess.createMany({
    data: openModules.map((courseModule) => ({ enrollmentId, moduleId: courseModule.id, status: ModuleAccessStatus.UNLOCKED, unlockedAt: new Date() })),
    skipDuplicates: true,
  });
}

/**
 * The prerequisite gate for submitting an assignment in a module at `modulePosition`: null
 * if there's no module before it (nothing to require), otherwise the title of the module
 * that must be marked completed first (see CourseService.markModuleCompletedForStudent) —
 * still null once that's done. Used both server-side in assignment-service.ts#submit (the
 * actual enforcement) and in #listForStudent (so the student sees why a card is locked
 * before they try).
 */
export async function assignmentPrerequisiteGate(client: Prisma.TransactionClient, studentId: string, practicumId: string, modulePosition: number): Promise<string | null> {
  const previousModule = await client.module.findFirst({ where: { practicumId, position: { lt: modulePosition } }, orderBy: { position: "desc" }, select: { id: true, title: true } });
  if (!previousModule) return null;
  const enrollment = await client.enrollment.findFirst({ where: { studentId, practicumId, status: "ACTIVE" }, select: { id: true } });
  if (!enrollment) return previousModule.title;
  const access = await client.enrollmentModuleAccess.findUnique({ where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId: previousModule.id } }, select: { status: true } });
  return access?.status === ModuleAccessStatus.COMPLETED ? null : previousModule.title;
}
