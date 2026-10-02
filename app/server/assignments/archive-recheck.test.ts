// See stream-service.test.ts for why this import is needed locally and a no-op in CI.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AssignmentStatus, IdentityProvider, ModuleAccessStatus, SubmissionStatus, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { assignmentService } from "./assignment-service";

/**
 * Regression test for a real report (2026-09-07): a module held two assignments; a student had
 * already been accepted on the first, the curator deleted (archived) the second one — and the
 * module never unlocked the next one, even though every assignment actually left in it was
 * accepted. assignmentService#decide only re-checks "is this module now fully accepted" at the
 * moment a submission gets accepted; nothing re-ran that check afterwards, so a student blocked
 * solely by an assignment that no longer exists stayed stuck behind the "Сначала сдайте ДЗ
 * модуля X" gate forever. archive() now re-runs that same check for every enrolled student
 * immediately after archiving.
 */
describe("assignmentService#archive — module completion recheck", () => {
  const suffix = randomUUID().slice(0, 8);
  let practicumId: string;
  let createdPracticumId: string | null = null;
  let curatorId: string;
  let studentId: string;
  let enrollmentId: string;
  let moduleId: string;
  let nextModuleId: string;
  let keptAssignmentId: string;
  let deletedAssignmentId: string;

  beforeAll(async () => {
    const existingPracticum = await prisma.practicum.findFirst({ where: { isActive: true }, select: { id: true } });
    if (existingPracticum) {
      practicumId = existingPracticum.id;
    } else {
      const created = await prisma.practicum.create({ data: { title: `Vitest archive-recheck fixture ${suffix}`, isActive: true } });
      practicumId = created.id;
      createdPracticumId = created.id;
    }

    const curator = await prisma.user.create({
      data: { role: UserRole.CURATOR, status: UserStatus.ACTIVE, email: `vitest-curator-${suffix}@example.com`, externalIdentities: { create: { provider: IdentityProvider.LOCAL, providerSubject: `vitest-curator-${suffix}`, username: "vitest-curator" } } },
      select: { id: true },
    });
    curatorId = curator.id;
    const student = await prisma.user.create({
      data: { role: UserRole.STUDENT, status: UserStatus.ACTIVE, email: `vitest-student-${suffix}@example.com`, externalIdentities: { create: { provider: IdentityProvider.LOCAL, providerSubject: `vitest-student-${suffix}`, username: "vitest-student" } } },
      select: { id: true },
    });
    studentId = student.id;

    // Two modules in their own dedicated (high, never-colliding) position band, so the
    // prerequisite gate has a real "next module" to (not) unlock.
    const module_ = await prisma.module.create({ data: { practicumId, title: `Vitest module ${suffix}`, position: 999_200 }, select: { id: true } });
    moduleId = module_.id;
    // Already opened by the curator for the поток — only then does finishing the previous lesson
    // open it for this student (a lesson still "Закрыт" stays closed; see completion-respects-lock.test.ts).
    const nextModule = await prisma.module.create({ data: { practicumId, title: `Vitest next module ${suffix}`, position: 999_201, defaultAccess: ModuleAccessStatus.UNLOCKED }, select: { id: true } });
    nextModuleId = nextModule.id;

    const kept = await prisma.assignment.create({ data: { moduleId, practicumId, title: "Vitest kept assignment", description: "fixture", status: AssignmentStatus.PUBLISHED }, select: { id: true } });
    keptAssignmentId = kept.id;
    const toDelete = await prisma.assignment.create({ data: { moduleId, practicumId, title: "Vitest to-delete assignment", description: "fixture", status: AssignmentStatus.PUBLISHED }, select: { id: true } });
    deletedAssignmentId = toDelete.id;

    const enrollment = await prisma.enrollment.create({ data: { studentId, practicumId, status: "ACTIVE" }, select: { id: true } });
    enrollmentId = enrollment.id;
    await prisma.enrollmentModuleAccess.create({ data: { enrollmentId, moduleId, status: ModuleAccessStatus.UNLOCKED, unlockedAt: new Date() } });

    // The student is fully done with the assignment that will remain — accepted, first attempt.
    await prisma.submission.create({ data: { assignmentId: keptAssignmentId, studentId, status: SubmissionStatus.ACCEPTED, submittedAt: new Date() } });
    // ...but never got anywhere with the one the curator is about to delete — no submission at all.
  });

  afterAll(async () => {
    await prisma.submission.deleteMany({ where: { assignmentId: { in: [keptAssignmentId, deletedAssignmentId] } } });
    await prisma.assignment.deleteMany({ where: { id: { in: [keptAssignmentId, deletedAssignmentId] } } });
    await prisma.enrollmentModuleAccess.deleteMany({ where: { enrollmentId } });
    await prisma.enrollment.deleteMany({ where: { id: enrollmentId } });
    await prisma.module.deleteMany({ where: { id: { in: [moduleId, nextModuleId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [studentId, curatorId] } } });
    if (createdPracticumId) await prisma.practicum.deleteMany({ where: { id: createdPracticumId } });
  });

  async function waitForModuleCompleted(timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const access = await prisma.enrollmentModuleAccess.findUnique({ where: { enrollmentId_moduleId: { enrollmentId, moduleId } }, select: { status: true } });
      if (access?.status === ModuleAccessStatus.COMPLETED) return access;
      if (Date.now() > deadline) return access;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it("completes the module once the only missing assignment is deleted, and unlocks the next one", async () => {
    const before = await prisma.enrollmentModuleAccess.findUnique({ where: { enrollmentId_moduleId: { enrollmentId, moduleId } }, select: { status: true } });
    expect(before?.status).toBe(ModuleAccessStatus.UNLOCKED);

    await assignmentService.archive(curatorId, deletedAssignmentId);

    const after = await waitForModuleCompleted();
    expect(after?.status).toBe(ModuleAccessStatus.COMPLETED);

    const nextAccess = await prisma.enrollmentModuleAccess.findUnique({ where: { enrollmentId_moduleId: { enrollmentId, moduleId: nextModuleId } }, select: { status: true } });
    expect(nextAccess?.status).toBe(ModuleAccessStatus.UNLOCKED);
  });
});
