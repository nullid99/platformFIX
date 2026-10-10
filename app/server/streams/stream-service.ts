import { MediaAssetKind, MediaAssetStatus, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { formatZonedDateTime } from "@/app/domain/schedule-time";
import { AuthServiceError } from "@/app/server/auth";
import { prisma } from "@/app/server/db";
import { activeStudentIds } from "@/app/server/notifications/recipient-service";
import { sendNewMediaNotification } from "@/app/server/notifications/email-service";
import { notificationService } from "@/app/server/notifications/notification-service";
import { isModuleOpenForStudent } from "@/app/server/course/module-access";
import { getActivePracticumId } from "@/app/server/course/practicum-service";
import { isStreamPrivate } from "./stream-visibility";
import { assertPracticumViewer } from "./access";
import { buildMasterPlaylist, HLS_MANIFEST_FILE, hlsRenditionPlaylistKey, isHlsRenditionName, parseHlsManifest, recordingHlsPrefix, signMediaPlaylist, type HlsManifest } from "./recording-hls";

// HLS copies are written once and never change, so they're cached in memory. "Not ready yet" is
// rechecked every minute; a signed playlist is reused for an hour (its URLs live 6 h, so a cached
// copy always has ≥5 h left) — the same for every viewer, since signed URLs carry no identity.
const HLS_MANIFEST_CACHE_MS = 10 * 60_000;
const HLS_MISSING_CACHE_MS = 60_000;
const HLS_SIGNED_PLAYLIST_CACHE_MS = 60 * 60_000;
const hlsManifestCache = new Map<string, { manifest: HlsManifest | null; expiresAt: number }>();
const hlsPlaylistCache = new Map<string, { text: string; expiresAt: number }>();

async function loadHlsManifest(objectKey: string): Promise<HlsManifest | null> {
  const cached = hlsManifestCache.get(objectKey);
  if (cached && cached.expiresAt > Date.now()) return cached.manifest;
  const text = await readRecordingObjectText(`${recordingHlsPrefix(objectKey)}${HLS_MANIFEST_FILE}`);
  const manifest = text ? parseHlsManifest(text) : null;
  if (text && !manifest) console.error("Recording HLS manifest is invalid", objectKey);
  hlsManifestCache.set(objectKey, { manifest, expiresAt: Date.now() + (manifest ? HLS_MANIFEST_CACHE_MS : HLS_MISSING_CACHE_MS) });
  return manifest;
}
import {
  EgressStatus,
  IngressInput,
  IngressState_Status,
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
  readRecordingObjectText,
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
  /** Whether LiveKit is actually writing this broadcast to a file (null = not known yet). */
  recording: RecordingState | null;
  /** Staff only (null for students): whether the curator picked a lesson/event for this broadcast. */
  hasStreamTarget: boolean | null;
  /** Staff only: who started this broadcast on the platform ("Начать стрим"). */
  host?: StreamHostDto;
};

export type RecordingState = "recording" | "starting" | "off";

// The watchdog refreshes the recording state every ~20s; older than this means it isn't running.
const RECORDING_STATE_MAX_AGE_MS = 45_000;

// A healthy egress goes STARTING → ACTIVE in ~1.5s; see superviseRecording.
const RECORDING_START_TIMEOUT_MS = 15_000;

export type RecordingStorageStatusDto = { totalBytes: number; usedBytes: number; availableBytes: number; updatedAt: string } | null;

/** "Эфир ведёт: Имя" — who pressed "Начать стрим" for the current/next broadcast. */
export type StreamHostDto = { name: string; startedAt: string; isMe: boolean } | null;

/**
 * Which поток a broadcast goes to (the one "Назначен для эфиров" in "Потоки") and two hints for
 * the "Стримы" page: a bigger unfinished поток exists (typically: switched to a test поток and
 * forgot to switch back), and the curator's own working поток differs from it.
 */
export type StreamPracticumDto = {
  title: string;
  students: number;
  biggerPracticum: { title: string; students: number } | null;
  workingPracticumTitle: string | null;
};

export type StreamTargetDto = {
  /** Staff only. */
  host?: StreamHostDto;
  /** Staff only. */
  practicum?: StreamPracticumDto;
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
  /**
   * Only guards against two track_published webhooks racing within the same still-running
   * process — never trusted across a restart. Whether a recording is already running, and what
   * to write into MediaAsset when one ends, are both re-derived from LiveKit itself (see
   * maybeStartRecording's listEgress check and finishRecording's use of the webhook's own
   * EgressInfo) specifically so a mid-broadcast deploy can't orphan a recording: LiveKit keeps
   * recording through our restart regardless, so our side just needs to stop assuming it
   * remembers anything about what's in flight.
   */
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
        // Never touch an ingress while OBS is actually streaming into it: LiveKit's UpdateIngress
        // restarts an active session, OBS reconnects on its own within a second, but the tracks
        // come back with new ids — which ends the running track-composite recording and starts a
        // fresh one, so every curator merely opening "Стримы" mid-broadcast (the page POSTs here on
        // mount) split the recording into another Медиатека entry. The update is only there to
        // pick up encoding-option changes, which can just as well wait for the next idle visit.
        const status = existing.state?.status;
        if (practicum.isCurrentlyLive || status === IngressState_Status.ENDPOINT_BUFFERING || status === IngressState_Status.ENDPOINT_PUBLISHING) {
          return ingressDto(existing, practicum.isCurrentlyLive);
        }
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

  /**
   * HLS master playlist for a recording (several qualities, small segments — see recording-hls.ts),
   * or null while the transcoder hasn't produced it yet; the player then keeps using the MP4 from
   * getRecordingPlaybackUrl. Same access rules as the MP4.
   */
  public async getRecordingHlsMaster(actorId: string, mediaAssetId: string): Promise<string | null> {
    const objectKey = await this.resolveOwnRecordingKey(actorId, mediaAssetId);
    const manifest = await loadHlsManifest(objectKey);
    return manifest ? buildMasterPlaylist(manifest, (rendition) => `${rendition}.m3u8`) : null;
  }

  /** One quality's playlist with every segment signed for direct download, or null if that quality doesn't exist. */
  public async getRecordingHlsPlaylist(actorId: string, mediaAssetId: string, rendition: string): Promise<string | null> {
    if (!isHlsRenditionName(rendition)) return null;
    const objectKey = await this.resolveOwnRecordingKey(actorId, mediaAssetId);
    const manifest = await loadHlsManifest(objectKey);
    if (!manifest?.renditions.some((item) => item.name === rendition)) return null;
    const cacheKey = `${objectKey}:${rendition}`;
    const cached = hlsPlaylistCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.text;
    const prefix = recordingHlsPrefix(objectKey);
    const stored = await readRecordingObjectText(hlsRenditionPlaylistKey(prefix, rendition));
    if (!stored) return null;
    const text = await signMediaPlaylist(stored, (file) => mintRecordingPlaybackUrl(`${prefix}${rendition}/${file}`));
    hlsPlaylistCache.set(cacheKey, { text, expiresAt: Date.now() + HLS_SIGNED_PLAYLIST_CACHE_MS });
    return text;
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

  /**
   * Safe for both curator and enrolled students — mints a fresh subscribe-only token per call,
   * never exposes the RTMP key. While the "private stream" switch is on, a student gets "not
   * live" back regardless of the real state and never gets a token — this is the actual access
   * gate (not just a hidden nav button), so a student with the page already open, or hitting
   * this endpoint directly, still can't get in. A curator/owner is unaffected — they need to
   * keep watching their own private/test broadcast.
   */
  public async getPlaybackStatus(actorId: string): Promise<PlaybackStatusDto> {
    const { practicumId, role } = await assertPracticumViewer(actorId);
    if (role === UserRole.STUDENT && await isStreamPrivate(practicumId)) {
      return { isLive: false, viewerToken: null, roomName: null, liveScheduleEventId: null, recording: null, hasStreamTarget: null };
    }
    const isStaffViewer = role !== UserRole.STUDENT;
    const practicum = await prisma.practicum.findUnique({ where: { id: practicumId }, select: { isCurrentlyLive: true, pendingStreamScheduleEventId: true, pendingStreamModuleId: true } });
    if (!practicum?.isCurrentlyLive) return { isLive: false, viewerToken: null, roomName: null, liveScheduleEventId: null, recording: null, hasStreamTarget: null };
    const viewerToken = await mintViewerToken(actorId);
    const recording = await this.getRecordingState({ allowFetch: isStaffViewer });
    const hasStreamTarget = isStaffViewer ? Boolean(practicum.pendingStreamModuleId || practicum.pendingStreamScheduleEventId) : null;
    const host = isStaffViewer ? await this.resolveStreamHost(practicumId, actorId) : undefined;
    return { isLive: true, viewerToken, roomName: LIVEKIT_ROOM_NAME, liveScheduleEventId: practicum.pendingStreamScheduleEventId, recording, hasStreamTarget, host };
  }

  /**
   * Read-only for both roles, like getPlaybackStatus — resolves to the caller's own practicum
   * (their enrollment for a student, the active one for staff) and reports its "private stream"
   * flag. A student's own sidebar needs this to decide whether to hide "Стрим" at all,
   * independent of whether a stream happens to be live right now. The flag alone reveals nothing
   * about content. Setting it is per-practicum-row, owner/curator-only — see
   * practicum-admin-service.ts#setPracticumStreamsPrivate, from the "Потоки" list instead of here,
   * since a curator/owner may want to set it for a practicum other than their own current one.
   */
  public async getVisibilitySettings(actorId: string): Promise<{ streamsPrivate: boolean }> {
    const { practicumId } = await assertPracticumViewer(actorId);
    return { streamsPrivate: await isStreamPrivate(practicumId) };
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
   * both of the ingress participant's tracks are up; egress_ended finalizes it. There's one
   * shared room for the whole install (see LIVEKIT_ROOM_NAME), but only the currently *active*
   * practicum (getActivePracticumId) is the one actually broadcasting into it — writing the flag
   * onto every practicum row used to leak "live" onto every other cohort (including long-finished
   * ones a returning student might reopen months later), which is exactly the bug this scopes.
   */
  public async handleLiveKitWebhookEvent(event: WebhookEvent): Promise<void> {
    if (event.event === "egress_ended") {
      if (event.egressInfo) void this.finishRecording(event.egressInfo);
      return;
    }
    if (event.room?.name !== LIVEKIT_ROOM_NAME || event.participant?.identity !== LIVEKIT_INGRESS_PARTICIPANT_IDENTITY) return;

    if (event.event === "participant_joined" || event.event === "participant_left") {
      const activePracticumId = await getActivePracticumId();
      if (activePracticumId) {
        await prisma.practicum.update({ where: { id: activePracticumId }, data: { isCurrentlyLive: event.event === "participant_joined" } });
      }
      return;
    }
    if (event.event === "track_published") void this.maybeStartRecording();
  }

  /**
   * Re-derives isCurrentlyLive from LiveKit's own participant list instead of trusting whatever
   * the DB flag currently says. Called once on API startup (a restart mid-broadcast means no
   * participant_joined re-fires) and periodically by the notifier (see RECONCILE_INTERVAL_TICKS
   * in stream-live-notifier.ts) as a backstop for webhook deliveries LiveKit never guarantees.
   * Also the self-heal for any practicum stuck with a stale `true` from before this method (or the
   * webhook handler above) scoped its write to the active practicum only — every non-active row
   * gets forced back to false here on top of the active one getting the real value.
   */
  public async reconcileLiveStatus(): Promise<void> {
    try {
      const participants = await roomServiceClient().listParticipants(LIVEKIT_ROOM_NAME).catch(() => []);
      const isLive = participants.some((participant) => participant.identity === LIVEKIT_INGRESS_PARTICIPANT_IDENTITY);
      const activePracticumId = await getActivePracticumId();
      await prisma.practicum.updateMany({
        where: activePracticumId ? { id: { not: activePracticumId } } : {},
        data: { isCurrentlyLive: false },
      });
      if (activePracticumId) {
        await prisma.practicum.update({ where: { id: activePracticumId }, data: { isCurrentlyLive: isLive } });
      }
    } catch (error) {
      console.error("LiveKit startup reconciliation failed", error instanceof Error ? error.message : "unknown error");
    }
  }

  /** What the curator picked on "Стримы" as the destination for the next/current broadcast. */
  public async getStreamTarget(actorId: string): Promise<StreamTargetDto> {
    const practicum = await this.assertCuratorPracticum(actorId);
    const current = await prisma.practicum.findUnique({ where: { id: practicum.id }, select: { pendingStreamModuleId: true, pendingStreamScheduleEventId: true, pendingStreamMediaKind: true } });
    const target = await this.resolveStreamTarget(current?.pendingStreamModuleId ?? null, current?.pendingStreamScheduleEventId ?? null, current?.pendingStreamMediaKind ?? null);
    const [host, streamPracticum] = await Promise.all([this.resolveStreamHost(practicum.id, actorId), this.resolveStreamPracticum(practicum.id, practicum.title, actorId)]);
    return { ...target, host, practicum: streamPracticum };
  }

  private async resolveStreamPracticum(practicumId: string, title: string, actorId: string): Promise<StreamPracticumDto> {
    const [counts, practicums, actor] = await Promise.all([
      prisma.enrollment.groupBy({ by: ["practicumId"], where: { status: "ACTIVE" }, _count: { _all: true } }),
      prisma.practicum.findMany({ select: { id: true, title: true, completedAt: true } }),
      prisma.user.findUnique({ where: { id: actorId }, select: { workingPracticumId: true, workingPracticum: { select: { title: true } } } }),
    ]);
    const studentsIn = (id: string) => counts.find((row) => row.practicumId === id)?._count._all ?? 0;
    const students = studentsIn(practicumId);
    const bigger = practicums
      .filter((item) => item.id !== practicumId && !item.completedAt && studentsIn(item.id) > students)
      .sort((left, right) => studentsIn(right.id) - studentsIn(left.id))[0];
    return {
      title,
      students,
      biggerPracticum: bigger ? { title: bigger.title, students: studentsIn(bigger.id) } : null,
      // null = no personal pick (falls back to the stream поток) or the same one — nothing to warn about.
      workingPracticumTitle: actor?.workingPracticumId && actor.workingPracticumId !== practicumId ? actor.workingPracticum?.title ?? null : null,
    };
  }

  /**
   * All curators share one OBS key, so LiveKit can't tell who is broadcasting — the platform
   * remembers who pressed "Начать стрим" (or picked the target on "Стримы") instead.
   */
  private async resolveStreamHost(practicumId: string, actorId: string): Promise<StreamHostDto> {
    const practicum = await prisma.practicum.findUnique({
      where: { id: practicumId },
      select: { streamStartedAt: true, streamStartedBy: { select: { id: true, email: true, externalIdentities: { select: { displayName: true, username: true }, orderBy: { createdAt: "asc" }, take: 1 } } } },
    });
    const user = practicum?.streamStartedBy;
    if (!user || !practicum?.streamStartedAt) return null;
    const identity = user.externalIdentities[0];
    return { name: identity?.displayName ?? identity?.username ?? user.email ?? "Куратор", startedAt: practicum.streamStartedAt.toISOString(), isMe: user.id === actorId };
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
      if (!scheduleEvent) throw new AuthServiceError("INVALID_INPUT", "Schedule event does not exist");
      // Broadcasts always go to the practicum assigned for streams ("Назначить для эфиров"), while
      // a curator's "Расписание" shows their own working поток — which can be a different one.
      if (scheduleEvent.practicumId !== practicum.id) throw new AuthServiceError("INVALID_INPUT", `Это событие из другого потока. Эфиры сейчас идут в поток «${practicum.title}» — переключитесь на него в «Потоках» или выберите событие оттуда.`);
      scheduleEventId = input.scheduleEventId;
    }
    const hasTarget = Boolean(moduleId || scheduleEventId);
    await prisma.practicum.update({
      where: { id: practicum.id },
      data: {
        pendingStreamModuleId: moduleId,
        pendingStreamScheduleEventId: scheduleEventId,
        pendingStreamMediaKind: mediaKind,
        streamStartedById: hasTarget ? actorId : null,
        streamStartedAt: hasTarget ? new Date() : null,
      },
    });
    // "Начать стрим" again on an event already marked finished (a second session, or the end was
    // pressed too early) — it's live again, not "Эфир завершён".
    if (scheduleEventId) await prisma.scheduleEvent.update({ where: { id: scheduleEventId }, data: { streamEndedAt: null } });
    return { ...(await this.resolveStreamTarget(moduleId, scheduleEventId, mediaKind)), host: await this.resolveStreamHost(practicum.id, actorId) };
  }

  /**
   * "Завершить эфир" — from the schedule event or the "Стримы" page. Marks the event finished
   * (students' schedule shows "Эфир завершён", then "Открыть запись" once the curator publishes
   * the draft) and clears the broadcast's target, so the next broadcast can't land on this event
   * by mistake. Ending the actual video is still OBS's "Остановить трансляцию"; a recording that
   * finishes after this is still filed under the event — see createMediaAssetFromRecording.
   */
  public async finishStream(actorId: string, scheduleEventId: string): Promise<StreamTargetDto> {
    const practicum = await this.assertCuratorPracticum(actorId);
    const scheduleEvent = await prisma.scheduleEvent.findUnique({ where: { id: scheduleEventId }, select: { practicumId: true } });
    if (!scheduleEvent || scheduleEvent.practicumId !== practicum.id) throw new AuthServiceError("INVALID_INPUT", "Schedule event does not exist");
    await prisma.$transaction([
      prisma.scheduleEvent.update({ where: { id: scheduleEventId }, data: { streamEndedAt: new Date() } }),
      prisma.practicum.updateMany({
        where: { id: practicum.id, pendingStreamScheduleEventId: scheduleEventId },
        data: { pendingStreamModuleId: null, pendingStreamScheduleEventId: null, pendingStreamMediaKind: null, streamStartedById: null, streamStartedAt: null },
      }),
    ]);
    const current = await prisma.practicum.findUnique({ where: { id: practicum.id }, select: { pendingStreamModuleId: true, pendingStreamScheduleEventId: true, pendingStreamMediaKind: true } });
    const target = await this.resolveStreamTarget(current?.pendingStreamModuleId ?? null, current?.pendingStreamScheduleEventId ?? null, current?.pendingStreamMediaKind ?? null);
    return { ...target, host: await this.resolveStreamHost(practicum.id, actorId) };
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
   * target (Practicum.pendingStream*, picked on "Стримы" or via "Начать стрим" on a schedule
   * event) — a lesson target auto-publishes and notifies students; an event target becomes a
   * draft filed under that event; no target becomes an unassigned draft for the Медиатека. Idempotent on (provider, providerKey) so a
   * retried webhook/reconciliation is safe.
   */
  private async createMediaAssetFromRecording(input: { provider: string; providerKey: string; durationSec: number | null; byteSize: bigint | null; preciseStart: Date | null; preciseEnd: Date | null }): Promise<void> {
    // LiveKit's webhook delivery is at-least-once, so egress_ended can arrive twice for the same
    // recording. The existence check below is otherwise a check-then-insert race, and the
    // (provider, providerKey, moduleId) unique constraint doesn't save us here: an unassigned
    // recording has moduleId NULL on both attempted rows, and Postgres never treats two NULLs as
    // equal for uniqueness — so a redelivered webhook could sail past it and create a duplicate
    // MediaAsset for the exact same file. The advisory lock (held for the transaction's lifetime,
    // keyed on the object key) serializes any overlapping delivery around that check.
    const lockKey = `${input.provider}:${input.providerKey}`;
    const result = await prisma.$transaction(async (tx) => {
      // $queryRaw here throws — pg_advisory_xact_lock returns void, and the adapter-pg driver
      // can't deserialize a void-typed result column ("UnsupportedNativeDataType"). $executeRaw
      // doesn't try to decode the row at all, only the affected count, so it's the one that
      // actually works for a call made purely for its side effect.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const existing = await tx.mediaAsset.findFirst({ where: { provider: input.provider, providerKey: input.providerKey }, select: { id: true } });
      if (existing) return null;

      // The broadcast that just finished recording was necessarily live on the active practicum —
      // that's whichever row setStreamTarget/ensureIngress wrote pendingStream*/liveKitIngressId onto.
      const practicum = await tx.practicum.findFirst({
        where: { isActive: true },
        select: { id: true, pendingStreamModuleId: true, pendingStreamScheduleEventId: true, pendingStreamMediaKind: true, currentStreamSessionStartedAt: true },
      });
      if (!practicum) {
        console.error("Recording ready: no practicum found for", input.providerKey);
        return null;
      }

      let targetModule: { id: string; title: string } | null = null;
      let targetScheduleEvent: { id: string; title: string } | null = null;
      if (practicum.pendingStreamModuleId) {
        const courseModule = await tx.module.findUnique({ where: { id: practicum.pendingStreamModuleId }, select: { id: true, title: true, practicumId: true } });
        if (courseModule && courseModule.practicumId === practicum.id) targetModule = courseModule;
      } else if (practicum.pendingStreamScheduleEventId) {
        const scheduleEvent = await tx.scheduleEvent.findUnique({ where: { id: practicum.pendingStreamScheduleEventId }, select: { id: true, title: true, practicumId: true } });
        if (scheduleEvent && scheduleEvent.practicumId === practicum.id) targetScheduleEvent = scheduleEvent;
      } else {
        // "Завершить эфир" usually gets pressed before OBS is stopped, so the recording can finish
        // after the target was already cleared — file it under the event that was ended while this
        // recording ran (or within a few minutes after), instead of as an unassigned draft.
        const recordingStart = input.preciseStart ?? new Date(Date.now() - 6 * 60 * 60_000);
        const recordingEnd = input.preciseEnd ?? new Date();
        targetScheduleEvent = await tx.scheduleEvent.findFirst({
          where: { practicumId: practicum.id, streamEndedAt: { gte: recordingStart, lte: new Date(recordingEnd.getTime() + 15 * 60_000) } },
          orderBy: { streamEndedAt: "desc" },
          select: { id: true, title: true },
        });
      }
      // A module target additionally picks which of its two stream blocks this recording belongs
      // in — "Тематические записи" (STREAM) vs "Q&A с куратором" (QA). Irrelevant otherwise.
      const mediaKind = targetModule && practicum.pendingStreamMediaKind === MediaAssetKind.QA ? MediaAssetKind.QA : MediaAssetKind.STREAM;
      // A lesson target is one-shot — consumed here regardless of whether it still resolved to
      // something valid, so a stale/deleted target doesn't keep silently failing every webhook.
      // A schedule-event target is NOT: it stays for the whole broadcast (an OBS reconnect splits
      // the recording, and the second half must land on the same event too) and is cleared by
      // "Завершить эфир" (finishStream) or by starting the next event's stream.
      if (practicum.pendingStreamModuleId) {
        await tx.practicum.update({ where: { id: practicum.id }, data: { pendingStreamModuleId: null, pendingStreamScheduleEventId: null, pendingStreamMediaKind: null } });
      }

      // Event broadcasts become a DRAFT already filed under the event (decided 2026-10-02): the
      // curator reviews it in Медиатека and publishes with one click; until then students see
      // "Эфир завершён · запись скоро появится". Lesson targets still auto-publish as before.
      const isAutoPublished = Boolean(targetModule);
      const lastMedia = await tx.mediaAsset.findFirst({
        where: targetScheduleEvent ? { scheduleEventId: targetScheduleEvent.id } : targetModule ? { moduleId: targetModule.id } : { practicumId: practicum.id, moduleId: null, scheduleEventId: null },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      const media = await tx.mediaAsset.create({
        data: {
          practicumId: practicum.id,
          provider: input.provider,
          providerKey: input.providerKey,
          kind: mediaKind,
          moduleId: targetModule?.id,
          scheduleEventId: targetScheduleEvent?.id,
          status: isAutoPublished ? MediaAssetStatus.PUBLISHED : MediaAssetStatus.DRAFT,
          publishedAt: isAutoPublished ? new Date() : undefined,
          // Unassigned recordings get a "date + time" title instead of a bare null (which the
          // frontend renders as "Без названия") so the curator can tell drafts apart in Медиатека.
          // Event drafts carry the start time too — a broadcast split by an OBS reconnect yields
          // two drafts on the same event, and the curator needs to tell them apart.
          title: targetScheduleEvent
            ? `${targetScheduleEvent.title} — запись эфира ${formatZonedDateTime(input.preciseStart ?? new Date())}`
            : targetModule
              ? `${targetModule.title} — ${mediaKind === MediaAssetKind.QA ? "Q&A" : "запись эфира"}`
              : `Запись ${formatZonedDateTime(input.preciseStart ?? new Date())}`,
          // Also for event drafts: the "Чат эфира" archive under the recording is cut from this
          // window once the curator publishes it.
          chatSessionStartedAt: isAutoPublished || targetScheduleEvent ? (input.preciseStart ?? practicum.currentStreamSessionStartedAt) : undefined,
          chatSessionEndedAt: isAutoPublished || targetScheduleEvent ? (input.preciseEnd ?? new Date()) : undefined,
          durationSec: input.durationSec != null ? Math.round(input.durationSec) : undefined,
          byteSize: input.byteSize ?? undefined,
          position: (lastMedia?.position ?? -1) + 1,
        },
      });
      return { media, practicumId: practicum.id, isAutoPublished };
    });

    if (!result || !result.isAutoPublished) return;
    const { media, practicumId } = result;
    const moduleId = media.moduleId;
    // Same per-student gate as course-service.ts#publishMedia — a recording landing straight
    // into a module a student hasn't unlocked yet must not tell them about it early. A
    // schedule-event target (Q&A recordings, mostly) has no "closed lesson" to gate on.
    void (async () => {
      const candidateIds = await activeStudentIds(practicumId);
      const openIds = moduleId
        ? (await Promise.all(candidateIds.map(async (studentId) => ({ studentId, open: await isModuleOpenForStudent(prisma, studentId, practicumId, moduleId) }))))
            .filter((entry) => entry.open)
            .map((entry) => entry.studentId)
        : candidateIds;
      // An Advanced lesson's access rows exist for non-Advanced students too — see course-service.ts#publishMedia.
      const inAdvancedLesson = moduleId ? (await prisma.module.findUnique({ where: { id: moduleId }, select: { section: true } }))?.section === "Advanced" : false;
      const notifiableIds = inAdvancedLesson
        ? (await prisma.user.findMany({ where: { id: { in: openIds }, isAdvanced: true }, select: { id: true } })).map((student) => student.id)
        : openIds;
      if (notifiableIds.length === 0) return;
      const recipients = await prisma.user.findMany({ where: { id: { in: notifiableIds }, email: { not: null } }, select: { email: true } });
      await Promise.all(recipients.map((recipient) => recipient.email && sendNewMediaNotification({ to: recipient.email, mediaTitle: media.title ?? "Новая запись", kind: media.kind, mediaId: media.id })));
      await notificationService.createMany(notifiableIds, "NEW_MEDIA", `Новая запись: ${media.title ?? "без названия"}`, undefined, media.id);
    })().catch((error: unknown) => console.error("Media notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
  }

  /**
   * Starts (or restarts, after an unexpected egress_ended) the recording once both of the OBS
   * ingress participant's tracks are visible. A track_published webhook alone doesn't say whether
   * it was the video or the audio track that just landed, and LiveKit doesn't guarantee webhook
   * ordering — so this re-derives ground truth from listParticipants rather than trying to
   * correlate two possibly-out-of-order events (same reasoning as reconcileLiveStatus).
   */
  /**
   * Recording watchdog, run by the live notifier every tick (~20s). A real incident on
   * 2026-10-01: a corrupted H.264 frame arrived in the egress's first second, its GStreamer
   * pipeline stayed PAUSED forever ("pipeline paused" but never "pipeline playing"), and LiveKit
   * kept reporting the egress as STARTING for the whole 55-minute broadcast — so
   * maybeStartRecording's "already recording" check never let a second attempt through and the
   * broadcast was lost with nobody noticing. A healthy egress reaches ACTIVE in ~1.5s, so one
   * still STARTING after RECORDING_START_TIMEOUT_MS is stopped and replaced; a fresh egress starts
   * from a fresh keyframe. Also starts a recording if OBS is live and none is running at all
   * (e.g. a track_published webhook that never arrived).
   */
  private readonly egressFirstSeenAt = new Map<string, number>();
  /**
   * What the watchdog last saw (it asks LiveKit every ~20s anyway). getPlaybackStatus serves the
   * recording indicator from here, so every viewer's 15s status poll — students included, ~90 of
   * them during a broadcast — costs LiveKit nothing extra.
   */
  private lastRecordingState: { state: RecordingState; at: number } | null = null;

  private rememberRecordingState(running: Array<{ status: EgressStatus }>): void {
    const state: RecordingState = running.some((egress) => egress.status === EgressStatus.EGRESS_ACTIVE) ? "recording"
      : running.some((egress) => egress.status === EgressStatus.EGRESS_STARTING) ? "starting"
      : "off";
    this.lastRecordingState = { state, at: Date.now() };
  }

  public async superviseRecording(): Promise<void> {
    try {
      const participants = await roomServiceClient().listParticipants(LIVEKIT_ROOM_NAME).catch(() => null);
      if (!participants) return; // LiveKit unreachable — don't act on a guess
      if (!participants.some((participant) => participant.identity === LIVEKIT_INGRESS_PARTICIPANT_IDENTITY)) {
        this.egressFirstSeenAt.clear();
        this.lastRecordingState = null;
        return;
      }
      const running = await egressClient().listEgress({ roomName: LIVEKIT_ROOM_NAME, active: true }).catch(() => null);
      if (!running) return;
      this.rememberRecordingState(running);

      const now = Date.now();
      let recordingInProgress = false;
      for (const egress of running) {
        if (egress.status !== EgressStatus.EGRESS_STARTING) {
          // ACTIVE is healthy; ENDING is on its way out and egress_ended → finishRecording
          // restarts a fresh segment by itself if OBS is still live.
          recordingInProgress = true;
          continue;
        }
        const firstSeen = this.egressFirstSeenAt.get(egress.egressId) ?? now;
        this.egressFirstSeenAt.set(egress.egressId, firstSeen);
        const startedAt = egress.startedAt ? Number(egress.startedAt) / 1_000_000 : firstSeen;
        if (now - Math.min(startedAt, firstSeen) < RECORDING_START_TIMEOUT_MS) {
          recordingInProgress = true;
          continue;
        }
        console.error("LiveKit recording stuck before starting — stopping it to start a fresh one", egress.egressId);
        this.egressFirstSeenAt.delete(egress.egressId);
        await egressClient().stopEgress(egress.egressId).catch((error: unknown) => console.error("Stuck recording stop failed", egress.egressId, error instanceof Error ? error.message : "unknown error"));
      }
      if (!recordingInProgress) {
        // Short pause so LiveKit has dropped the stopped egress from its active list before
        // maybeStartRecording checks it; its own egress_ended webhook may get there first, and
        // recordingStartInFlight + the active-list check keep the two from doubling up.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        await this.maybeStartRecording();
      }
    } catch (error) {
      console.error("Recording watchdog failed", error instanceof Error ? error.message : "unknown error");
    }
  }

  /**
   * Recording indicator for everyone watching (staff and, since 2026-10-02, students too — a viewer
   * who notices "Запись не идёт" can tell the curator). Served from the watchdog's last look; only
   * a staff request may fall back to asking LiveKit itself, and only if that look is stale (e.g.
   * the first seconds after an API restart), so viewer count never multiplies LiveKit calls.
   */
  public async getRecordingState(options: { allowFetch: boolean }): Promise<RecordingState | null> {
    if (this.lastRecordingState && Date.now() - this.lastRecordingState.at < RECORDING_STATE_MAX_AGE_MS) return this.lastRecordingState.state;
    if (!options.allowFetch) return null;
    const running = await egressClient().listEgress({ roomName: LIVEKIT_ROOM_NAME, active: true }).catch(() => null);
    if (!running) return null;
    this.rememberRecordingState(running);
    return this.lastRecordingState?.state ?? null;
  }

  private async maybeStartRecording(): Promise<void> {
    if (this.recordingStartInFlight) return;
    this.recordingStartInFlight = true;
    try {
      // Ask LiveKit rather than trusting our own memory — after a mid-broadcast API restart this
      // is the only way to know a recording is already running, and skipping it would start a
      // second, overlapping egress for the same broadcast.
      const alreadyRecording = await egressClient().listEgress({ roomName: LIVEKIT_ROOM_NAME, active: true }).catch(() => []);
      if (alreadyRecording.length > 0) return;
      const participants = await roomServiceClient().listParticipants(LIVEKIT_ROOM_NAME).catch(() => []);
      const ingress = participants.find((participant) => participant.identity === LIVEKIT_INGRESS_PARTICIPANT_IDENTITY);
      const videoTrackId = ingress?.tracks.find((track) => track.type === TrackType.VIDEO)?.sid;
      const audioTrackId = ingress?.tracks.find((track) => track.type === TrackType.AUDIO)?.sid;
      if (!videoTrackId || !audioTrackId) return; // the other track hasn't published yet — the next track_published retries this
      const objectKey = newRecordingObjectKey();
      const output = { file: recordingFileOutput(objectKey), images: recordingImageOutput(recordingThumbnailObjectKey(objectKey)) };
      await egressClient().startTrackCompositeEgress(LIVEKIT_ROOM_NAME, output, { videoTrackId, audioTrackId, encodingOptions: RECORDING_ENCODING_OPTIONS });
    } catch (error) {
      console.error("LiveKit recording start failed", error instanceof Error ? error.message : "unknown error");
    } finally {
      this.recordingStartInFlight = false;
    }
  }

  /**
   * Finalizes a completed recording into a MediaAsset, and restarts a fresh segment if egress
   * ended while OBS was still connected (no crash-resume exists in the SDK — this accepts a gap
   * at the failure point instead of losing the rest of the broadcast). Reads the object key and
   * timing straight off the webhook's own EgressInfo instead of matching against in-memory
   * state, so a recording that outlives an API restart (a deploy mid-broadcast) still lands in
   * the Медиатека instead of silently vanishing — createMediaAssetFromRecording is idempotent on
   * (provider, providerKey), so a redelivered egress_ended is harmless too.
   */
  private async finishRecording(info: EgressInfo): Promise<void> {
    if (info.roomName !== LIVEKIT_ROOM_NAME) return;

    if (info.status === EgressStatus.EGRESS_COMPLETE) {
      const objectKey = info.fileResults[0]?.filename;
      if (!objectKey) {
        console.error("LiveKit recording completed without a file result", info.egressId);
      } else {
        const durationSec = info.startedAt && info.endedAt ? Number(info.endedAt - info.startedAt) / 1_000_000_000 : null;
        // Uncaught here means this whole method (called via `void` from the webhook handler)
        // rejects silently — the recording finished and is safe in storage, but the Медиатека
        // row that makes it visible never gets written and nothing surfaces beyond an unhandled
        // rejection warning easy to miss in the logs. Catch and log loudly instead.
        await this.createMediaAssetFromRecording({
          provider: LIVEKIT_RECORDING_PROVIDER,
          providerKey: objectKey,
          durationSec,
          byteSize: info.fileResults[0]?.size ?? null,
          preciseStart: info.startedAt ? new Date(Number(info.startedAt) / 1_000_000) : null,
          preciseEnd: info.endedAt ? new Date(Number(info.endedAt) / 1_000_000) : null,
        }).catch((error: unknown) => console.error("Recording media asset creation failed", info.egressId, error instanceof Error ? error.message : error));
      }
    } else {
      console.error("LiveKit recording ended without completing", EgressStatus[info.status], info.error);
    }

    const participants = await roomServiceClient().listParticipants(LIVEKIT_ROOM_NAME).catch(() => []);
    const stillLive = participants.some((participant) => participant.identity === LIVEKIT_INGRESS_PARTICIPANT_IDENTITY);
    if (stillLive) void this.maybeStartRecording();
  }

  /**
   * Disk usage for the recording storage box (LiveKit + MinIO), read from a static JSON file a
   * cron job on that box refreshes every 5 minutes — see /opt/livekit/status/disk-status.sh there.
   * That box is separate from this API's own host, so this is a plain HTTPS fetch rather than a
   * DB read. Cached briefly since several curators loading "Стримы" shouldn't each trigger a
   * fetch, and a stale cached value beats none if the fetch itself fails.
   */
  private storageStatusCache: { value: RecordingStorageStatusDto; fetchedAt: number } | null = null;

  public async getRecordingStorageStatus(actorId: string): Promise<RecordingStorageStatusDto> {
    await this.assertCuratorPracticum(actorId);
    if (this.storageStatusCache && Date.now() - this.storageStatusCache.fetchedAt < 30_000) return this.storageStatusCache.value;
    const host = process.env.LIVEKIT_HOST?.trim();
    if (!host) return null;
    try {
      const response = await fetch(`${host}/status/disk.json`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const data = await response.json() as RecordingStorageStatusDto;
      this.storageStatusCache = { value: data, fetchedAt: Date.now() };
      return data;
    } catch (error) {
      console.error("Recording storage status fetch failed", error instanceof Error ? error.message : "unknown error");
      return this.storageStatusCache?.value ?? null;
    }
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
