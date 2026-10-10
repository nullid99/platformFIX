import type { ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, statfs } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { IngressState_Status } from "@livekit/protocol";
import { IngressClient } from "livekit-server-sdk";
import { transcodeRecording } from "./transcode.ts";

/**
 * Runs next to MinIO on the stream server: finds recordings without HLS copies (newest first),
 * makes them (transcode.ts) and uploads them next to the MP4 — `hls/<id>/…`, manifest.json last.
 * Never competes with a broadcast: no new job while OBS is connected, and a running ffmpeg is
 * paused (SIGSTOP) as soon as one starts.
 *   node src/worker.ts                              — keep going through all recordings, newest first
 *   node src/worker.ts --first recordings/<id>.mp4 … — those recordings first, then as above
 *   node src/worker.ts --once recordings/<id>.mp4    — just this one, then exit (first check after installing)
 */

const RECORDING_KEY = /^recordings\/([A-Za-z0-9_-]+)\.mp4$/;
const IDLE_POLL_MS = 5 * 60_000;
const LIVE_POLL_MS = 60_000;
const LIVE_CHECK_MS = 20_000;
/** A recording this fresh may still be uploading from egress. */
const SETTLE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const config = {
  s3Endpoint: required("S3_ENDPOINT"),
  bucket: required("S3_BUCKET"),
  accessKey: required("S3_ACCESS_KEY"),
  secretKey: required("S3_SECRET_KEY"),
  livekitUrl: required("LIVEKIT_URL"),
  livekitKey: required("LIVEKIT_API_KEY"),
  livekitSecret: required("LIVEKIT_API_SECRET"),
  workDir: process.env.WORK_DIR?.trim() || "/work",
};

const s3 = new S3Client({ endpoint: config.s3Endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey } });
const ingressClient = new IngressClient(config.livekitUrl, config.livekitKey, config.livekitSecret);

type Job = { key: string; id: string; size: number; attempts: number };
type FailureRecord = { attempts: number; retryAfter: string; error: string };

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isNotFound(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 404 || (error instanceof Error && (error.name === "NotFound" || error.name === "NoSuchKey"));
}

/** OBS connected to the ingress = a broadcast is on. If LiveKit can't be asked, assume it is. */
async function isLive(): Promise<boolean> {
  try {
    const ingresses = await ingressClient.listIngress({});
    return ingresses.some((item) => item.state?.status === IngressState_Status.ENDPOINT_BUFFERING || item.state?.status === IngressState_Status.ENDPOINT_PUBLISHING);
  } catch (error: unknown) {
    log("live_check_failed", { error: errorText(error) });
    return true;
  }
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    return true;
  } catch (error: unknown) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function readFailure(id: string): Promise<FailureRecord | null> {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: `hls/${id}/failed.json` }));
    return JSON.parse((await object.Body?.transformToString("utf-8")) ?? "null") as FailureRecord | null;
  } catch (error: unknown) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Ids already done — saves a HEAD request per recording on every poll. */
const finished = new Set<string>();

async function nextJob(): Promise<Job | null> {
  const candidates: Array<Job & { modified: number }> = [];
  let continuationToken: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: "recordings/", ContinuationToken: continuationToken }));
    for (const item of page.Contents ?? []) {
      const match = item.Key ? RECORDING_KEY.exec(item.Key) : null;
      const modified = item.LastModified?.getTime() ?? Date.now();
      if (match && Date.now() - modified > SETTLE_MS) candidates.push({ key: item.Key!, id: match[1], size: item.Size ?? 0, attempts: 0, modified });
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  candidates.sort((left, right) => right.modified - left.modified);
  for (const candidate of candidates) {
    if (finished.has(candidate.id)) continue;
    if (await objectExists(`hls/${candidate.id}/manifest.json`)) { finished.add(candidate.id); continue; }
    const failure = await readFailure(candidate.id);
    if (failure && (failure.attempts >= MAX_ATTEMPTS || Date.parse(failure.retryAfter) > Date.now())) continue;
    return { ...candidate, attempts: failure?.attempts ?? 0 };
  }
  return null;
}

const CONTENT_TYPES: Record<string, string> = { ".m3u8": "application/vnd.apple.mpegurl", ".m4s": "video/iso.segment", ".mp4": "video/mp4" };

async function uploadDirectory(directory: string, prefix: string): Promise<void> {
  const files: Array<{ local: string; key: string }> = [];
  for (const rendition of await readdir(directory)) {
    for (const file of await readdir(path.join(directory, rendition))) files.push({ local: path.join(directory, rendition, file), key: `${prefix}${rendition}/${file}` });
  }
  let next = 0;
  const uploadOne = async (): Promise<void> => {
    while (next < files.length) {
      const file = files[next++];
      await s3.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: file.key,
        Body: await readFile(file.local),
        ContentType: CONTENT_TYPES[path.extname(file.local)] ?? "application/octet-stream",
        CacheControl: "private, max-age=86400",
      }));
    }
  };
  await Promise.all(Array.from({ length: 6 }, uploadOne));
}

