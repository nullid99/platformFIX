import { MediaAssetKind, MediaAssetStatus, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { AuthServiceError } from "@/app/server/auth";
import { prisma } from "@/app/server/db";
import { assertPracticumViewer } from "./access";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

type CloudflareLiveInput = {
  uid: string;
  rtmps?: { url: string; streamKey: string } | null;
  webRTCPlayback?: { url: string } | null;
  status?: { current?: { state?: string | null } | null } | null;
};

type CloudflareEnvelope<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ message: string }>;
};

export type LiveInputDto = {
  uid: string;
  rtmpsUrl: string | null;
  rtmpsStreamKey: string | null;
  isLive: boolean;
  playbackIframeUrl: string | null;
};

export type PlaybackStatusDto = {
  isLive: boolean;
  playbackIframeUrl: string | null;
};

/** providerKey for this provider is "<customer-subdomain>/<video-uid>" — see mediaEmbedUrl/mediaThumbnailUrl in course-service.ts. */
export const CLOUDFLARE_STREAM_PROVIDER = "CLOUDFLARE_STREAM";

const LIVE_STATES = new Set(["connected", "reconnected"]);

function customerSubdomainFromPlaybackUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /^https:\/\/(customer-[a-z0-9]+\.cloudflarestream\.com)\//i.exec(url);
  return match ? match[1] : null;
}

function cloudflareCredentials(): { accountId: string; token: string } {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_STREAM_API_TOKEN?.trim();
  if (!accountId || !token) throw new AuthServiceError("INVALID_INPUT", "Cloudflare Stream is not configured");
  return { accountId, token };
}

async function cloudflareFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { accountId, token } = cloudflareCredentials();
  const response = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${accountId}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => null) as CloudflareEnvelope<T> | null;
  if (!response.ok || !payload?.success) {
    const message = payload?.errors?.[0]?.message || `Cloudflare Stream request failed (${response.status})`;
    throw new AuthServiceError("INVALID_INPUT", message);
  }
  return payload.result;
}

function liveInputDto(input: CloudflareLiveInput): LiveInputDto {
  const state = input.status?.current?.state ?? null;
  const subdomain = customerSubdomainFromPlaybackUrl(input.webRTCPlayback?.url);
  return {
    uid: input.uid,
    rtmpsUrl: input.rtmps?.url ?? null,
    rtmpsStreamKey: input.rtmps?.streamKey ?? null,
    isLive: state !== null && LIVE_STATES.has(state),
    playbackIframeUrl: subdomain ? `https://${subdomain}/${input.uid}/iframe` : null,
  };
}

export class StreamService {
  public async getLiveInput(actorId: string): Promise<LiveInputDto | null> {
    const practicum = await this.assertCuratorPracticum(actorId);
    if (!practicum.streamLiveInputUid) return null;
    const result = await cloudflareFetch<CloudflareLiveInput>(`/stream/live_inputs/${practicum.streamLiveInputUid}`);
    return liveInputDto(result);
  }

  public async ensureLiveInput(actorId: string): Promise<LiveInputDto> {
    const practicum = await this.assertCuratorPracticum(actorId);
    if (practicum.streamLiveInputUid) {
      // Re-applied on every call (not just once at creation) so a live input provisioned
      // before Low-Latency HLS was wired up gets upgraded automatically — this does not
      // rotate the RTMP URL/key, so OBS keeps working unchanged.
      const result = await cloudflareFetch<CloudflareLiveInput>(`/stream/live_inputs/${practicum.streamLiveInputUid}`, {
        method: "PUT",
        body: JSON.stringify({ preferLowLatency: true, recording: { mode: "automatic", requireSignedURLs: false } }),
      });
      return liveInputDto(result);
    }
    const created = await cloudflareFetch<CloudflareLiveInput>("/stream/live_inputs", {
      method: "POST",
      body: JSON.stringify({
        meta: { practicumId: practicum.id, name: practicum.title },
        recording: { mode: "automatic", requireSignedURLs: false },
        preferLowLatency: true,
      }),
    });
    await prisma.practicum.update({ where: { id: practicum.id }, data: { streamLiveInputUid: created.uid } });
    return liveInputDto(created);
  }

