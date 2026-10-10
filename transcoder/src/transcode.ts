import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Turns one recording MP4 into HLS copies (see app/server/streams/recording-hls.ts for how the
 * platform serves them): the original quality cut into segments without re-encoding, plus
 * lower qualities encoded with x264. No storage or LiveKit access here — worker.ts does that —
 * so this part can be run and tested on any machine with ffmpeg.
 */

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

/** LiveKit egress puts a keyframe exactly every 10 s, so the original can be cut on that grid as is. */
export const SEGMENT_SECONDS = 10;

/** Lower qualities, only those below the source's own height. Caps keep a busy screen from spiking. */
const ENCODED_LADDER = [
  { height: 1080, maxrateKbps: 2500 },
  { height: 720, maxrateKbps: 1200 },
  { height: 480, maxrateKbps: 600 },
];

export type ProbedStream = { codecName: string; profile: string | null; level: number | null; width: number | null; height: number | null; frameRate: number | null };
export type Probe = { durationSeconds: number; video: ProbedStream | null; audio: ProbedStream | null };
export type RenditionPlan = { name: string; width: number; height: number; copy: boolean; maxrateKbps: number };
export type ManifestRendition = { name: string; width: number; height: number; bandwidth: number; averageBandwidth: number; codecs: string | null; frameRate: number | null };
export type Manifest = { version: 1; durationSeconds: number; createdAt: string; renditions: ManifestRendition[] };

/** Lets the worker pause (SIGSTOP) and resume ffmpeg while a broadcast is live. */
export type ProcessControl = { onSpawn?: (child: ChildProcess | null) => void };