// The ffmpeg currently running, so a broadcast can pause it.
let currentProcess: ChildProcess | null = null;
let pausedForLive = false;

async function watchBroadcasts(): Promise<void> {
  const live = await isLive();
  if (live && !pausedForLive && currentProcess) {
    currentProcess.kill("SIGSTOP");
    pausedForLive = true;
    log("paused_for_broadcast");
  } else if (!live && pausedForLive) {
    currentProcess?.kill("SIGCONT");
    pausedForLive = false;
    log("resumed_after_broadcast");
  }
}

async function processRecording(job: Job): Promise<void> {
  const started = Date.now();
  const directory = path.join(config.workDir, job.id);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  try {
    const disk = await statfs(config.workDir);
    // Source + four qualities fit in ~2.5× the source; keep a margin for the host.
    if (disk.bavail * disk.bsize < job.size * 4 + 2_000_000_000) throw new Error("Not enough free disk space");
    log("download_start", { key: job.key, megabytes: Math.round(job.size / 1_048_576) });
    const source = path.join(directory, "source.mp4");
    const object = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: job.key }));
    await pipeline(object.Body as Readable, createWriteStream(source));
    log("transcode_start", { key: job.key });
    const manifest = await transcodeRecording(source, path.join(directory, "out"), {
      onSpawn: (child) => {
        currentProcess = child;
        if (child && pausedForLive) child.kill("SIGSTOP");
      },
    });
    log("upload_start", { key: job.key });
    const prefix = `hls/${job.id}/`;
    await uploadDirectory(path.join(directory, "out"), prefix);
    // Written last: its presence is what tells the platform the copies are complete.
    await s3.send(new PutObjectCommand({ Bucket: config.bucket, Key: `${prefix}manifest.json`, Body: JSON.stringify(manifest), ContentType: "application/json" }));
    await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: `${prefix}failed.json` }));
    finished.add(job.id);
    log("done", { key: job.key, renditions: manifest.renditions.map((rendition) => rendition.name), minutes: Math.round((Date.now() - started) / 60_000) });
  } finally {
    currentProcess = null;
    await rm(directory, { recursive: true, force: true });
  }
}

async function recordFailure(job: Job, error: unknown): Promise<void> {
  const attempts = job.attempts + 1;
  const record: FailureRecord = { attempts, retryAfter: new Date(Date.now() + attempts * 30 * 60_000).toISOString(), error: errorText(error).slice(0, 500) };
  log("failed", { key: job.key, attempts, error: record.error });
  try {
    await s3.send(new PutObjectCommand({ Bucket: config.bucket, Key: `hls/${job.id}/failed.json`, Body: JSON.stringify(record), ContentType: "application/json" }));
  } catch (writeError: unknown) {
    log("failure_record_failed", { key: job.key, error: errorText(writeError) });
  }
}

async function main(): Promise<void> {
  const broadcastWatch = setInterval(() => { void watchBroadcasts(); }, LIVE_CHECK_MS);
  process.on("SIGTERM", () => {
    // docker stop: don't leave a stopped ffmpeg behind.
    currentProcess?.kill("SIGCONT");
    currentProcess?.kill("SIGKILL");
    process.exit(0);
  });

  const [mode, ...keys] = process.argv.slice(2);
  const jobs = keys.map((key) => {
    const match = RECORDING_KEY.exec(key);
    if (!match) throw new Error(`Not a recording key: ${key} (expected recordings/<id>.mp4)`);
    return { key, id: match[1] };
  });

  if (mode === "--once") {
    if (jobs.length !== 1) throw new Error("Usage: node src/worker.ts --once recordings/<id>.mp4");
    if (await isLive()) throw new Error("A broadcast is live — try again after it ends");
    const head = await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: jobs[0].key }));
    await processRecording({ ...jobs[0], size: head.ContentLength ?? 0, attempts: 0 });
    clearInterval(broadcastWatch);
    return;
  }

  log("started", { workDir: config.workDir, first: jobs.map((job) => job.key) });
  // --first: recordings students are waiting for go before the rest (skipped once already done).
  for (const priority of mode === "--first" ? jobs : []) {
    while (await isLive()) await sleep(LIVE_POLL_MS);
    if (await objectExists(`hls/${priority.id}/manifest.json`)) { finished.add(priority.id); continue; }
    const head = await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: priority.key }));
    const job = { ...priority, size: head.ContentLength ?? 0, attempts: (await readFailure(priority.id))?.attempts ?? 0 };
    try {
      await processRecording(job);
    } catch (error: unknown) {
      await recordFailure(job, error);
    }
  }
  for (;;) {
    try {
      if (await isLive()) { await sleep(LIVE_POLL_MS); continue; }
      const job = await nextJob();
      if (!job) { await sleep(IDLE_POLL_MS); continue; }
      try {
        await processRecording(job);
      } catch (error: unknown) {
        await recordFailure(job, error);
      }
    } catch (error: unknown) {
      log("loop_error", { error: errorText(error) });
      await sleep(LIVE_POLL_MS);
    }
  }
}

main().catch((error: unknown) => {
  log("fatal", { error: errorText(error) });
  process.exit(1);
});
