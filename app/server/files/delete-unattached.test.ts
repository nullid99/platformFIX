// Vitest doesn't auto-load .env the way Next.js/Prisma CLI do — see stream-service.test.ts.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { fileService } from "./file-service";

/**
 * Security review STG-4 (2026-10-17): deleting your own file used to `rm` the bytes first and only
 * checked ДЗ attachments, so a file already attached elsewhere was wiped from disk and left as a
 * broken attachment. It must now be refused with the bytes intact.
 */
describe("fileService file removal (STG-4, STG-5)", () => {
  const suffix = randomUUID().slice(0, 8);
  const savedRoot = process.env.FILE_STORAGE_ROOT;
  let root: string;
  let practicumId: string;
  let studentId: string;
  let attachedFileId: string;
  let looseFileId: string;

  const createFile = async (name: string) => {
    const storageKey = `vitest/${suffix}/${name}`;
    await mkdir(join(root, "vitest", suffix), { recursive: true });
    await writeFile(join(root, storageKey), "data");
    const file = await prisma.storedFile.create({ data: { ownerId: studentId, storageKey, originalName: name, mimeType: "image/png", byteSize: 4, status: "UPLOADED" }, select: { id: true } });
    return { id: file.id, path: join(root, storageKey) };
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "vitest-files-"));
    process.env.FILE_STORAGE_ROOT = root;
    practicumId = (await prisma.practicum.create({ data: { title: `Vitest delete-file ${suffix}`, isActive: false }, select: { id: true } })).id;
    studentId = (await prisma.user.create({ data: { role: UserRole.STUDENT, status: UserStatus.ACTIVE, email: `vitest-file-${suffix}@example.test` }, select: { id: true } })).id;
    attachedFileId = (await createFile("attached.png")).id;
    looseFileId = (await createFile("loose.png")).id;
    await prisma.streamMessage.create({ data: { practicumId, authorId: studentId, body: "vitest", fileId: attachedFileId } });
  });

  afterAll(async () => {
    await prisma.streamMessage.deleteMany({ where: { practicumId } });
    await prisma.storedFile.deleteMany({ where: { ownerId: studentId } });
    await prisma.user.deleteMany({ where: { id: studentId } });
    await prisma.practicum.deleteMany({ where: { id: practicumId } });
    await rm(root, { recursive: true, force: true });
    process.env.FILE_STORAGE_ROOT = savedRoot;
  });

  it("refuses a file attached to a chat message and keeps its bytes", async () => {
    await expect(fileService.deleteUnattached(studentId, attachedFileId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await prisma.storedFile.findUnique({ where: { id: attachedFileId } })).not.toBeNull();
    await expect(stat(join(root, "vitest", suffix, "attached.png"))).resolves.toBeTruthy();
  });

  it("cleans up only uploads that never finished and are old enough (STG-5)", async () => {
    const stale = await createFile("stale.png");
    const fresh = await createFile("fresh.png");
    await prisma.storedFile.update({ where: { id: stale.id }, data: { status: "PENDING", createdAt: new Date(Date.now() - 2 * 86_400_000) } });
    await prisma.storedFile.update({ where: { id: fresh.id }, data: { status: "PENDING" } });
    await fileService.cleanupStaleUploads(86_400_000);
    expect(await prisma.storedFile.findUnique({ where: { id: stale.id } })).toBeNull();
    await expect(stat(stale.path)).rejects.toThrow();
    expect(await prisma.storedFile.findUnique({ where: { id: fresh.id } })).not.toBeNull();
    expect(await prisma.storedFile.findUnique({ where: { id: attachedFileId } })).not.toBeNull();
  });

  it("deletes a file nothing points at, row and bytes", async () => {
    await expect(fileService.deleteUnattached(studentId, looseFileId)).resolves.toBeUndefined();
    expect(await prisma.storedFile.findUnique({ where: { id: looseFileId } })).toBeNull();
    await expect(stat(join(root, "vitest", suffix, "loose.png"))).rejects.toThrow();
  });
});
