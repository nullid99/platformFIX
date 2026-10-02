import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { streamService } from "@/app/server/streams";
import { isStreamPrivate } from "@/app/server/streams/stream-visibility";
import { activeStudentEmails, activeStudentIds } from "@/app/server/notifications/recipient-service";
import { sendStreamLiveNotification } from "@/app/server/notifications/email-service";
import { notificationService } from "@/app/server/notifications/notification-service";
import { StreamsGateway } from "./streams.gateway";

const POLL_INTERVAL_MS = 20_000;
// LiveKit webhook delivery is at-least-once but not guaranteed — a single dropped delivery (a
// network blip between the LiveKit box and this API, a transient 5xx, etc.) would otherwise leave
// isCurrentlyLive stuck wrong indefinitely, since nothing besides the webhook and the one-off
// startup reconciliation ever touches it. This re-derives it from LiveKit's own participant list
// periodically so a missed webhook self-heals within one interval instead of lasting until the
// next deploy/restart.
const RECONCILE_INTERVAL_TICKS = 15; // 15 * 20s = 5 min
const SUSTAIN_BEFORE_NOTIFY_MS = 30_000;
// A brief OBS reconnect (crash, network blip, encoder restart) drops the live-input
// status for a tick or two and then comes back — that used to look identical to a
// genuinely new broadcast and wiped the chat / re-sent "stream is live" notifications
// every time. Only treat it as a new session if the gap since we last saw it live is
// longer than a real between-streams gap would be.
const NEW_SESSION_GAP_MS = 30 * 60_000;

type PracticumLiveState = {
  candidateSince: number | null;
  notified: boolean;
  lastLiveAt: number | null;
};

/**
 * Watches LiveKit room live-status (Practicum.isCurrentlyLive, kept up to date by the
 * LiveKit webhook) independently of any open browser tab, and emails active students
 * once a stream has stayed connected for a short grace period — filters out accidental
 * test connects in OBS.
 */
@Injectable()
export class StreamLiveNotifier implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly state = new Map<string, PracticumLiveState>();
  private tickCount = 0;

  // Explicit @Inject: the API runs under tsx (esbuild), which doesn't emit decorator type
  // metadata, so Nest can't infer this from the parameter type — it silently injected
  // undefined and crashed the whole API the first time a broadcast was confirmed (2026-10-02).
  constructor(@Inject(StreamsGateway) private readonly gateway: StreamsGateway) {}

  public onModuleInit(): void {
    // If the API restarts mid-broadcast, no room_started webhook re-fires (the room didn't just
    // start) — without this, isCurrentlyLive would stay stale until the next room_finished.
    void streamService.reconcileLiveStatus();
    this.timer = setInterval(() => { void this.tick(); }, POLL_INTERVAL_MS);
  }

  public onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    this.tickCount += 1;
    if (this.tickCount % RECONCILE_INTERVAL_TICKS === 0) await streamService.reconcileLiveStatus();
    // Recording watchdog — see StreamService#superviseRecording. Independent of the DB live flag
    // below on purpose: it asks LiveKit directly, so a missed webhook can't blind it either.
    await streamService.superviseRecording();

    const results = await streamService.checkLiveForNotifications().catch((error: unknown) => {
      console.error("Stream live notifier poll failed", error instanceof Error ? error.message : "unknown error");
      return [];
    });

    const now = Date.now();
    for (const { practicumId, isLive } of results) {
      const current = this.state.get(practicumId) ?? { candidateSince: null, notified: false, lastLiveAt: null };

      if (!isLive) {
        // Keep lastLiveAt — it's what lets the next reconnect tell a blip from a real gap.
        this.state.set(practicumId, { candidateSince: null, notified: false, lastLiveAt: current.lastLiveAt });
        continue;
      }

      if (current.candidateSince === null) {
        this.state.set(practicumId, { candidateSince: now, notified: false, lastLiveAt: current.lastLiveAt });
        continue;
      }

      const sustainedMs = now - current.candidateSince;
      if (!current.notified && sustainedMs >= SUSTAIN_BEFORE_NOTIFY_MS) {
        const gapSinceLastLive = current.lastLiveAt !== null ? now - current.lastLiveAt : Infinity;
        this.state.set(practicumId, { ...current, notified: true, lastLiveAt: now });
        // Never let a notification problem take the API down mid-broadcast.
        void this.handleConfirmedLive(practicumId, gapSinceLastLive >= NEW_SESSION_GAP_MS).catch((error: unknown) => console.error("Stream live handling failed", error instanceof Error ? error.message : "unknown error"));
      } else if (current.notified) {
        // Only a *confirmed* broadcast refreshes lastLiveAt. Refreshing it while still inside the
        // sustain window (as this used to, unconditionally) meant the confirming tick always saw
        // a ~20s "gap since last live" — i.e. every broadcast looked like a reconnect of itself,
        // so isNewSession was never true and neither the "Стрим начался" email/bell nor the chat
        // reset ever fired (0 STREAM_LIVE notifications in production as of 2026-10-01).
        this.state.set(practicumId, { ...current, lastLiveAt: now });
      }
    }
  }

  /** Fires once per broadcast, once the connection has been sustained past the grace period. */
  private async handleConfirmedLive(practicumId: string, isNewSession: boolean): Promise<void> {
    if (!isNewSession) return;
    await streamService.startNewChatSession(practicumId).catch((error: unknown) => {
      console.error("Stream chat session reset failed", error instanceof Error ? error.message : "unknown error");
    });
    try { this.gateway.broadcastChatReset(practicumId); } catch (error) { console.error("Stream chat reset broadcast failed", error instanceof Error ? error.message : "unknown error"); }
    // Private stream (1:1, or recording something to publish later) — students already can't
    // get into it (see getPlaybackStatus), and shouldn't get an email/bell telling them it's
    // live either.
    if (await isStreamPrivate(practicumId)) return;
    try {
      const topic = await streamService.getPendingStreamTopic(practicumId).catch(() => null);
      const emails = await activeStudentEmails(practicumId);
      await Promise.all(emails.map((to) => sendStreamLiveNotification({ to, topic })));
      const studentIds = await activeStudentIds(practicumId);
      await notificationService.createMany(studentIds, "STREAM_LIVE", topic ? `Стрим начался: ${topic}` : "Стрим начался", "Куратор сейчас в эфире");
    } catch (error) {
      console.error("Stream live notification dispatch failed", error instanceof Error ? error.message : "unknown error");
    }
  }
}
