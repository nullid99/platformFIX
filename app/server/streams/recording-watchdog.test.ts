// See stream-service.test.ts for why this import is needed locally and a no-op in CI.
import "dotenv/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// vi.mock below is hoisted above these imports, so they already get the faked LiveKit clients.
import { streamService } from "./stream-service";
import { EgressStatus, LIVEKIT_INGRESS_PARTICIPANT_IDENTITY, TrackType } from "./livekit-client";

/**
 * Regression test for a real incident (2026-10-01): an egress whose GStreamer pipeline never left
 * PAUSED (a corrupted first H.264 frame) sat in EGRESS_STARTING for the whole 55-minute broadcast,
 * and maybeStartRecording's "already recording" check kept any second attempt from starting — the
 * broadcast was never recorded. superviseRecording must stop such an egress and start a fresh one.
 * LiveKit itself is faked here; only the decision logic is under test.
 */

type FakeEgress = { egressId: string; status: number; startedAt: bigint };

const fake = vi.hoisted(() => ({
  participants: [] as Array<{ identity: string; tracks: Array<{ type: number; sid: string }> }>,
  egresses: [] as FakeEgress[],
  stopEgress: vi.fn(),
  listEgress: vi.fn(),
  startTrackCompositeEgress: vi.fn(),
}));

vi.mock("./livekit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./livekit-client")>();
  return {
    ...actual,
    roomServiceClient: () => ({ listParticipants: async () => fake.participants }),
    egressClient: () => ({
      listEgress: async () => { fake.listEgress(); return fake.egresses; },
      stopEgress: async (egressId: string) => {
        fake.stopEgress(egressId);
        // LiveKit drops a stopped egress from the active list.
        fake.egresses = fake.egresses.filter((egress) => egress.egressId !== egressId);
      },
      startTrackCompositeEgress: async (...args: unknown[]) => { fake.startTrackCompositeEgress(...args); },
    }),
    recordingFileOutput: () => ({}),
    recordingImageOutput: () => ({}),
  };
});

const nsAgo = (ms: number) => BigInt(Date.now() - ms) * BigInt(1_000_000);
const obsLive = () => [{ identity: LIVEKIT_INGRESS_PARTICIPANT_IDENTITY, tracks: [{ type: TrackType.VIDEO, sid: "TR_video" }, { type: TrackType.AUDIO, sid: "TR_audio" }] }];

describe("streamService#superviseRecording — recording watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fake.participants = [];
    fake.egresses = [];
    fake.stopEgress.mockClear();
    fake.listEgress.mockClear();
    fake.startTrackCompositeEgress.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  async function supervise() {
    const run = streamService.superviseRecording();
    await vi.advanceTimersByTimeAsync(5_000);
    await run;
  }

  it("stops an egress stuck in STARTING and starts a fresh one (the 2026-10-01 incident)", async () => {
    fake.participants = obsLive();
    fake.egresses = [{ egressId: "EG_stuck", status: EgressStatus.EGRESS_STARTING, startedAt: nsAgo(60_000) }];
    await supervise();
    expect(fake.stopEgress).toHaveBeenCalledWith("EG_stuck");
    expect(fake.startTrackCompositeEgress).toHaveBeenCalledTimes(1);
  });

  it("leaves a healthy ACTIVE recording alone", async () => {
    fake.participants = obsLive();
    fake.egresses = [{ egressId: "EG_ok", status: EgressStatus.EGRESS_ACTIVE, startedAt: nsAgo(600_000) }];
    await supervise();
    expect(fake.stopEgress).not.toHaveBeenCalled();
    expect(fake.startTrackCompositeEgress).not.toHaveBeenCalled();
  });

  it("gives a just-started egress time to reach ACTIVE", async () => {
    fake.participants = obsLive();
    fake.egresses = [{ egressId: "EG_new", status: EgressStatus.EGRESS_STARTING, startedAt: nsAgo(2_000) }];
    await supervise();
    expect(fake.stopEgress).not.toHaveBeenCalled();
    expect(fake.startTrackCompositeEgress).not.toHaveBeenCalled();
  });

  it("starts a recording when OBS is live but nothing is recording at all", async () => {
    fake.participants = obsLive();
    await supervise();
    expect(fake.startTrackCompositeEgress).toHaveBeenCalledTimes(1);
  });

  it("does nothing while OBS is offline", async () => {
    fake.egresses = [{ egressId: "EG_stuck", status: EgressStatus.EGRESS_STARTING, startedAt: nsAgo(60_000) }];
    await supervise();
    expect(fake.stopEgress).not.toHaveBeenCalled();
    expect(fake.startTrackCompositeEgress).not.toHaveBeenCalled();
  });

  it("serves the recording indicator from the watchdog's last look — no extra stream-server call per viewer", async () => {
    fake.participants = obsLive();
    fake.egresses = [{ egressId: "EG_ok", status: EgressStatus.EGRESS_ACTIVE, startedAt: nsAgo(600_000) }];
    await supervise();
    const callsAfterWatchdog = fake.listEgress.mock.calls.length;
    for (let viewer = 0; viewer < 50; viewer += 1) {
      expect(await streamService.getRecordingState({ allowFetch: false })).toBe("recording");
    }
    expect(fake.listEgress.mock.calls.length).toBe(callsAfterWatchdog);
  });

  it("forgets the state once OBS goes offline", async () => {
    await supervise();
    expect(await streamService.getRecordingState({ allowFetch: false })).toBeNull();
  });
});
