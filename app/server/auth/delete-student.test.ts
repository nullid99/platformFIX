// Vitest doesn't auto-load .env the way Next.js/Prisma CLI do — see stream-service.test.ts for
// the same note. No-op in CI, where DATABASE_URL is already a workflow env var.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AssignmentStatus, EnrollmentStatus, IdentityProvider, SubmissionStatus, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { authService } from "./auth-service";

/**
 * authService#deleteStudent hard-deletes a User row plus everything reachable from it. Most of
 * that cascades/SetNulls on its own once the row is gone, but three FKs in the schema are
 * `onDelete: Restrict` and reachable from a student's own data (DiscussionMessage.author,
 * StreamMessage.author, SubmissionAttachment.file via the file's owner) — deleteStudent clears
 * those explicitly before calling user.delete() rather than trusting how Postgres orders
 * cascades across multiple FK paths converging on the same row in one statement. This test
 * builds a student with one of each of those (a ДЗ submission with an attached file, a
 * discussion thread they started with their own attached-file message plus a curator reply, and
 * a stream chat message) against a real database, and asserts deletion actually succeeds and
 * removes everything — a mocked Prisma client wouldn't catch a real FK violation.
 */
describe("authService#deleteStudent", () => {
  const suffix = randomUUID().slice(0, 8);
  let practicumId: string;
  let createdPracticumId: string | null = null;
  let curatorId: string;
  let moduleId: string;
  let assignmentId: string;
  let studentId: string;
  let threadId: string;

  beforeAll(async () => {
    const existingPracticum = await prisma.practicum.findFirst({ where: { isActive: true }, select: { id: true } });
    if (existingPracticum) {
      practicumId = existingPracticum.id;
    } else {
      const created = await prisma.practicum.create({ data: { title: `Vitest delete-student fixture ${suffix}`, isActive: true } });
      practicumId = created.id;
      createdPracticumId = created.id;
    }

    const curator = await prisma.user.create({
      data: {
        role: UserRole.CURATOR,
        status: UserStatus.ACTIVE,
        email: `vitest-curator-${suffix}@example.com`,
        externalIdentities: { create: { provider: IdentityProvider.LOCAL, providerSubject: `vitest-curator-${suffix}`, username: "vitest-curator", displayName: "Vitest Curator" } },
      },
      select: { id: true },
    });
    curatorId = curator.id;

    const module_ = await prisma.module.create({
      data: { practicumId, title: `Vitest module ${suffix}`, position: 999_000 },
      select: { id: true },
    });
    moduleId = module_.id;

    const assignment = await prisma.assignment.create({
      data: { moduleId, title: "Vitest assignment", description: "fixture", status: AssignmentStatus.PUBLISHED },
      select: { id: true },
    });
    assignmentId = assignment.id;

    const student = await prisma.user.create({
      data: {
        role: UserRole.STUDENT,
        status: UserStatus.ACTIVE,
        email: `vitest-student-${suffix}@example.com`,
        externalIdentities: { create: { provider: IdentityProvider.LOCAL, providerSubject: `vitest-student-${suffix}`, username: "vitest-student", displayName: "Vitest Student" } },
      },
      select: { id: true },
    });
    studentId = student.id;

    await prisma.session.create({
      data: {
        userId: studentId,
        tokenHash: `vitest-session-${suffix}`,
        status: "ACTIVE",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    const enrollment = await prisma.enrollment.create({
      data: { studentId, practicumId, status: EnrollmentStatus.ACTIVE },
      select: { id: true },
    });
    await prisma.enrollmentModuleAccess.create({
      data: { enrollmentId: enrollment.id, moduleId, status: "UNLOCKED" },
    });

    // A file the student uploaded and attached to their own ДЗ submission — exercises
    // SubmissionAttachment.file's onDelete: Restrict via the file's owner.
    const submissionFile = await prisma.storedFile.create({
      data: { ownerId: studentId, storageKey: `vitest/${suffix}/submission.png`, originalName: "submission.png", mimeType: "image/png", byteSize: 1234, status: "UPLOADED" },
      select: { id: true },
    });
    const submission = await prisma.submission.create({
      data: { assignmentId, studentId, status: SubmissionStatus.SUBMITTED, answerText: "vitest answer" },
      select: { id: true },
    });
    await prisma.submissionAttachment.create({ data: { submissionId: submission.id, fileId: submissionFile.id } });

    // A thread the student started: one message they authored themselves (with their own
    // attached file — exercises DiscussionMessage.author and DiscussionAttachment.file's
    // Restrict), plus a curator reply in the same thread (proves the curator's own row survives
    // elsewhere even though this specific reply gets removed along with the thread).
    const thread = await prisma.discussionThread.create({
      data: { studentId, curatorId, moduleId, title: "Vitest question" },
      select: { id: true },
    });
    threadId = thread.id;
    const discussionFile = await prisma.storedFile.create({
      data: { ownerId: studentId, storageKey: `vitest/${suffix}/discussion.png`, originalName: "discussion.png", mimeType: "image/png", byteSize: 999, status: "UPLOADED" },
      select: { id: true },
    });
    const studentMessage = await prisma.discussionMessage.create({ data: { threadId, authorId: studentId, body: "vitest question body" }, select: { id: true } });
    await prisma.discussionAttachment.create({ data: { messageId: studentMessage.id, fileId: discussionFile.id, originalName: "discussion.png", mimeType: "image/png", byteSize: 999 } });
    await prisma.discussionMessage.create({ data: { threadId, authorId: curatorId, body: "vitest curator reply" } });

    // Exercises StreamMessage.author's Restrict.
    await prisma.streamMessage.create({ data: { practicumId, authorId: studentId, body: "vitest chat message" } });
  });

  afterAll(async () => {
    // studentId's own rows are gone by the time the test runs (that's the point) — only the
    // fixtures that survive the deletion need cleaning up.
    await prisma.discussionThread.deleteMany({ where: { id: threadId } }).catch(() => undefined);
    await prisma.assignment.deleteMany({ where: { id: assignmentId } }).catch(() => undefined);
    await prisma.module.deleteMany({ where: { id: moduleId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: curatorId } }).catch(() => undefined);
    if (createdPracticumId) await prisma.practicum.deleteMany({ where: { id: createdPracticumId } }).catch(() => undefined);
  });

  it("deletes the student and everything reachable from them, without hitting a Restrict FK", async () => {
    await expect(authService.deleteStudent(curatorId, studentId)).resolves.toBeUndefined();

    expect(await prisma.user.findUnique({ where: { id: studentId } })).toBeNull();
    expect(await prisma.session.findMany({ where: { userId: studentId } })).toHaveLength(0);
    expect(await prisma.enrollment.findMany({ where: { studentId } })).toHaveLength(0);
    expect(await prisma.submission.findMany({ where: { studentId } })).toHaveLength(0);
    expect(await prisma.storedFile.findMany({ where: { ownerId: studentId } })).toHaveLength(0);
    expect(await prisma.streamMessage.findMany({ where: { authorId: studentId } })).toHaveLength(0);
    expect(await prisma.discussionThread.findUnique({ where: { id: threadId } })).toBeNull();
    expect(await prisma.discussionMessage.findMany({ where: { threadId } })).toHaveLength(0);

    // The curator who replied in that thread is a different user — untouched.
    const curator = await prisma.user.findUnique({ where: { id: curatorId }, select: { status: true } });
    expect(curator?.status).toBe(UserStatus.ACTIVE);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "security.student_deleted", objectId: studentId },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe(curatorId);
  });
});
