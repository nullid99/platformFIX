// Vitest doesn't auto-load .env the way Next.js/Prisma CLI do — needed locally so
// @/app/server/db sees DATABASE_URL; in CI it's already set as a workflow env var, so this is a
// no-op there (dotenv never overrides an existing value).
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebhookEvent } from "livekit-server-sdk";
import type { EgressInfo } from "@livekit/protocol";
import { IdentityProvider, MediaAssetKind, MediaAssetStatus, ScheduleEventType, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { streamService } from "./stream-service";
import { EgressStatus, LIVEKIT_ROOM_NAME } from "./livekit-client";

/**
 * Regression test for a real staging incident (2026-09-07): every completed recording silently
 * failed to appear in the Медиатека. The cause was `tx.$queryRaw` on `pg_advisory_xact_lock`
 * (a void-returning Postgres function) inside createMediaAssetFromRecording's transaction — the
 * adapter-pg driver can't deserialize a void result column, so the query threw, the whole
 * transaction rolled back, and nothing else in the call chain caught it (finishRecording is
 * invoked as `void this.finishRecording(...)` from the webhook handler, so the rejection had
 * nowhere to surface). Fixed by using `$executeRaw` instead, which doesn't try to decode a
 * result row. This test drives the exact same webhook entry point production traffic uses
 * (handleLiveKitWebhookEvent), against a real database (see vitest's DATABASE_URL / the CI
 * Postgres service) rather than a mocked Prisma client — a mock would never have caught this,
 * since the bug was specifically in how the real driver adapter handles a real query result.
 */
describe("stream-service: recording -> MediaAsset (regression: pg_advisory_xact_lock via $queryRaw)", () => {
  const providerKey = `recordings/vitest-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`;

  // createMediaAssetFromRecording needs an active practicum to attach the recording to — CI's
  // Postgres service starts empty (the "checks" job, where `npm test` runs, doesn't seed a
  // practicum the way the separate e2e job does), so without this the test would silently find
  // nothing to do there and never actually exercise the bug. Reuses one if it's already there
  // (true for local dev) instead of creating a second — Practicum.isActive has a partial unique
  // index, only one row may have it true at a time.
  let createdPracticumId: string | null = null;

  beforeAll(async () => {
    // finishRecording also asks LiveKit whether the broadcaster is still connected, after the
    // MediaAsset write this test actually cares about. Without LiveKit credentials configured
    // (true in CI), roomServiceClient() throws synchronously instead of the network call
    // rejecting asynchronously into the existing `.catch(() => [])` — these placeholder
    // credentials keep that failure on the async path where it's already handled harmlessly.
    process.env.LIVEKIT_HOST ??= "http://127.0.0.1:1";
    process.env.LIVEKIT_API_KEY ??= "vitest-placeholder";
    process.env.LIVEKIT_API_SECRET ??= "vitest-placeholder";

    const existing = await prisma.practicum.findFirst({ where: { isActive: true } });
    if (!existing) {
      const created = await prisma.practicum.create({ data: { title: `Vitest regression fixture ${Date.now()}`, isActive: true } });
      createdPracticumId = created.id;
    }
  });

  afterAll(async () => {
    await prisma.mediaAsset.deleteMany({ where: { providerKey } });
    if (createdPracticumId) await prisma.practicum.delete({ where: { id: createdPracticumId } });
  });

  function egressEndedEvent(byteSize: number, durationSec: number): WebhookEvent {
    const endedAtNs = BigInt(Date.now()) * BigInt(1_000_000);
    const info = {
      egressId: `EG_vitest_${Date.now()}`,
      roomName: LIVEKIT_ROOM_NAME,
      status: EgressStatus.EGRESS_COMPLETE,
      startedAt: endedAtNs - BigInt(durationSec) * BigInt(1_000_000_000),
      endedAt: endedAtNs,
      fileResults: [{ filename: providerKey, size: BigInt(byteSize) }],
    } as unknown as EgressInfo;
    return { event: "egress_ended", egressInfo: info } as unknown as WebhookEvent;
  }

  // handleLiveKitWebhookEvent fires finishRecording without awaiting it (matches production,
  // where the webhook responds before the DB write finishes) — poll instead of asserting
  // immediately after the call resolves.
  async function waitForMediaAsset(timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = await prisma.mediaAsset.findFirst({ where: { providerKey } });
      if (found) return found;
      if (Date.now() > deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it("creates a MediaAsset once egress completes", async () => {
    await streamService.handleLiveKitWebhookEvent(egressEndedEvent(12_345, 42));

    const created = await waitForMediaAsset();
    expect(created).not.toBeNull();
    expect(created?.provider).toBe("LIVEKIT_RECORDING");
    expect(created?.byteSize).toBe(BigInt(12_345));
    expect(created?.durationSec).toBe(42);
  });

  it("is idempotent — a redelivered egress_ended webhook doesn't create a duplicate", async () => {
    await streamService.handleLiveKitWebhookEvent(egressEndedEvent(12_345, 42));
    // No polling needed here — the first test already waited for the row to land, so a second
    // delivery either no-ops immediately (existing-row check) or briefly races the advisory
    // lock and then finds the row already there.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const rows = await prisma.mediaAsset.findMany({ where: { providerKey } });
    expect(rows).toHaveLength(1);
  });
});

/**
 * "Начать стрим" / "Завершить эфир" from a schedule event (2026-10-02). In this same file, not a
 * separate one, on purpose: both suites drive the active practicum's stream target, and vitest
 * runs files in parallel but tests within a file in order.
 */
describe("stream-service: broadcast started from a schedule event", () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const keys = [1, 2, 3].map((part) => `recordings/vitest-event-${suffix}-${part}.mp4`);
  let practicumId: string;
  let createdPracticumId: string | null = null;
  let curatorId: string;
  let eventId: string;
  let originalTarget: { pendingStreamModuleId: string | null; pendingStreamScheduleEventId: string | null; pendingStreamMediaKind: MediaAssetKind | null; streamStartedById: string | null; streamStartedAt: Date | null };
  let otherCuratorId: string;

  beforeAll(async () => {
    process.env.LIVEKIT_HOST ??= "http://127.0.0.1:1";
    process.env.LIVEKIT_API_KEY ??= "vitest-placeholder";
    process.env.LIVEKIT_API_SECRET ??= "vitest-placeholder";
    const existing = await prisma.practicum.findFirst({ where: { isActive: true }, select: { id: true, pendingStreamModuleId: true, pendingStreamScheduleEventId: true, pendingStreamMediaKind: true, streamStartedById: true, streamStartedAt: true } });
    if (existing) {
      practicumId = existing.id;
      originalTarget = { pendingStreamModuleId: existing.pendingStreamModuleId, pendingStreamScheduleEventId: existing.pendingStreamScheduleEventId, pendingStreamMediaKind: existing.pendingStreamMediaKind, streamStartedById: existing.streamStartedById, streamStartedAt: existing.streamStartedAt };
    } else {
      const created = await prisma.practicum.create({ data: { title: `Vitest event-stream fixture ${suffix}`, isActive: true } });
      practicumId = created.id;
      createdPracticumId = created.id;
      originalTarget = { pendingStreamModuleId: null, pendingStreamScheduleEventId: null, pendingStreamMediaKind: null, streamStartedById: null, streamStartedAt: null };
    }
    curatorId = (await prisma.user.create({
      data: { role: UserRole.CURATOR, status: UserStatus.ACTIVE, email: `vitest-stream-curator-${suffix}@example.com`, externalIdentities: { create: { provider: IdentityProvider.LOCAL, providerSubject: `vitest-stream-curator-${suffix}`, username: "vitest-stream-curator" } } },
      select: { id: true },
    })).id;
    otherCuratorId = (await prisma.user.create({
      data: { role: UserRole.CURATOR, status: UserStatus.ACTIVE, email: `vitest-stream-other-${suffix}@example.com`, externalIdentities: { create: { provider: IdentityProvider.LOCAL, providerSubject: `vitest-stream-other-${suffix}`, username: "vitest-other", displayName: "Другой куратор" } } },
      select: { id: true },
    })).id;
    eventId = (await prisma.scheduleEvent.create({ data: { practicumId, type: ScheduleEventType.LECTURE, title: `Vitest лекция ${suffix}`, date: new Date(), time: "13:00 — 14:00", description: "fixture" }, select: { id: true } })).id;
  });

  afterAll(async () => {
    await prisma.mediaAsset.deleteMany({ where: { providerKey: { in: keys } } });
    await prisma.scheduleEvent.deleteMany({ where: { id: eventId } });
    if (createdPracticumId) await prisma.practicum.delete({ where: { id: createdPracticumId } });
    else await prisma.practicum.update({ where: { id: practicumId }, data: originalTarget });
    await prisma.user.deleteMany({ where: { id: { in: [curatorId, otherCuratorId] } } });
  });

  function recording(key: string, startedSecondsAgo: number, endedSecondsAgo: number): WebhookEvent {
    const nowNs = BigInt(Date.now()) * BigInt(1_000_000);
    const info = {
      egressId: `EG_vitest_${key}`,
      roomName: LIVEKIT_ROOM_NAME,
      status: EgressStatus.EGRESS_COMPLETE,
      startedAt: nowNs - BigInt(startedSecondsAgo) * BigInt(1_000_000_000),
      endedAt: nowNs - BigInt(endedSecondsAgo) * BigInt(1_000_000_000),
      fileResults: [{ filename: key, size: BigInt(1_000) }],
    } as unknown as EgressInfo;
    return { event: "egress_ended", egressInfo: info } as unknown as WebhookEvent;
  }

  async function waitFor(key: string, timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = await prisma.mediaAsset.findFirst({ where: { providerKey: key }, select: { status: true, scheduleEventId: true, moduleId: true, title: true } });
      if (found || Date.now() > deadline) return found;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it("files the recording as a draft under the event and keeps the target for the rest of the broadcast", async () => {
    await streamService.setStreamTarget(curatorId, { scheduleEventId: eventId });
    await streamService.handleLiveKitWebhookEvent(recording(keys[0], 600, 300));
    const first = await waitFor(keys[0]);
    expect(first).toMatchObject({ status: MediaAssetStatus.DRAFT, scheduleEventId: eventId, moduleId: null });

    // An OBS reconnect splits the recording — the second half must land on the same event.
    const practicum = await prisma.practicum.findUnique({ where: { id: practicumId }, select: { pendingStreamScheduleEventId: true } });
    expect(practicum?.pendingStreamScheduleEventId).toBe(eventId);
    await streamService.handleLiveKitWebhookEvent(recording(keys[1], 290, 60));
    expect(await waitFor(keys[1])).toMatchObject({ status: MediaAssetStatus.DRAFT, scheduleEventId: eventId });
  });

  it("'Завершить эфир' marks the event finished and detaches it; a recording finishing right after still lands on it", async () => {
    await streamService.finishStream(curatorId, eventId);
    const event = await prisma.scheduleEvent.findUnique({ where: { id: eventId }, select: { streamEndedAt: true } });
    expect(event?.streamEndedAt).toBeInstanceOf(Date);
    const practicum = await prisma.practicum.findUnique({ where: { id: practicumId }, select: { pendingStreamScheduleEventId: true } });
    expect(practicum?.pendingStreamScheduleEventId).toBeNull();

    // The streamer pressed "Завершить" before stopping OBS: this recording ends after the target is gone.
    await streamService.handleLiveKitWebhookEvent(recording(keys[2], 50, 0));
    expect(await waitFor(keys[2])).toMatchObject({ status: MediaAssetStatus.DRAFT, scheduleEventId: eventId });
  });

  it("starting the stream again from the same event clears its 'finished' mark", async () => {
    await streamService.setStreamTarget(curatorId, { scheduleEventId: eventId });
    const event = await prisma.scheduleEvent.findUnique({ where: { id: eventId }, select: { streamEndedAt: true } });
    expect(event?.streamEndedAt).toBeNull();
  });

  it("remembers who pressed 'Начать стрим' — every other curator sees it, and 'Завершить эфир' clears it", async () => {
    await streamService.setStreamTarget(otherCuratorId, { scheduleEventId: eventId });
    const seenByOther = await streamService.getStreamTarget(otherCuratorId);
    expect(seenByOther.host).toMatchObject({ name: "Другой куратор", isMe: true });
    const seenByMe = await streamService.getStreamTarget(curatorId);
    expect(seenByMe.host).toMatchObject({ name: "Другой куратор", isMe: false });

    const afterFinish = await streamService.finishStream(curatorId, eventId);
    expect(afterFinish.host).toBeNull();
  });

  it("tells curators which поток the broadcast goes to", async () => {
    const target = await streamService.getStreamTarget(curatorId);
    const active = await prisma.practicum.findUnique({ where: { id: practicumId }, select: { title: true } });
    expect(target.practicum?.title).toBe(active?.title);
    expect(typeof target.practicum?.students).toBe("number");
  });
});