function run(command: string, args: string[], control?: ProcessControl): Promise<string> {
  // Low CPU priority on Linux, so the transcoder never competes with LiveKit for the processor.
  const [file, fileArgs] = process.platform === "win32" ? [command, args] : ["nice", ["-n", "15", command, ...args]];
  return new Promise((resolve, reject) => {
    const child = spawn(file, fileArgs, { stdio: ["ignore", "pipe", "pipe"] });
    control?.onSpawn?.(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on("error", (error) => { control?.onSpawn?.(null); reject(error); });
    child.on("close", (code, signal) => {
      control?.onSpawn?.(null);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(command)} exited with ${code ?? signal}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`));
    });
  });
}

function frameRate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const [numerator, denominator] = value.split("/").map(Number);
  return numerator > 0 && denominator > 0 ? Math.round((numerator / denominator) * 1000) / 1000 : null;
}

function positive(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : null;
}

export function parseProbe(json: { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> }): Probe {
  const pick = (type: string): ProbedStream | null => {
    const stream = json.streams?.find((item) => item.codec_type === type);
    if (!stream) return null;
    return {
      codecName: String(stream.codec_name ?? ""),
      profile: typeof stream.profile === "string" ? stream.profile : null,
      level: positive(stream.level),
      width: positive(stream.width),
      height: positive(stream.height),
      frameRate: frameRate(stream.avg_frame_rate),
    };
  };
  return { durationSeconds: positive(json.format?.duration) ?? 0, video: pick("video"), audio: pick("audio") };
}

export async function probe(file: string): Promise<Probe> {
  return parseProbe(JSON.parse(await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file])));
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

export function planRenditions(source: Probe): RenditionPlan[] {
  const video = source.video;
  if (!video?.width || !video.height) throw new Error("Recording has no video stream");
  // H.264 straight from egress is cut as is; anything else has to be re-encoded even at full size.
  const top: RenditionPlan = { name: `${video.height}p`, width: video.width, height: video.height, copy: video.codecName === "h264", maxrateKbps: 6000 };
  const lower = ENCODED_LADDER
    .filter((step) => step.height < video.height! - 8)
    .map((step) => ({ name: `${step.height}p`, width: even((video.width! * step.height) / video.height!), height: step.height, copy: false, maxrateKbps: step.maxrateKbps }));
  return [top, ...lower];
}

const AVC_PROFILES: Record<string, number> = { "Constrained Baseline": 0x42, Baseline: 0x42, Main: 0x4d, Extended: 0x58, High: 0x64 };
const hex = (value: number) => value.toString(16).padStart(2, "0");

/** RFC 6381 codec string for a master playlist, e.g. Main 5.0 → avc1.4d0032; null when unsure (players then probe). */
export function codecsString(video: ProbedStream | null, audio: ProbedStream | null): string | null {
  if (!video || video.codecName !== "h264" || !video.profile || !video.level || !(video.profile in AVC_PROFILES)) return null;
  const constraints = video.profile === "Constrained Baseline" ? 0xe0 : 0x00;
  const videoCodec = `avc1.${hex(AVC_PROFILES[video.profile])}${hex(constraints)}${hex(video.level)}`;
  if (!audio) return videoCodec;
  const audioObjectType = audio.codecName === "aac" ? ({ LC: 2, "HE-AAC": 5, "HE-AACv2": 29 } as Record<string, number>)[audio.profile ?? ""] : undefined;
  return audioObjectType ? `${videoCodec},mp4a.40.${audioObjectType}` : null;
}

/** Peak (per segment, ignoring a short tail) and average bits per second of one rendition. */
export function playlistBandwidth(playlist: string, sizeOf: (file: string) => number): { peak: number; average: number } {
  let duration: number | null = null;
  let totalBits = 0;
  let totalSeconds = 0;
  let peak = 0;
  for (const raw of playlist.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) { duration = Number.parseFloat(line.slice("#EXTINF:".length)); continue; }
    if (!line || line.startsWith("#") || duration === null) continue;
    const bits = sizeOf(line) * 8;
    totalBits += bits;
    totalSeconds += duration;
    if (duration >= 1) peak = Math.max(peak, bits / duration);
    duration = null;
  }
  if (totalSeconds <= 0) throw new Error("Playlist has no segments");
  const average = totalBits / totalSeconds;
  return { peak: Math.round(Math.max(peak, average)), average: Math.round(average) };
}

function hlsOutput(directory: string): string[] {
  // ffmpeg finds the folder for init.mp4 by the last "/" of the playlist path — with Windows "\\"
  // separators it silently wrote init.mp4 into the working directory instead.
  const folder = directory.split(path.sep).join("/");
  return [
    "-f", "hls", "-hls_time", String(SEGMENT_SECONDS), "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4",
    "-hls_flags", "independent_segments", "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", `${folder}/seg_%05d.m4s`, `${folder}/index.m3u8`,
  ];
}

function encodeOutput(plan: RenditionPlan, index: number, directory: string): string[] {
  return [
    "-map", `[o${index}]`, "-map", "0:a:0?",
    "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-crf", "23",
    "-maxrate", `${plan.maxrateKbps}k`, "-bufsize", `${plan.maxrateKbps * 2}k`,
    // Keyframe every 2 s and never elsewhere, so segment borders line up across qualities.
    "-force_key_frames", "expr:gte(t,n_forced*2)", "-sc_threshold", "0",
    "-c:a", "copy",
    ...hlsOutput(directory),
  ];
}

export async function transcodeRecording(source: string, outputDirectory: string, control?: ProcessControl): Promise<Manifest> {
  const sourceProbe = await probe(source);
  const plans = planRenditions(sourceProbe);
  for (const plan of plans) await mkdir(path.join(outputDirectory, plan.name), { recursive: true });
  const common = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", source];

  const copied = plans.filter((plan) => plan.copy);
  for (const plan of copied) {
    await run(FFMPEG, [...common, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", ...hlsOutput(path.join(outputDirectory, plan.name))], control);
  }
  // All encoded qualities in one pass: the 1440p source is decoded once and scaled three ways.
  const encoded = plans.filter((plan) => !plan.copy);
  if (encoded.length > 0) {
    const filter = `[0:v]split=${encoded.length}${encoded.map((_, index) => `[s${index}]`).join("")};`
      + encoded.map((plan, index) => `[s${index}]scale=${plan.width}:${plan.height}:flags=lanczos,format=yuv420p[o${index}]`).join(";");
    // -copyts keeps the source's timestamps (egress video starts ~0.19 s in, with B-frames); without
    // it x264 restarts near 0 and every quality switch hit a ~0.12 s overlap against the copied 1440p.
    await run(FFMPEG, ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-copyts", "-i", source, "-filter_complex", filter, ...encoded.flatMap((plan, index) => encodeOutput(plan, index, path.join(outputDirectory, plan.name)))], control);
  }

  const renditions: ManifestRendition[] = [];
  for (const plan of plans) {
    const directory = path.join(outputDirectory, plan.name);
    const playlist = await readFile(path.join(directory, "index.m3u8"), "utf-8");
    const sizes = new Map<string, number>();
    for (const file of await readdir(directory)) sizes.set(file, (await stat(path.join(directory, file))).size);
    const { peak, average } = playlistBandwidth(playlist, (file) => {
      const size = sizes.get(file);
      if (size === undefined) throw new Error(`Segment ${file} is missing in ${plan.name}`);
      return size;
    });
    const output = await probe(path.join(directory, "index.m3u8"));
    renditions.push({
      name: plan.name,
      width: output.video?.width ?? plan.width,
      height: output.video?.height ?? plan.height,
      bandwidth: peak,
      averageBandwidth: average,
      // Audio is copied from the source in every quality, and ffprobe can't read its AAC profile
      // back through a playlist ("unknown") — take it from the source file.
      codecs: codecsString(output.video, output.audio ? sourceProbe.audio : null),
      frameRate: output.video?.frameRate ?? sourceProbe.video?.frameRate ?? null,
    });
  }
  return { version: 1, durationSeconds: sourceProbe.durationSeconds, createdAt: new Date().toISOString(), renditions };
}
