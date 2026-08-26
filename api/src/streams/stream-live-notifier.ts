import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { streamService } from "@/app/server/streams";
import { activeStudentEmails, activeStudentIds } from "@/app/server/notifications/recipient-service";
import { sendStreamLiveNotification } from "@/app/server/notifications/email-service";
import { notificationService } from "@/app/server/notifications/notification-service";
import { StreamsGateway } from "./streams.gateway";

const POLL_INTERVAL_MS = 20_000;
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
 * Watches Cloudflare live-input status independently of any open browser tab,
 * and emails active students once a stream has stayed connected for a short
 * grace period — filters out accidental test connects in OBS.
 */
@Injectable()
export class StreamLiveNotifier implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly state = new Map<string, PracticumLiveState>();

  constructor(private readonly gateway: StreamsGateway) {}

  public onModuleInit(): void {
    this.timer = setInterval(() => { void this.tick(); }, POLL_INTERVAL_MS);
  }

  public onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
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
        void this.handleConfirmedLive(practicumId, gapSinceLastLive >= NEW_SESSION_GAP_MS);
      } else {
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
    this.gateway.broadcastChatReset();
    try {
      const emails = await activeStudentEmails(practicumId);
      await Promise.all(emails.map((to) => sendStreamLiveNotification({ to })));
      const studentIds = await activeStudentIds(practicumId);
      await notificationService.createMany(studentIds, "STREAM_LIVE", "Стрим начался", "Куратор сейчас в эфире");
    } catch (error) {
      console.error("Stream live notification dispatch failed", error instanceof Error ? error.message : "unknown error");
    }
  }
}
