// Vitest doesn't auto-load .env the way Next.js/Prisma CLI do — see stream-service.test.ts.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiscussionStatus, DiscussionVisibility, EnrollmentStatus, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { discussionService } from "./discussion-service";

/**
 * Security review STG-1 (2026-10-17): "Отвечено ранее" showed every answered thread of the cohort,
 * ignoring the student's PRIVATE/COHORT choice. Only COHORT threads may reach other students.
 */
describe("discussionService#listCohortForStudent (STG-1)", () => {
  const suffix = randomUUID().slice(0, 8);
  let practicumId: string;
  const userIds: string[] = [];
  let readerId: string;

  beforeAll(async () => {
    const user = async (role: UserRole, name: string) => {
      const created = await prisma.user.create({ data: { role, status: UserStatus.ACTIVE, email: `${name}-${suffix}@example.test` }, select: { id: true } });
      userIds.push(created.id);
      return created.id;
    };
    practicumId = (await prisma.practicum.create({ data: { title: `Vitest cohort feed ${suffix}`, isActive: false }, select: { id: true } })).id;
    const moduleId = (await prisma.module.create({ data: { practicumId, title: `Vitest module ${suffix}`, position: 999_001 }, select: { id: true } })).id;
    const curatorId = await user(UserRole.CURATOR, "vitest-cohort-curator");
    const askerId = await user(UserRole.STUDENT, "vitest-cohort-asker");
    readerId = await user(UserRole.STUDENT, "vitest-cohort-reader");
    for (const studentId of [askerId, readerId]) await prisma.enrollment.create({ data: { studentId, practicumId, status: EnrollmentStatus.ACTIVE } });

    for (const visibility of [DiscussionVisibility.PRIVATE, DiscussionVisibility.COHORT]) {
      await prisma.discussionThread.create({
        data: {
          studentId: askerId,
          curatorId,
          moduleId,
          title: `${visibility} question ${suffix}`,
          status: DiscussionStatus.ANSWERED,
          visibility,
          messages: { create: [{ authorId: askerId, body: "question" }, { authorId: curatorId, body: "answer" }] },
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.discussionThread.deleteMany({ where: { module: { practicumId } } });
    await prisma.enrollment.deleteMany({ where: { practicumId } });
    await prisma.module.deleteMany({ where: { practicumId } });
    await prisma.practicum.deleteMany({ where: { id: practicumId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("shows another student only the threads shared with the cohort", async () => {
    const feed = await discussionService.listCohortForStudent(readerId);
    expect(feed.map((thread) => thread.title)).toEqual([`COHORT question ${suffix}`]);
  });
});
