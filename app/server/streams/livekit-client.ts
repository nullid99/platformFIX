import { randomUUID } from "crypto";
import { AccessToken, EgressClient, IngressClient, RoomServiceClient, WebhookReceiver } from "livekit-server-sdk";
import { EgressStatus, EncodedFileOutput, EncodedFileType, EncodingOptions, ImageCodec, ImageFileSuffix, ImageOutput, IngressInput, IngressVideoEncodingOptions, IngressVideoOptions, S3Upload, TrackType, VideoLayer, VideoQuality } from "@livekit/protocol";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AuthServiceError } from "@/app/server/auth";

export { EgressStatus, IngressInput, TrackType };

/** Single practicum per install (see StreamService.assertCuratorPracticum) — one fixed room for the whole app. */
export const LIVEKIT_ROOM_NAME = process.env.LIVEKIT_ROOM_NAME?.trim() || "practicum-live";

/**
 * Without an explicit `video` option, LiveKit Ingress falls back to its own built-in default
 * (720p main layer) regardless of the resolution OBS actually sends — silently downscaling any
 * higher-quality source. The built-in presets top out at 1080p (which curators found
 * insufficient on high-DPI monitors), so a QHD/1440p main layer requires custom encoding
 * options rather than a preset.
 */
export const LIVEKIT_INGRESS_VIDEO_OPTIONS = new IngressVideoOptions({
  encodingOptions: {
    case: "options",
    value: new IngressVideoEncodingOptions({
      frameRate: 30,
      layers: [
        new VideoLayer({ quality: VideoQuality.HIGH, width: 2560, height: 1440, bitrate: 6_000_000 }),
        new VideoLayer({ quality: VideoQuality.MEDIUM, width: 1280, height: 720, bitrate: 2_500_000 }),
        new VideoLayer({ quality: VideoQuality.LOW, width: 640, height: 360, bitrate: 1_000_000 }),
      ],
    }),
  },
});

/** Fixed participant identity assigned to the RTMP-publishing "participant" (OBS via Ingress) inside the room. */
export const LIVEKIT_INGRESS_PARTICIPANT_IDENTITY = "obs-ingest";

function credentials(): { host: string; apiKey: string; apiSecret: string } {
  const host = process.env.LIVEKIT_HOST?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!host || !apiKey || !apiSecret) throw new AuthServiceError("INVALID_INPUT", "LiveKit is not configured");
  return { host, apiKey, apiSecret };
}

export function ingressClient(): IngressClient {
  const { host, apiKey, apiSecret } = credentials();
  return new IngressClient(host, apiKey, apiSecret);
}

export function roomServiceClient(): RoomServiceClient {
  const { host, apiKey, apiSecret } = credentials();
  return new RoomServiceClient(host, apiKey, apiSecret);
}

export function webhookReceiver(): WebhookReceiver {
  const { apiKey, apiSecret } = credentials();
  return new WebhookReceiver(apiKey, apiSecret);
}

/** Viewer/curator-preview join token — subscribe-only, never allows publishing. */
export async function mintViewerToken(identity: string): Promise<string> {
  const { apiKey, apiSecret } = credentials();
  const token = new AccessToken(apiKey, apiSecret, { identity, ttl: "6h" });
  token.addGrant({ roomJoin: true, room: LIVEKIT_ROOM_NAME, canSubscribe: true, canPublish: false });
  return token.toJwt();
}

export function egressClient(): EgressClient {
  const { host, apiKey, apiSecret } = credentials();
  return new EgressClient(host, apiKey, apiSecret);
}

/**
 * Without explicit encoding options, LiveKit Egress falls back to its own default (720p,
 * 3000kbps) regardless of the source track's actual resolution — the same silent-downscale trap
 * LIVEKIT_INGRESS_VIDEO_OPTIONS above already works around for the live ingest side. Matches the
 * live HIGH simulcast layer (2560x1440) so a recording isn't visibly worse than watching it live.
 * Note: EncodingOptions.videoBitrate/audioBitrate are in kbps, unlike the ingress side's bps.
 */
export const RECORDING_ENCODING_OPTIONS = new EncodingOptions({ width: 2560, height: 1440, framerate: 30, videoBitrate: 6_000, audioBitrate: 128 });

