// Vitest doesn't auto-load .env the way Next.js/Prisma CLI do — see stream-service.test.ts.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { authService, isLocalTestAuthEnabled } from "./auth-service";

/**
 * Security review 2026-10-17. STG-2/3: a curator's "student" edits (email, Advanced) used to
 * write first and check the role after, so aimed at another curator or the owner they returned
 * 400 with the change already saved. STG-11: dev-login was switchable on in a production build.
 */
describe("student edits only touch students (STG-2/3)", () => {
  const suffix = randomUUID().slice(0, 8);
  let curatorId: string;
  let otherCuratorId: string;
  let studentId: string;

  beforeAll(async () => {
    const make = (role: UserRole, name: string) => prisma.user.create({ data: { role, status: UserStatus.ACTIVE, email: `${name}-${suffix}@example.test` }, select: { id: true } });
    curatorId = (await make(UserRole.CURATOR, "vitest-curator")).id;
    otherCuratorId = (await make(UserRole.CURATOR, "vitest-target")).id;
    studentId = (await make(UserRole.STUDENT, "vitest-student")).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [curatorId, otherCuratorId, studentId] } } });
  });

  it("refuses a non-student and leaves its email unchanged", async () => {
    await expect(authService.updateStudentEmail(curatorId, otherCuratorId, `attacker-${suffix}@example.test`)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const target = await prisma.user.findUniqueOrThrow({ where: { id: otherCuratorId }, select: { email: true } });
    expect(target.email).toBe(`vitest-target-${suffix}@example.test`);
  });

  it("refuses a non-student and leaves its Advanced flag unchanged", async () => {
    await expect(authService.setStudentAdvanced(curatorId, otherCuratorId, true)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const target = await prisma.user.findUniqueOrThrow({ where: { id: otherCuratorId }, select: { isAdvanced: true } });
    expect(target.isAdvanced).toBe(false);
  });

  it("still edits a real student", async () => {
    await expect(authService.updateStudentEmail(curatorId, studentId, `new-${suffix}@example.test`)).resolves.toBe(`new-${suffix}@example.test`);
    await expect(authService.setStudentAdvanced(curatorId, studentId, true)).resolves.toBe(true);
  });
});

describe("isLocalTestAuthEnabled (STG-11)", () => {
  const saved = { dev: process.env.DEV_AUTH_ENABLED, staging: process.env.STAGING_DEV_AUTH_ENABLED, nodeEnv: process.env.NODE_ENV };
  const env = process.env as Record<string, string | undefined>;

  afterEach(() => {
    env.DEV_AUTH_ENABLED = saved.dev;
    env.STAGING_DEV_AUTH_ENABLED = saved.staging;
    env.NODE_ENV = saved.nodeEnv;
  });

  it("is off in a production build even with every flag on", () => {
    env.NODE_ENV = "production";
    env.DEV_AUTH_ENABLED = "true";
    env.STAGING_DEV_AUTH_ENABLED = "true";
    expect(isLocalTestAuthEnabled()).toBe(false);
  });

  it("works for local development when asked for", () => {
    env.NODE_ENV = "development";
    env.DEV_AUTH_ENABLED = "true";
    expect(isLocalTestAuthEnabled()).toBe(true);
  });
});
