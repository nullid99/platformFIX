// See stream-service.test.ts for why this import is needed locally and a no-op in CI.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EnrollmentStatus, IdentityProvider, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { assignmentService } from "./assignment-service";

/**
 * Regression test for a real report (2026-10-01): creating one ДЗ in the current поток pulled two
 * students from a finished test cohort into it. assignmentService#create used to upsert an
 * Enrollment for every active student on the platform; it must only open lesson access for
 * students already enrolled in that поток.
 */
describe("assignmentService#create — never enrolls students from other потоки", () => {
  const suffix = randomUUID().slice(0, 8);
  let practicumId: string;
  let otherPracticumId: string;
  let curatorId: string;
  let ownStudentId: string;
  let outsiderId: string;
  let moduleId: string;
  let assignmentId: string | null = null;

  const user = (role: UserRole, label: string) => prisma.user.create({
    data: { role, status: UserStatus.ACTIVE, email: `vitest-${label}-${suffix}@example.com`, externalIdentities: { create: { provider: IdentityProvider.LOCAL, providerSubject: `vitest-${label}-${suffix}`, username: `vitest-${label}` } } },
    select: { id: true },
  });

  beforeAll(async () => {
    // Neither practicum is active, so this never touches the real "current поток".
    practicumId = (await prisma.practicum.create({ data: { title: `Vitest scope ${suffix}`, isActive: false } })).id;
    otherPracticumId = (await prisma.practicum.create({ data: { title: `Vitest other ${suffix}`, isActive: false } })).id;
    curatorId = (await user(UserRole.CURATOR, "curator")).id;
    ownStudentId = (await user(UserRole.STUDENT, "own")).id;
    outsiderId = (await user(UserRole.STUDENT, "outsider")).id;
    await prisma.enrollment.create({ data: { studentId: ownStudentId, practicumId, status: EnrollmentStatus.ACTIVE } });
    await prisma.enrollment.create({ data: { studentId: outsiderId, practicumId: otherPracticumId, status: EnrollmentStatus.ACTIVE } });
    moduleId = (await prisma.module.create({ data: { practicumId, title: `Vitest module ${suffix}`, position: 999_400 }, select: { id: true } })).id;
  });

  afterAll(async () => {
    if (assignmentId) await prisma.assignment.deleteMany({ where: { id: assignmentId } });
    await prisma.practicum.deleteMany({ where: { id: { in: [practicumId, otherPracticumId] } } }); // cascades enrollments/modules
    await prisma.user.deleteMany({ where: { id: { in: [curatorId, ownStudentId, outsiderId] } } });
  });

  it("opens the lesson for the поток's own students and leaves everyone else alone", async () => {
    const created = await assignmentService.create(curatorId, { moduleId, title: "Vitest ДЗ", description: "fixture", requirements: [], allowedFormats: [] });
    assignmentId = created.id;

    const outsiderEnrollments = await prisma.enrollment.findMany({ where: { studentId: outsiderId }, select: { practicumId: true } });
    expect(outsiderEnrollments).toEqual([{ practicumId: otherPracticumId }]);
    const ownEnrollment = await prisma.enrollment.findUnique({ where: { studentId_practicumId: { studentId: ownStudentId, practicumId } }, select: { id: true } });
    expect(ownEnrollment).not.toBeNull();
  });
});