  /** Safe for both curator and enrolled students — never exposes the RTMP key. */
  public async getPlaybackStatus(actorId: string): Promise<PlaybackStatusDto> {
    const { practicumId } = await assertPracticumViewer(actorId);
    const practicum = await prisma.practicum.findUnique({ where: { id: practicumId }, select: { streamLiveInputUid: true } });
    if (!practicum?.streamLiveInputUid) return { isLive: false, playbackIframeUrl: null };
    const result = await cloudflareFetch<CloudflareLiveInput>(`/stream/live_inputs/${practicum.streamLiveInputUid}`);
    const { isLive, playbackIframeUrl } = liveInputDto(result);
    return { isLive, playbackIframeUrl };
  }

  /** For the background notifier only — no user context, checks every practicum with a configured live input. */
  public async checkLiveForNotifications(): Promise<Array<{ practicumId: string; isLive: boolean }>> {
    const practicums = await prisma.practicum.findMany({ where: { streamLiveInputUid: { not: null } }, select: { id: true, streamLiveInputUid: true } });
    const results: Array<{ practicumId: string; isLive: boolean }> = [];
    for (const practicum of practicums) {
      try {
        const result = await cloudflareFetch<CloudflareLiveInput>(`/stream/live_inputs/${practicum.streamLiveInputUid}`);
        results.push({ practicumId: practicum.id, isLive: liveInputDto(result).isLive });
      } catch (error) {
        console.error("Live status check failed for notifier", error instanceof Error ? error.message : "unknown error");
      }
    }
    return results;
  }

  /** Called by the background notifier when a broadcast is confirmed live — starts a fresh chat session. */
  public async startNewChatSession(practicumId: string): Promise<void> {
    await prisma.practicum.update({ where: { id: practicumId }, data: { currentStreamSessionStartedAt: new Date() } });
  }

  /**
   * Called from the Cloudflare Stream webhook once a live-input recording finishes processing.
   * Creates a draft MediaAsset so the curator can review and publish it from the Медиатека —
   * nothing is auto-published to students.
   */
  public async handleRecordingReady(input: { videoUid: string; playbackUrl: string | null | undefined }): Promise<void> {
    const subdomain = customerSubdomainFromPlaybackUrl(input.playbackUrl);
    if (!subdomain) {
      console.error("Stream webhook: could not derive customer subdomain from playback URL", input.playbackUrl);
      return;
    }
    const providerKey = `${subdomain}/${input.videoUid}`;

    const existing = await prisma.mediaAsset.findFirst({ where: { provider: CLOUDFLARE_STREAM_PROVIDER, providerKey }, select: { id: true } });
    if (existing) return;

    const practicum = await prisma.practicum.findFirst({ where: { streamLiveInputUid: { not: null } }, orderBy: { createdAt: "asc" }, select: { id: true } });
    if (!practicum) {
      console.error("Stream webhook: no practicum with a configured live input found for", providerKey);
      return;
    }

    const lastMedia = await prisma.mediaAsset.findFirst({ where: { practicumId: practicum.id, moduleId: null, scheduleEventId: null }, orderBy: { position: "desc" }, select: { position: true } });
    await prisma.mediaAsset.create({
      data: {
        practicumId: practicum.id,
        provider: CLOUDFLARE_STREAM_PROVIDER,
        providerKey,
        kind: MediaAssetKind.STREAM,
        status: MediaAssetStatus.DRAFT,
        title: null,
        position: (lastMedia?.position ?? -1) + 1,
      },
    });
  }

  private async assertCuratorPracticum(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
    if (!user || user.status !== UserStatus.ACTIVE || (user.role !== UserRole.CURATOR && user.role !== UserRole.OWNER)) {
      throw new AuthServiceError("FORBIDDEN", "Curator access required");
    }
    const practicum = await prisma.practicum.findFirst({ orderBy: { createdAt: "asc" } });
    if (!practicum) throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");
    return practicum;
  }
}

export const streamService = new StreamService();
