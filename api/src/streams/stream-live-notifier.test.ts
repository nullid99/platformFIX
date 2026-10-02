import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// vi.mock below is hoisted above this import, so the notifier already gets the fakes.
import { StreamLiveNotifier } from "./stream-live-notifier";

/**
 * Regression test for a real bug found 2026-10-01: the "Стрим начался" email/bell and the chat
 * reset had never fired once in production. During the 30s sustain window the notifier kept
 * refreshing lastLiveAt, so at the confirming tick the "gap since last live" was always ~20s and
 * every broadcast looked like a reconnect of itself. The notifier's collaborators are faked; its
 * own tick/state logic runs for real.
 */

const fake = vi.hoisted(() => ({
  isLive: false,
  startNewChatSession: vi.fn(async () => undefined),
  sendStreamLiveNotification: vi.fn(async () => undefined),
  createMany: vi.fn(async () => undefined),
}));

vi.mock("@/app/server/streams", () => ({
  streamService: {
    reconcileLiveStatus: async () => undefined,
    superviseRecording: async () => undefined,
    checkLiveForNotifications: async () => [{ practicumId: "practicum-1", isLive: fake.isLive }],
    startNewChatSession: fake.startNewChatSession,
    getPendingStreamTopic: async () => null,
  },
}));
vi.mock("@/app/server/streams/stream-visibility", () => ({ isStreamPrivate: async () => false }));
vi.mock("@/app/server/notifications/recipient-service", () => ({
  activeStudentEmails: async () => ["student@example.com"],
  activeStudentIds: async () => ["student-1"],
}));
vi.mock("@/app/server/notifications/email-service", () => ({ sendStreamLiveNotification: fake.sendStreamLiveNotification }));
vi.mock("@/app/server/notifications/notification-service", () => ({ notificationService: { createMany: fake.createMany } }));
vi.mock("./streams.gateway", () => ({ StreamsGateway: class {} }));

describe("StreamLiveNotifier — 'stream is live' detection", () => {
  let notifier: InstanceType<typeof StreamLiveNotifier>;

  beforeEach(() => {
    vi.useFakeTimers();
    fake.isLive = false;
    fake.startNewChatSession.mockClear();
    fake.sendStreamLiveNotification.mockClear();
    fake.createMany.mockClear();
    // Only broadcastChatReset is used by the code under test.
    notifier = new StreamLiveNotifier({ broadcastChatReset: () => undefined } as never);
  });
  afterEach(() => vi.useRealTimers());

  // Same cadence as production: one poll every 20s.
  async function tickAfter(ms: number) {
    vi.advanceTimersByTime(ms);
    await notifier["tick"]();
    await vi.runAllTimersAsync();
  }

  it("notifies students and starts a fresh chat session once a broadcast holds for 30s", async () => {
    fake.isLive = true;
    await tickAfter(0);
    await tickAfter(20_000);
    await tickAfter(20_000);
    expect(fake.startNewChatSession).toHaveBeenCalledTimes(1);
    expect(fake.sendStreamLiveNotification).toHaveBeenCalledTimes(1);
    expect(fake.createMany).toHaveBeenCalledWith(["student-1"], "STREAM_LIVE", "Стрим начался", "Куратор сейчас в эфире");
  });

  it("does not re-notify for a short OBS reconnect within the same broadcast", async () => {
    fake.isLive = true;
    await tickAfter(0);
    await tickAfter(20_000);
    await tickAfter(20_000); // confirmed + notified
    fake.isLive = false;
    await tickAfter(20_000); // a blip
    fake.isLive = true;
    await tickAfter(20_000);
    await tickAfter(20_000);
    await tickAfter(20_000);
    expect(fake.sendStreamLiveNotification).toHaveBeenCalledTimes(1);
  });

  it("notifies again for the next real broadcast after a long gap", async () => {
    fake.isLive = true;
    await tickAfter(0);
    await tickAfter(20_000);
    await tickAfter(20_000);
    fake.isLive = false;
    await tickAfter(20_000);
    vi.advanceTimersByTime(2 * 60 * 60_000); // two hours later
    fake.isLive = true;
    await tickAfter(0);
    await tickAfter(20_000);
    await tickAfter(20_000);
    expect(fake.sendStreamLiveNotification).toHaveBeenCalledTimes(2);
  });

  it("ignores an accidental connect shorter than 30s", async () => {
    fake.isLive = true;
    await tickAfter(0);
    await tickAfter(20_000);
    fake.isLive = false;
    await tickAfter(20_000);
    expect(fake.sendStreamLiveNotification).not.toHaveBeenCalled();
  });
});
