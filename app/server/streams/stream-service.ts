import { MediaAssetKind, MediaAssetStatus, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { AuthServiceError } from "@/app/server/auth";
import { prisma } from "@/app/server/db";
import { activeStudentEmails, activeStudentIds } from "@/app/server/notifications/recipient-service";
import { sendNewMediaNotification } from "@/app/server/notifications/email-service";
import { notificationService } from "@/app/server/notifications/notification-service";
import { assertPracticumViewer } from "./access";
import {
  EgressStatus,
  IngressInput,
  LIVEKIT_INGRESS_PARTICIPANT_IDENTITY,
  LIVEKIT_INGRESS_VIDEO_OPTIONS,
  LIVEKIT_ROOM_NAME,
  TrackType,
  egressClient,
  ingressClient,
  mintRecordingDownloadUrl,
  mintRecordingPlaybackUrl,
  mintViewerToken,
  newRecordingObjectKey,
  recordingFileOutput,
  recordingImageOutput,
  recordingThumbnailObjectKey,
  RECORDING_ENCODING_OPTIONS,
  roomServiceClient,
} from "./livekit-client";
import type { WebhookEvent } from "livekit-server-sdk";
import type { EgressInfo, IngressInfo } from "@livekit/protocol";

/** providerKey for this provider is the recording's S3 object key directly — see mediaEmbedUrl/mediaThumbnailUrl in course-service.ts, which mints a presigned URL from it. */
export const LIVEKIT_RECORDING_PROVIDER = "LIVEKIT_RECORDING";

export type IngressDto = {
  ingressId: string;
  rtmpUrl: string | null;
  rtmpStreamKey: string | null;
  isLive: boolean;
};

export type PlaybackStatusDto = {
  isLive: boolean;
  /** Short-lived (6h) subscribe-only join token, minted fresh on every call — null while offline. */
  viewerToken: string | null;
  roomName: string | null;
  /** The schedule event this broadcast is for — the curator's pending target, only surfaced while actually live. */
  liveScheduleEventId: string | null;
};

export type StreamTargetDto = {
  moduleId: string | null;
  moduleTitle: string | null;
  scheduleEventId: string | null;
  scheduleEventTitle: string | null;
  /** Only meaningful alongside moduleId — which of the module's two stream blocks this broadcast is for. */
  mediaKind: "STREAM" | "QA" | null;
};

function ingressDto(info: IngressInfo, isLive: boolean): IngressDto {
  return {
    ingressId: info.ingressId,
    rtmpUrl: info.url || null,
    rtmpStreamKey: info.streamKey || null,
    isLive,
  };
}

export class StreamService {
  /** In-memory only — the currently-recording egress for the live broadcast, if any. Single-instance API process, same assumption stream-live-notifier's own in-memory state already relies on. */
  private activeRecording: { egressId: string; objectKey: string } | null = null;
  private recordingStartInFlight = false;

  public async getIngress(actorId: string): Promise<IngressDto | null> {
    const practicum = await this.assertCuratorPracticum(actorId);
    if (!practicum.liveKitIngressId) return null;
    const [existing] = await ingressClient().listIngress({ ingressId: practicum.liveKitIngressId }).catch(() => []);
    if (!existing) return null;
    return ingressDto(existing, practicum.isCurrentlyLive);
  }

  /** Idempotent — an RTMP ingress stays valid/reusable once created, so this never rotates OBS's URL/key. */
  public async ensureIngress(actorId: string): Promise<IngressDto> {
    const practicum = await this.assertCuratorPracticum(actorId);
    const client = ingressClient();
    if (practicum.liveKitIngressId) {
      const [existing] = await client.listIngress({ ingressId: practicum.liveKitIngressId }).catch(() => []);
      if (existing) {
        // Keeps an already-issued RTMP URL/key stable while still picking up encoding-option
        // changes (e.g. the video preset) made after the ingress was first created.
        const updated = await client.updateIngress(existing.ingressId, { name: practicum.title, video: LIVEKIT_INGRESS_VIDEO_OPTIONS }).catch(() => existing);
        return ingressDto(updated, practicum.isCurrentlyLive);
      }
      // Stored id is stale (ingress deleted server-side out of band) — fall through and create a fresh one.
    }
    const created = await client.createIngress(IngressInput.RTMP_INPUT, {
      name: practicum.title,
      roomName: LIVEKIT_ROOM_NAME,
      participantIdentity: LIVEKIT_INGRESS_PARTICIPANT_IDENTITY,
      video: LIVEKIT_INGRESS_VIDEO_OPTIONS,
    });
    await prisma.practicum.update({ where: { id: practicum.id }, data: { liveKitIngressId: created.ingressId } });
    return ingressDto(created, practicum.isCurrentlyLive);
  }

  /**
   * Resolves to a short-lived presigned MinIO URL for a LiveKit-recorded MediaAsset — called by
   * the `GET /streams/recordings/:mediaId/play` redirect route (see mediaEmbedUrl in
   * course-service.ts, which points the player at that route rather than embedding a static URL
   * directly, since the actual signed URL can only be minted per-request and expires).
   */
  public async getRecordingPlaybackUrl(actorId: string, mediaAssetId: string): Promise<string> {
    const objectKey = await this.resolveOwnRecordingKey(actorId, mediaAssetId);
    return mintRecordingPlaybackUrl(objectKey);
  }

  /** Same idea as getRecordingPlaybackUrl, for the representative frame captured alongside the video (see mediaThumbnailUrl in course-service.ts). */
  public async getRecordingThumbnailUrl(actorId: string, mediaAssetId: string): Promise<string> {
    const objectKey = await this.resolveOwnRecordingKey(actorId, mediaAssetId);
    return mintRecordingPlaybackUrl(recordingThumbnailObjectKey(objectKey));
  }

  /**
   * Curator-only — lets them pull the raw file down to trim a bad moment and re-upload the fixed
   * cut as a fresh Vimeo entry on the same module/event (see createVimeoMedia in
   * course-service.ts), then archive this one. Deliberately not offered to students: the ordinary
   * player route (getRecordingPlaybackUrl) never sets a download disposition. Not scoped to the
   * active practicum — a curator can still pull a recording from a finished cohort to fix it.
   */
  public async getRecordingDownloadUrl(actorId: string, mediaAssetId: string): Promise<string> {
    await this.assertCuratorPracticum(actorId);
    const asset = await prisma.mediaAsset.findUnique({ where: { id: mediaAssetId }, select: { provider: true, providerKey: true, status: true, title: true } });
    if (!asset || asset.provider !== LIVEKIT_RECORDING_PROVIDER || asset.status === MediaAssetStatus.ARCHIVED) {
      throw new AuthServiceError("INVALID_INPUT", "Recording is not available");
    }
    const filename = `${asset.title?.trim() || "recording"}.mp4`;
    return mintRecordingDownloadUrl(asset.providerKey, filename);
  }

  /** A curator/owner can preview any practicum's recording (e.g. a finished cohort's, while fixing it up); a student stays scoped to their own enrollment's practicum via assertPracticumViewer. */
  private async resolveOwnRecordingKey(actorId: string, mediaAssetId: string): Promise<string> {
    const { practicumId, role } = await assertPracticumViewer(actorId);
    const isStaff = role === UserRole.CURATOR || role === UserRole.OWNER;
    const asset = await prisma.mediaAsset.findUnique({ where: { id: mediaAssetId }, select: { practicumId: true, provider: true, providerKey: true, status: true } });
    if (!asset || (!isStaff && asset.practicumId !== practicumId) || asset.provider !== LIVEKIT_RECORDING_PROVIDER || asset.status === MediaAssetStatus.ARCHIVED) {
      throw new AuthServiceError("INVALID_INPUT", "Recording is not available");
    }
    return asset.providerKey;
  }

  /** Safe for both curator and enrolled students — mints a fresh subscribe-only token per call, never exposes the RTMP key. */
  public async getPlaybackStatus(actorId: string): Promise<PlaybackStatusDto> {
    const { practicumId } = await assertPracticumViewer(actorId);
    const practicum = await prisma.practicum.findUnique({ where: { id: practicumId }, select: { isCurrentlyLive: true, pendingStreamScheduleEventId: true } });
    if (!practicum?.isCurrentlyLive) return { isLive: false, viewerToken: null, roomName: null, liveScheduleEventId: null };
    const viewerToken = await mintViewerToken(actorId);
    return { isLive: true, viewerToken, roomName: LIVEKIT_ROOM_NAME, liveScheduleEventId: practicum.pendingStreamScheduleEventId };
  }

  /** Topic of the currently-configured stream target, for the "stream is live" email/notification — null when the curator hasn't picked one. */
  public async getPendingStreamTopic(practicumId: string): Promise<string | null> {
    const practicum = await prisma.practicum.findUnique({ where: { id: practicumId }, select: { pendingStreamModuleId: true, pendingStreamScheduleEventId: true } });
    if (!practicum) return null;
    const target = await this.resolveStreamTarget(practicum.pendingStreamModuleId, practicum.pendingStreamScheduleEventId, null);
    return target.moduleTitle ?? target.scheduleEventTitle;
  }

  /** For the background notifier only — cheap Prisma read, fed by handleLiveKitWebhookEvent (or reconcileLiveStatus on startup), not a LiveKit API call. */
  public async checkLiveForNotifications(): Promise<Array<{ practicumId: string; isLive: boolean }>> {
    const practicums = await prisma.practicum.findMany({ select: { id: true, isCurrentlyLive: true } });
    return practicums.map((practicum) => ({ practicumId: practicum.id, isLive: practicum.isCurrentlyLive }));
  }

  /** Called by the background notifier when a broadcast is confirmed live — starts a fresh chat session. */
  public async startNewChatSession(practicumId: string): Promise<void> {
    await prisma.practicum.update({ where: { id: practicumId }, data: { currentStreamSessionStartedAt: new Date() } });
  }

  /**
   * LiveKit webhook consumer. participant_joined/participant_left update the DB flag that
   * everything else (status polling, the notifier) reads from — deliberately keyed on the
   * *ingress participant* joining/leaving, not room_started/room_finished, since a LiveKit room
   * stays open for emptyTimeout (5 min) after OBS disconnects, so room-level events lag well
   * behind "is anyone actually publishing right now." track_published kicks off recording once
   * both of the ingress participant's tracks are up; egress_ended finalizes it. Single-practicum
   * install, so the DB update touches every practicum row, same as the rest of the codebase's
   * "there's only one" convention.
   */
  public async handleLiveKitWebhookEvent(event: WebhookEvent): Promise<void> {
    if (event.event === "egress_ended") {
      if (event.egressInfo) void this.finishRecording(event.egressInfo);
      return;
    }
    if (event.room?.name !== LIVEKIT_ROOM_NAME || event.participant?.identity !== LIVEKIT_INGRESS_PARTICIPANT_IDENTITY) return;

    if (event.event === "participant_joined" || event.event === "participant_left") {
      await prisma.practicum.updateMany({ data: { isCurrentlyLive: event.event === "participant_joined" } });
      return;
    }
    if (event.event === "track_published") void this.maybeStartRecording();
  }

  /**
   * Re-derives isCurrentlyLive from LiveKit's own participant list instead of trusting whatever
   * the DB flag currently says. Called once on API startup (a restart mid-broadcast means no
   * participant_joined re-fires) and periodically by the notifier (see RECONCILE_INTERVAL_TICKS
   * in stream-live-notifier.ts) as a backstop for webhook deliveries LiveKit never guarantees.
   */
  public async reconcileLiveStatus(): Promise<void> {
    try {
      const participants = await roomServiceClient().listParticipants(LIVEKIT_ROOM_NAME).catch(() => []);
      const isLive = participants.some((participant) => participant.identity === LIVEKIT_INGRESS_PARTICIPANT_IDENTITY);
      await prisma.practicum.updateMany({ data: { isCurrentlyLive: isLive } });
    } catch (error) {
      console.error("LiveKit startup reconciliation failed", error instanceof Error ? error.message : "unknown error");
    }
  }

  /** What the curator picked on "Стримы" as the destination for the next/current broadcast. */
  public async getStreamTarget(actorId: string): Promise<StreamTargetDto> {
    const practicum = await this.assertCuratorPracticum(actorId);
    const current = await prisma.practicum.findUnique({ where: { id: practicum.id }, select: { pendingStreamModuleId: true, pendingStreamScheduleEventId: true, pendingStreamMediaKind: true } });
    return this.resolveStreamTarget(current?.pendingStreamModuleId ?? null, current?.pendingStreamScheduleEventId ?? null, current?.pendingStreamMediaKind ?? null);
  }

  /** Set (or clear, passing neither) the lesson/schedule-event this stream is for — mutually exclusive. mediaKind only applies with moduleId (which of the module's two stream blocks this is for). */
  public async setStreamTarget(actorId: string, input: { moduleId?: string | null; scheduleEventId?: string | null; mediaKind?: "STREAM" | "QA" | null }): Promise<StreamTargetDto> {
    const practicum = await this.assertCuratorPracticum(actorId);
    let moduleId: string | null = null;
    let scheduleEventId: string | null = null;
    let mediaKind: MediaAssetKind | null = null;
    if (input.moduleId) {
      const courseModule = await prisma.module.findUnique({ where: { id: input.moduleId }, select: { practicumId: true } });
      if (!courseModule || courseModule.practicumId !== practicum.id) throw new AuthServiceError("INVALID_INPUT", "Module does not exist");
      moduleId = input.moduleId;
      mediaKind = input.mediaKind === "QA" ? MediaAssetKind.QA : MediaAssetKind.STREAM;
    } else if (input.scheduleEventId) {
      const scheduleEvent = await prisma.scheduleEvent.findUnique({ where: { id: input.scheduleEventId }, select: { practicumId: true } });
      if (!scheduleEvent || scheduleEvent.practicumId !== practicum.id) throw new AuthServiceError("INVALID_INPUT", "Schedule event does not exist");
      scheduleEventId = input.scheduleEventId;
    }
    await prisma.practicum.update({ where: { id: practicum.id }, data: { pendingStreamModuleId: moduleId, pendingStreamScheduleEventId: scheduleEventId, pendingStreamMediaKind: mediaKind } });
    return this.resolveStreamTarget(moduleId, scheduleEventId, mediaKind);
  }

  private async resolveStreamTarget(moduleId: string | null, scheduleEventId: string | null, mediaKind: MediaAssetKind | null): Promise<StreamTargetDto> {
    const [courseModule, scheduleEvent] = await Promise.all([
      moduleId ? prisma.module.findUnique({ where: { id: moduleId }, select: { title: true } }) : null,
      scheduleEventId ? prisma.scheduleEvent.findUnique({ where: { id: scheduleEventId }, select: { title: true } }) : null,
    ]);
    return {
      moduleId: courseModule ? moduleId : null,
      moduleTitle: courseModule?.title ?? null,
      scheduleEventId: scheduleEvent ? scheduleEventId : null,
      scheduleEventTitle: scheduleEvent?.title ?? null,
      mediaKind: courseModule && mediaKind === MediaAssetKind.QA ? "QA" : courseModule ? "STREAM" : null,
    };
  }

  /**
   * Called when a LiveKit egress (recording) completes: resolves the curator's pre-selected
   * target (Practicum.pendingStream*, picked on "Стримы" before going live) into an auto-published
   * MediaAsset, or lands it as an unassigned draft for the curator to place from the Медиатека
   * when no target was picked, then notifies students. Idempotent on (provider, providerKey) so a
   * retried webhook/reconciliation is safe.
   */
  private async createMediaAssetFromRecording(input: { provider: string; providerKey: string; durationSec: number | null; preciseStart: Date | null; preciseEnd: Date | null }): Promise<void> {
    const existing = await prisma.mediaAsset.findFirst({ where: { provider: input.provider, providerKey: input.providerKey }, select: { id: true } });
    if (existing) return;

    // The broadcast that just finished recording was necessarily live on the active practicum —
    // that's whichever row setStreamTarget/ensureIngress wrote pendingStream*/liveKitIngressId onto.
    const practicum = await prisma.practicum.findFirst({
      where: { isActive: true },
      select: { id: true, pendingStreamModuleId: true, pendingStreamScheduleEventId: true, pendingStreamMediaKind: true, currentStreamSessionStartedAt: true },
    });
    if (!practicum) {
      console.error("Recording ready: no practicum found for", input.providerKey);
      return;
    }

    let targetModule: { id: string; title: string } | null = null;
    let targetScheduleEvent: { id: string; title: string } | null = null;
    if (practicum.pendingStreamModuleId) {
      const courseModule = await prisma.module.findUnique({ where: { id: practicum.pendingStreamModuleId }, select: { id: true, title: true, practicumId: true } });
      if (courseModule && courseModule.practicumId === practicum.id) targetModule = courseModule;
    } else if (practicum.pendingStreamScheduleEventId) {
      const scheduleEvent = await prisma.scheduleEvent.findUnique({ where: { id: practicum.pendingStreamScheduleEventId }, select: { id: true, title: true, practicumId: true } });
      if (scheduleEvent && scheduleEvent.practicumId === practicum.id) targetScheduleEvent = scheduleEvent;
    }
    // A module target additionally picks which of its two stream blocks this recording belongs
    // in — "Тематические записи" (STREAM) vs "Q&A с куратором" (QA). Irrelevant otherwise.
    const mediaKind = targetModule && practicum.pendingStreamMediaKind === MediaAssetKind.QA ? MediaAssetKind.QA : MediaAssetKind.STREAM;
    // The picked target is one-shot — consumed here regardless of whether it still resolved to
    // something valid, so a stale/deleted target doesn't keep silently failing every webhook.
    if (practicum.pendingStreamModuleId || practicum.pendingStreamScheduleEventId) {
      await prisma.practicum.update({ where: { id: practicum.id }, data: { pendingStreamModuleId: null, pendingStreamScheduleEventId: null, pendingStreamMediaKind: null } });
    }

    const isAutoPublished = Boolean(targetModule || targetScheduleEvent);
    const lastMedia = await prisma.mediaAsset.findFirst({
      where: targetScheduleEvent ? { scheduleEventId: targetScheduleEvent.id } : targetModule ? { moduleId: targetModule.id } : { practicumId: practicum.id, moduleId: null, scheduleEventId: null },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const media = await prisma.mediaAsset.create({
      data: {
        practicumId: practicum.id,
        provider: input.provider,
        providerKey: input.providerKey,
        kind: mediaKind,
        moduleId: targetModule?.id,
        scheduleEventId: targetScheduleEvent?.id,
        status: isAutoPublished ? MediaAssetStatus.PUBLISHED : MediaAssetStatus.DRAFT,
        publishedAt: isAutoPublished ? new Date() : undefined,
        title: targetScheduleEvent
          ? targetScheduleEvent.title
          : targetModule
            ? `${targetModule.title} — ${mediaKind === MediaAssetKind.QA ? "Q&A" : "запись эфира"}`
            : null,
        chatSessionStartedAt: isAutoPublished ? (input.preciseStart ?? practicum.currentStreamSessionStartedAt) : undefined,
        chatSessionEndedAt: isAutoPublished ? (input.preciseEnd ?? new Date()) : undefined,
        durationSec: input.durationSec != null ? Math.round(input.durationSec) : undefined,
        position: (lastMedia?.position ?? -1) + 1,
      },
    });

    if (!isAutoPublished) return;
    void activeStudentEmails(practicum.id)
      .then((emails) => Promise.all(emails.map((to) => sendNewMediaNotification({ to, mediaTitle: media.title ?? "Новая запись", kind: media.kind, mediaId: media.id }))))
      .catch((error: unknown) => console.error("Media recipient lookup failed", error instanceof Error ? error.message : "unknown error"));
    void activeStudentIds(practicum.id)
      .then((studentIds) => notificationService.createMany(studentIds, "NEW_MEDIA", `Новая запись: ${media.title ?? "без названия"}`, undefined, media.id))
      .catch((error: unknown) => console.error("Media notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
  }

  /**
   * Starts (or restarts, after an unexpected egress_ended) the recording once both of the OBS
   * ingress participant's tracks are visible. A track_published webhook alone doesn't say whether
   * it was the video or the audio track that just landed, and LiveKit doesn't guarantee webhook
   * ordering — so this re-derives ground truth from listParticipants rather than trying to
   * correlate two possibly-out-of-order events (same reasoning as reconcileLiveStatus).
   */
  private async maybeStartRecording(): Promise<void> {
    if (this.activeRecording || this.recordingStartInFlight) return;
    this.recordingStartInFlight = true;
    try {
      const participants = await roomServiceClient().listParticipants(LIVEKIT_ROOM_NAME).catch(() => []);
      const ingress = participants.find((participant) => participant.identity === LIVEKIT_INGRESS_PARTICIPANT_IDENTITY);
      const videoTrackId = ingress?.tracks.find((track) => track.type === TrackType.VIDEO)?.sid;
      const audioTrackId = ingress?.tracks.find((track) => track.type === TrackType.AUDIO)?.sid;
      if (!videoTrackId || !audioTrackId) return; // the other track hasn't published yet — the next track_published retries this
      const objectKey = newRecordingObjectKey();
      const output = { file: recordingFileOutput(objectKey), images: recordingImageOutput(recordingThumbnailObjectKey(objectKey)) };
      const info = await egressClient().startTrackCompositeEgress(LIVEKIT_ROOM_NAME, output, { videoTrackId, audioTrackId, encodingOptions: RECORDING_ENCODING_OPTIONS });
      this.activeRecording = { egressId: info.egressId, objectKey };
    } catch (error) {
      console.error("LiveKit recording start failed", error instanceof Error ? error.message : "unknown error");
    } finally {
      this.recordingStartInFlight = false;
    }
  }

  /** Finalizes a completed recording into a MediaAsset, and restarts a fresh segment if egress ended while OBS was still connected (no crash-resume exists in the SDK — this accepts a gap at the failure point instead of losing the rest of the broadcast). */
  private async finishRecording(info: EgressInfo): Promise<void> {
    const recording = this.activeRecording;
    if (!recording || info.egressId !== recording.egressId) return;
    this.activeRecording = null;

    if (info.status === EgressStatus.EGRESS_COMPLETE) {
      const durationSec = info.startedAt && info.endedAt ? Number(info.endedAt - info.startedAt) / 1_000_000_000 : null;
      await this.createMediaAssetFromRecording({
        provider: LIVEKIT_RECORDING_PROVIDER,
        providerKey: recording.objectKey,
        durationSec,
        preciseStart: info.startedAt ? new Date(Number(info.startedAt) / 1_000_000) : null,
        preciseEnd: info.endedAt ? new Date(Number(info.endedAt) / 1_000_000) : null,
      });
    } else {
      console.error("LiveKit recording ended without completing", EgressStatus[info.status], info.error);
    }

    const participants = await roomServiceClient().listParticipants(LIVEKIT_ROOM_NAME).catch(() => []);
    const stillLive = participants.some((participant) => participant.identity === LIVEKIT_INGRESS_PARTICIPANT_IDENTITY);
    if (stillLive) void this.maybeStartRecording();
  }

  private async assertCuratorPracticum(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
    if (!user || user.status !== UserStatus.ACTIVE || (user.role !== UserRole.CURATOR && user.role !== UserRole.OWNER)) {
      throw new AuthServiceError("FORBIDDEN", "Curator access required");
    }
    const practicum = await prisma.practicum.findFirst({ where: { isActive: true } });
    if (!practicum) throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");
    return practicum;
  }
}

export const streamService = new StreamService();
