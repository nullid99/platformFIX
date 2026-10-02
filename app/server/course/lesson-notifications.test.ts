// See stream-service.test.ts for why this import is needed locally and a no-op in CI.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EnrollmentStatus, IdentityProvider, ModuleAccessStatus, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { assignmentService } from "@/app/server/assignments/assignment-service";
import { courseService } from "./course-service";

/**
 * Lesson notification rules (requested 2026-10-02): nothing inside a closed lesson is announced;
 * opening it sends "Урок открыт"; once open, new ДЗ/recordings are announced. Emails go to the
 * same recipients as the bell, so the bell rows are what's asserted here (no Resend key in tests).
 */
describe("lesson notifications follow the lesson's open/closed state", () => {
  const suffix = randomUUID().slice(0, 8);
  let practicumId: string;
  let curatorId: string;
  let studentId: string;
  let moduleId: string;
  const assignmentIds: string[] = [];

  const user = (role: UserRole, label: string) => prisma.user.create({
    data: { role, status: UserStatus.ACTIVE, email: `vitest-notify-${label}-${suffix}@example.com`, externalIdentities: { create: { provider: IdentityProvider.LOCAL, providerSubject: `vitest-notify-${label}-${suffix}`, username: `vitest-${label}` } } },
    select: { id: true },
  });

  async function bells(type: string, timeoutMs = 1_500) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await prisma.notification.findMany({ where: { userId: studentId, type: type as never }, select: { title: true } });
      if (rows.length > 0 || Date.now() > deadline) return rows;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  beforeAll(async () => {
    practicumId = (await prisma.practicum.create({ data: { title: `Vitest notify ${suffix}`, isActive: false } })).id;
    curatorId = (await user(UserRole.CURATOR, "curator")).id;
    studentId = (await user(UserRole.STUDENT, "student")).id;
    await prisma.enrollment.create({ data: { studentId, practicumId, status: EnrollmentStatus.ACTIVE } });
    moduleId = (await prisma.module.create({ data: { practicumId, title: `Урок ${suffix}`, position: 0, defaultAccess: ModuleAccessStatus.LOCKED }, select: { id: true } })).id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: studentId } });
    await prisma.assignment.deleteMany({ where: { id: { in: assignmentIds } } });
    await prisma.practicum.deleteMany({ where: { id: practicumId } });
    await prisma.user.deleteMany({ where: { id: { in: [curatorId, studentId] } } });
  });

  it("closed lesson: a new ДЗ is not announced", async () => {
    const created = await assignmentService.create(curatorId, { moduleId, title: "ДЗ в закрытом уроке", description: "fixture", requirements: [], allowedFormats: [] });
    assignmentIds.push(created.id);
    expect(await bells("NEW_ASSIGNMENT")).toEqual([]);
  });

  it("opening the lesson sends 'Урок открыт' and a bell for the ДЗ already inside (sidebar counter)", async () => {
    await courseService.setModuleAccess(curatorId, moduleId, true);
    expect(await bells("MODULE_OPENED")).toEqual([{ title: `Открыт урок: Урок ${suffix}` }]);
    expect(await bells("NEW_ASSIGNMENT")).toEqual([{ title: "Новое задание: ДЗ в закрытом уроке" }]);
  });

  it("open lesson: a new ДЗ is announced", async () => {
    const created = await assignmentService.create(curatorId, { moduleId, title: "ДЗ в открытом уроке", description: "fixture", requirements: [], allowedFormats: [] });
    assignmentIds.push(created.id);
    const deadline = Date.now() + 1_500;
    let titles: string[] = [];
    while (Date.now() < deadline) {
      titles = (await bells("NEW_ASSIGNMENT")).map((row) => row.title);
      if (titles.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(titles.sort()).toEqual(["Новое задание: ДЗ в закрытом уроке", "Новое задание: ДЗ в открытом уроке"]);
  });
});
