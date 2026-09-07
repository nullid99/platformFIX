// See stream-service.test.ts for why this import is needed locally and a no-op in CI.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AssignmentStatus, IdentityProvider, SubmissionStatus, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { assignmentService } from "./assignment-service";

/**
 * Regression test for a real staging report (2026-09-07): a curator claims a submission for
 * review, an owner's page is stale (hasn't refreshed) and clicks "Взять на проверку" on the same
 * submission a moment later — the submission silently ends up reassigned to the owner, with no
 * error and no confirmation. The same race in the other order (owner claims first, curator's
 * stale page claims second) correctly rejected the curator with AUTH_CONFLICT — so the behavior
 * was asymmetric depending only on which role lost the race, not on who actually claimed first.
 *
 * The cause was an owner-only bypass in AssignmentService#claim's "already claimed by someone
 * else" check. The owner doesn't need it for anything legitimate — releaseClaim already lets an
 * owner free up any curator's claim first, as a separate deliberate action — so the fix just
 * removes the bypass, making the race symmetric: whoever's request actually lands first keeps
 * the claim, and the loser (regardless of role) gets a clear, consistent error.
 */
describe("assignmentService#claim — owner vs curator race", () => {
  const suffix = randomUUID().slice(0, 8);
  let practicumId: string;
  let createdPracticumId: string | null = null;
  let moduleId: string;
  let assignmentId: string;
  let studentId: string;
  let curatorId: string;
  let ownerId: string;

  beforeAll(async () => {
    const existingPracticum = await prisma.practicum.findFirst({ where: { isActive: true }, select: { id: true } });
    if (existingPracticum) {
      practicumId = existingPracticum.id;
    } else {
      const created = await prisma.practicum.create({ data: { title: `Vitest claim-race fixture ${suffix}`, isActive: true } });
      practicumId = created.id;
      createdPracticumId = created.id;
    }

    const module_ = await prisma.module.create({ data: { practicumId, title: `Vitest claim-race module ${suffix}`, position: 999_100 }, select: { id: true } });
    moduleId = module_.id;
    const assignment = await prisma.assignment.create({ data: { moduleId, title: "Vitest claim-race assignment", description: "fixture", status: AssignmentStatus.PUBLISHED }, select: { id: true } });
    assignmentId = assignment.id;

    const student = await prisma.user.create({
      data: { role: UserRole.STUDENT, status: UserStatus.ACTIVE, email: `vitest-student-${suffix}@example.com`, externalIdentities: { create: { provider: IdentityProvider.LOCAL, providerSubject: `vitest-student-${suffix}`, username: "vitest-student" } } },
      select: { id: true },
    });
    studentId = student.id;
    const curator = await prisma.user.create({
      data: { role: UserRole.CURATOR, status: UserStatus.ACTIVE, email: `vitest-curator-${suffix}@example.com`, externalIdentities: { create: { provider: IdentityProvider.LOCAL, providerSubject: `vitest-curator-${suffix}`, username: "vitest-curator" } } },
      select: { id: true },
    });
    curatorId = curator.id;
    const owner = await prisma.user.create({
      data: { role: UserRole.OWNER, status: UserStatus.ACTIVE, email: `vitest-owner-${suffix}@example.com`, externalIdentities: { create: { provider: IdentityProvider.LOCAL, providerSubject: `vitest-owner-${suffix}`, username: "vitest-owner" } } },
      select: { id: true },
    });
    ownerId = owner.id;
  });

  afterAll(async () => {
    await prisma.submission.deleteMany({ where: { assignmentId } });
    await prisma.assignment.deleteMany({ where: { id: assignmentId } });
    await prisma.module.deleteMany({ where: { id: moduleId } });
    await prisma.user.deleteMany({ where: { id: { in: [studentId, curatorId, ownerId] } } });
    if (createdPracticumId) await prisma.practicum.deleteMany({ where: { id: createdPracticumId } });
  });

  it("does not let a stale owner silently steal a curator's claim", async () => {
    const submission = await prisma.submission.create({ data: { assignmentId, studentId, status: SubmissionStatus.SUBMITTED }, select: { id: true } });

    const curatorClaim = await assignmentService.claim(curatorId, submission.id);
    expect(curatorClaim.reviewerId).toBe(curatorId);

    await expect(assignmentService.claim(ownerId, submission.id)).rejects.toMatchObject({ code: "AUTH_CONFLICT" });

    const after = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id }, select: { reviewerId: true } });
    expect(after.reviewerId).toBe(curatorId);
  });

  it("symmetrically rejects a stale curator claiming after the owner already has it", async () => {
    const submission = await prisma.submission.create({ data: { assignmentId, studentId, status: SubmissionStatus.SUBMITTED, attempt: 2 }, select: { id: true } });

    const ownerClaim = await assignmentService.claim(ownerId, submission.id);
    expect(ownerClaim.reviewerId).toBe(ownerId);

    await expect(assignmentService.claim(curatorId, submission.id)).rejects.toMatchObject({ code: "AUTH_CONFLICT" });

    const after = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id }, select: { reviewerId: true } });
    expect(after.reviewerId).toBe(ownerId);
  });
});
