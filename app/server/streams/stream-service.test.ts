// Vitest doesn't auto-load .env the way Next.js/Prisma CLI do — needed locally so
// @/app/server/db sees DATABASE_URL; in CI it's already set as a workflow env var, so this is a
// no-op there (dotenv never overrides an existing value).
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebhookEvent } from "livekit-server-sdk";
import type { EgressInfo } from "@livekit/protocol";
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
