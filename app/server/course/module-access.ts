import { Prisma } from "@/app/generated/prisma/client";
import { AssignmentStatus, ModuleAccessStatus } from "@/app/generated/prisma/enums";

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
 * if there's no module before it, or if that module has no assignment of its own to ever
 * complete it with (nothing to require either way), otherwise the title of the module that
 * must be marked completed first (see CourseService.markModuleCompletedForStudent) — still
 * null once that's done. Used both server-side in assignment-service.ts#submit/
 * #completeWithoutReview (the actual enforcement) and in #listForStudent (so the student sees
 * why a card is locked before they try).
 */
export async function assignmentPrerequisiteGate(client: Prisma.TransactionClient, studentId: string, practicumId: string, modulePosition: number): Promise<string | null> {
  const previousModule = await client.module.findFirst({ where: { practicumId, position: { lt: modulePosition } }, orderBy: { position: "desc" }, select: { id: true, title: true } });
  if (!previousModule) return null;
  // A module with no assignment at all (regular or "без проверки") has nothing that could ever
  // mark it COMPLETED — see markModuleCompletedForStudent's auto-trigger, which only fires once
  // every assignment IN that module is accepted. Requiring a curator to remember a placeholder
  // "без проверки" assignment on every such lesson (typically Practice/Advanced, which by design
  // have no formal ДЗ) doesn't scale, so an assignment-free module simply never blocks the one
  // after it — no curator action needed.
  const assignmentCount = await client.assignment.count({ where: { moduleId: previousModule.id, status: AssignmentStatus.PUBLISHED } });
  if (assignmentCount === 0) return null;
  const enrollment = await client.enrollment.findFirst({ where: { studentId, practicumId, status: "ACTIVE" }, select: { id: true } });
  if (!enrollment) return previousModule.title;
  const access = await client.enrollmentModuleAccess.findUnique({ where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId: previousModule.id } }, select: { status: true } });
  return access?.status === ModuleAccessStatus.COMPLETED ? null : previousModule.title;
}

/**
 * Whether a module itself (not the one before it — see assignmentPrerequisiteGate) is open
 * to this student. A curator's "Закрыт" toggle on a module hides its assignments entirely
 * instead of showing them as a locked placeholder — closed means closed, not "visible but
 * greyed out". No enrollment or access row (LOCKED default) both read as closed.
 */
export async function isModuleOpenForStudent(client: Prisma.TransactionClient, studentId: string, practicumId: string, moduleId: string): Promise<boolean> {
  const enrollment = await client.enrollment.findFirst({ where: { studentId, practicumId, status: "ACTIVE" }, select: { id: true } });
  if (!enrollment) return false;
  const access = await client.enrollmentModuleAccess.findUnique({ where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId } }, select: { status: true } });
  return access?.status === ModuleAccessStatus.UNLOCKED || access?.status === ModuleAccessStatus.COMPLETED;
}