/**
 * MinIO runs on the same box as the LiveKit Egress process, so egress writes over a loopback
 * address (`internalEndpoint`) — that address is meaningless to a viewer's browser, which instead
 * needs the public HTTPS domain (`publicUrl`, fronted by Caddy) to fetch a presigned URL.
 */
function recordingS3Config(): { internalEndpoint: string; publicUrl: string; bucket: string; accessKey: string; secretKey: string } {
  const internalEndpoint = process.env.LIVEKIT_RECORDING_S3_ENDPOINT?.trim();
  const publicUrl = process.env.LIVEKIT_RECORDING_S3_PUBLIC_URL?.trim();
  const bucket = process.env.LIVEKIT_RECORDING_S3_BUCKET?.trim();
  const accessKey = process.env.LIVEKIT_RECORDING_S3_ACCESS_KEY?.trim();
  const secretKey = process.env.LIVEKIT_RECORDING_S3_SECRET_KEY?.trim();
  if (!internalEndpoint || !publicUrl || !bucket || !accessKey || !secretKey) throw new AuthServiceError("INVALID_INPUT", "Recording storage is not configured");
  return { internalEndpoint, publicUrl, bucket, accessKey, secretKey };
}

/** Random rather than time-derived so a segment restarted after an egress crash never collides with the one it's replacing. */
export function newRecordingObjectKey(): string {
  return `recordings/${randomUUID()}.mp4`;
}

export function recordingFileOutput(objectKey: string): EncodedFileOutput {
  const { internalEndpoint, bucket, accessKey, secretKey } = recordingS3Config();
  return new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath: objectKey,
    output: {
      case: "s3",
      value: new S3Upload({ accessKey, secret: secretKey, region: "us-east-1", endpoint: internalEndpoint, bucket, forcePathStyle: true }),
    },
  });
}

/** The thumbnail lives alongside its recording under the same random id — no separate DB column needed, mediaThumbnailUrl (course-service.ts) just swaps the extension on providerKey. */
export function recordingThumbnailObjectKey(videoObjectKey: string): string {
  return videoObjectKey.replace(/\.mp4$/, ".jpg");
}

/**
 * A single representative frame, captured once near the start of the recording. LiveKit has no
 * "just one snapshot" mode — captureInterval is required — so this sets it far longer than any
 * real broadcast (24h) and takes only the first capture; IMAGE_SUFFIX_NONE_OVERWRITE means the
 * uploaded object is named exactly `objectKey`, not `objectKey` plus an index/timestamp suffix.
 */
export function recordingImageOutput(objectKey: string): ImageOutput {
  const { internalEndpoint, bucket, accessKey, secretKey } = recordingS3Config();
  return new ImageOutput({
    captureInterval: 86_400,
    filenamePrefix: objectKey,
    filenameSuffix: ImageFileSuffix.IMAGE_SUFFIX_NONE_OVERWRITE,
    imageCodec: ImageCodec.IC_JPEG,
    output: {
      case: "s3",
      value: new S3Upload({ accessKey, secret: secretKey, region: "us-east-1", endpoint: internalEndpoint, bucket, forcePathStyle: true }),
    },
  });
}

function recordingS3Client(): { client: S3Client; bucket: string } {
  const { publicUrl, bucket, accessKey, secretKey } = recordingS3Config();
  return { client: new S3Client({ endpoint: publicUrl, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: accessKey, secretAccessKey: secretKey } }), bucket };
}

/** Short-lived signed GET URL a viewer's browser can fetch/scrub directly — bypasses our API for the actual bytes, and Range requests work natively (nothing in this app's own file-serving route supports them). */
export async function mintRecordingPlaybackUrl(objectKey: string): Promise<string> {
  const { client, bucket } = recordingS3Client();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: objectKey }), { expiresIn: 6 * 60 * 60 });
}

/**
 * Same signed URL as mintRecordingPlaybackUrl, but with a Content-Disposition telling the browser
 * to save the file instead of playing it inline — used only by the curator's "download the raw
 * file to trim it and re-upload to Vimeo" workflow (see stream-service.ts getRecordingDownloadUrl).
 * Never exposed to students; the ordinary player route never sets this.
 */
export async function mintRecordingDownloadUrl(objectKey: string, filename: string): Promise<string> {
  const { client, bucket } = recordingS3Client();
  const safeName = filename.replace(/["\r\n]/g, "");
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: objectKey, ResponseContentDisposition: `attachment; filename="${safeName}"` }), { expiresIn: 6 * 60 * 60 });
}
