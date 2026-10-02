// See stream-service.test.ts for why this import is needed locally and a no-op in CI.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityProvider, MediaAssetKind, MediaAssetStatus, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { courseService } from "./course-service";

/**
 * Regression test for a real report (2026-09-28): a curator added a Vimeo video to a lesson,
 * deleted it, then tried to add the same video to the same lesson again and got "This Vimeo
 * video is already in the media library". "Удалить" only archives the row, but the
 * (provider, providerKey, moduleId) unique index still counted it. createVimeoMedia now revives
 * the archived row instead of inserting a second one.
 */
describe("courseService#createVimeoMedia — re-adding a deleted video", () => {
  const suffix = randomUUID().slice(0, 8);
  const vimeoUrl = `https://vimeo.com/9${Date.now().toString().slice(-8)}`;
  let practicumId: string;
  let createdPracticumId: string | null = null;
  let curatorId: string;
  let moduleId: string;

  beforeAll(async () => {
    const existingPracticum = await prisma.practicum.findFirst({ where: { isActive: true }, select: { id: true } });
    if (existingPracticum) {
      practicumId = existingPracticum.id;
    } else {
      const created = await prisma.practicum.create({ data: { title: `Vitest media-readd fixture ${suffix}`, isActive: true } });
      practicumId = created.id;
      createdPracticumId = created.id;
    }
    const curator = await prisma.user.create({
      data: { role: UserRole.CURATOR, status: UserStatus.ACTIVE, email: `vitest-curator-${suffix}@example.com`, externalIdentities: { create: { provider: IdentityProvider.LOCAL, providerSubject: `vitest-curator-${suffix}`, username: "vitest-curator" } } },
      select: { id: true },
    });
    curatorId = curator.id;
    const module_ = await prisma.module.create({ data: { practicumId, title: `Vitest media module ${suffix}`, position: 999_300 }, select: { id: true } });
    moduleId = module_.id;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { actorId: curatorId } });
    await prisma.mediaAsset.deleteMany({ where: { moduleId } });
    await prisma.module.deleteMany({ where: { id: moduleId } });
    await prisma.user.deleteMany({ where: { id: curatorId } });
    if (createdPracticumId) await prisma.practicum.deleteMany({ where: { id: createdPracticumId } });
  });

  it("revives the archived row with the new values instead of failing as a duplicate", async () => {
    const first = await courseService.createVimeoMedia(curatorId, { moduleId, title: "Первый раз", kind: MediaAssetKind.STREAM, vimeoUrl });
    await courseService.archiveMedia(curatorId, first.id);

    const again = await courseService.createVimeoMedia(curatorId, { moduleId, title: "Второй раз", kind: MediaAssetKind.QA, vimeoUrl });

    expect(again.id).toBe(first.id);
    const rows = await prisma.mediaAsset.findMany({ where: { moduleId }, select: { status: true, title: true, kind: true } });
    expect(rows).toEqual([{ status: MediaAssetStatus.DRAFT, title: "Второй раз", kind: MediaAssetKind.QA }]);
  });

  it("still refuses a real duplicate (the video is active in the lesson), in Russian", async () => {
    await expect(courseService.createVimeoMedia(curatorId, { moduleId, title: "Дубль", kind: MediaAssetKind.STREAM, vimeoUrl })).rejects.toThrow("Это видео уже добавлено в этот урок");
  });
});
