// See stream-service.test.ts for why this import is needed locally and a no-op in CI.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EnrollmentStatus, IdentityProvider, ModuleAccessStatus, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { courseService } from "./course-service";

/**
 * Regression test for a real report (2026-10-02): a student finished the first lesson's
 * "ДЗ без проверки" and Market Logic opened for them, although the curator still had it "Закрыт"
 * in "Программа". Finishing a lesson must never open the next one ahead of the curator.
 */
describe("courseService#completeModuleForStudent — respects a lesson the curator keeps closed", () => {
  const suffix = randomUUID().slice(0, 8);
  let practicumId: string;
  let studentId: string;
  let enrollmentId: string;
  let firstId: string;
  let closedNextId: string;

  beforeAll(async () => {
    // Inactive practicum of its own, so nothing here touches the real current поток.
    practicumId = (await prisma.practicum.create({ data: { title: `Vitest lock ${suffix}`, isActive: false } })).id;
    studentId = (await prisma.user.create({
      data: { role: UserRole.STUDENT, status: UserStatus.ACTIVE, email: `vitest-lock-${suffix}@example.com`, externalIdentities: { create: { provider: IdentityProvider.LOCAL, providerSubject: `vitest-lock-${suffix}`, username: "vitest-lock" } } },
      select: { id: true },
    })).id;
    enrollmentId = (await prisma.enrollment.create({ data: { studentId, practicumId, status: EnrollmentStatus.ACTIVE }, select: { id: true } })).id;
    firstId = (await prisma.module.create({ data: { practicumId, title: "Знакомство", position: 0, defaultAccess: ModuleAccessStatus.UNLOCKED }, select: { id: true } })).id;
    closedNextId = (await prisma.module.create({ data: { practicumId, title: "Market Logic", position: 1, defaultAccess: ModuleAccessStatus.LOCKED }, select: { id: true } })).id;
    await prisma.enrollmentModuleAccess.create({ data: { enrollmentId, moduleId: firstId, status: ModuleAccessStatus.UNLOCKED, unlockedAt: new Date() } });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: studentId } });
    await prisma.practicum.deleteMany({ where: { id: practicumId } }); // cascades enrollment/modules/access
    await prisma.user.deleteMany({ where: { id: studentId } });
  });

  it("completes the lesson but leaves the next one closed while the curator has it closed", async () => {
    const result = await courseService.completeModuleForStudent(studentId, firstId);
    expect(result.status).toBe(ModuleAccessStatus.COMPLETED);
    expect(result.nextModuleUnlocked).toBeNull();
    const next = await prisma.enrollmentModuleAccess.findUnique({ where: { enrollmentId_moduleId: { enrollmentId, moduleId: closedNextId } }, select: { status: true } });
    expect(next?.status ?? ModuleAccessStatus.LOCKED).toBe(ModuleAccessStatus.LOCKED);
  });
});
