/**
 * HLS copies of a LiveKit recording — small segments in several qualities, like Vimeo serves —
 * made after the broadcast by the transcoder on the stream server (see transcoder/README.md).
 * One big MP4 fetched over a single long request stalled "every 3 seconds" for some students
 * whose connection to the stream server kept getting cut (2026-10-10); segments + auto quality
 * ride that out. Until the copies exist the player keeps using the MP4.
 *
 * Storage layout next to `recordings/<id>.mp4` in the same bucket:
 *   hls/<id>/manifest.json            — written last, so its presence means "complete"
 *   hls/<id>/<720p>/index.m3u8        — one VOD playlist per quality
 *   hls/<id>/<720p>/init.mp4, seg_00001.m4s, …
 *
 * Everything here is pure (no storage access) so it can be tested without MinIO.
 */

export const HLS_MANIFEST_FILE = "manifest.json";

export type HlsRendition = {
  name: string;
  width: number;
  height: number;
  /** Peak bits per second over a segment — what BANDWIDTH means in a master playlist. */
  bandwidth: number;
  averageBandwidth: number | null;
  codecs: string | null;
  frameRate: number | null;
};

export type HlsManifest = { version: 1; renditions: HlsRendition[] };

const RENDITION_NAME = /^\d{3,4}p$/;
const RECORDING_KEY = /^recordings\/([A-Za-z0-9_-]+)\.mp4$/;
/** Segment/init file names inside one rendition folder — never a path. */
const SEGMENT_FILE = /^[A-Za-z0-9_-]+\.(m4s|mp4|ts)$/;
const CODECS = /^[A-Za-z0-9.,]+$/;

/** `recordings/<id>.mp4` → `hls/<id>/`. */
export function recordingHlsPrefix(objectKey: string): string {
  const match = RECORDING_KEY.exec(objectKey);
  if (!match) throw new Error("Recording key is invalid");
  return `hls/${match[1]}/`;
}

export function isHlsRenditionName(value: string): boolean {
  return RENDITION_NAME.test(value);
}

export function hlsRenditionPlaylistKey(prefix: string, rendition: string): string {
  return `${prefix}${rendition}/index.m3u8`;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** Validates the transcoder's manifest.json; anything unexpected means "no HLS" (the MP4 still plays). */
export function parseHlsManifest(text: string): HlsManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { version, renditions } = raw as { version?: unknown; renditions?: unknown };
  if (version !== 1 || !Array.isArray(renditions) || renditions.length === 0) return null;
  const parsed: HlsRendition[] = [];
  for (const item of renditions) {
    if (!item || typeof item !== "object") return null;
    const entry = item as Record<string, unknown>;
    const width = positiveInt(entry.width);
    const height = positiveInt(entry.height);
    const bandwidth = positiveInt(entry.bandwidth);
    if (typeof entry.name !== "string" || !RENDITION_NAME.test(entry.name) || !width || !height || !bandwidth) return null;
    parsed.push({
      name: entry.name,
      width,
      height,
      bandwidth,
      averageBandwidth: positiveInt(entry.averageBandwidth),
      codecs: typeof entry.codecs === "string" && CODECS.test(entry.codecs) ? entry.codecs : null,
      frameRate: typeof entry.frameRate === "number" && entry.frameRate > 0 && entry.frameRate <= 240 ? entry.frameRate : null,
    });
  }
  if (new Set(parsed.map((rendition) => rendition.name)).size !== parsed.length) return null;
  return { version: 1, renditions: parsed };
}

/**
 * Master playlist. The first variant is where Safari's native player starts, so 720p (or the
 * closest below it) goes first — a fast start on any connection; it climbs from there. The rest
 * follow from the highest down.
 */
export function buildMasterPlaylist(manifest: HlsManifest, variantUri: (rendition: string) => string): string {
  const byHeight = [...manifest.renditions].sort((left, right) => right.height - left.height);
  const start = byHeight.find((rendition) => rendition.height <= 720) ?? byHeight[byHeight.length - 1];
  const ordered = [start, ...byHeight.filter((rendition) => rendition !== start)];
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
  for (const rendition of ordered) {
    const attributes = [`BANDWIDTH=${rendition.bandwidth}`];
    if (rendition.averageBandwidth) attributes.push(`AVERAGE-BANDWIDTH=${rendition.averageBandwidth}`);
    attributes.push(`RESOLUTION=${rendition.width}x${rendition.height}`);
    if (rendition.codecs) attributes.push(`CODECS="${rendition.codecs}"`);
    if (rendition.frameRate) attributes.push(`FRAME-RATE=${rendition.frameRate.toFixed(3)}`);
    lines.push(`#EXT-X-STREAM-INF:${attributes.join(",")}`, variantUri(rendition.name));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Turns a stored VOD playlist (relative segment names) into one the browser can fetch directly:
 * every segment and the init section get a signed storage URL. Only bare file names are
 * accepted — a playlist pointing anywhere else (`../`, another folder, an absolute URL) is
 * rejected rather than signed.
 */
export async function signMediaPlaylist(text: string, signFile: (file: string) => Promise<string>): Promise<string> {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "#EXTM3U") throw new Error("Playlist is invalid");
  const signed = await Promise.all(lines.map(async (line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#EXT-X-MAP:")) {
      const match = /URI="([^"]+)"/.exec(trimmed);
      if (!match || !SEGMENT_FILE.test(match[1])) throw new Error("Playlist init section is invalid");
      return trimmed.replace(match[0], `URI="${await signFile(match[1])}"`);
    }
    if (trimmed.startsWith("#EXT-X-KEY") || trimmed.startsWith("#EXT-X-PART") || trimmed.startsWith("#EXT-X-PRELOAD-HINT")) {
      throw new Error("Playlist uses unsupported features");
    }
    if (!trimmed || trimmed.startsWith("#")) return trimmed;
    if (!SEGMENT_FILE.test(trimmed)) throw new Error("Playlist segment is invalid");
    return signFile(trimmed);
  }));
  return `${signed.join("\n").replace(/\n+$/, "")}\n`;
}
