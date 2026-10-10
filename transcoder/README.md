# Recording transcoder (HLS)

Makes Vimeo-like copies of every LiveKit recording: the original quality cut into ~10 s segments
without re-encoding, plus 1080p/720p/480p encoded with x264, all as fMP4 HLS. The platform's player
then picks the quality per viewer and loads small segments instead of one long MP4 request — the
fix for students whose recordings stalled "every 3 seconds" (2026-10).

Runs on the **stream server** (157.90.244.128) next to MinIO, as the `livekit-transcoder` container.
It never competes with a broadcast: no new job while OBS is connected to the ingress, and a running
ffmpeg is paused (SIGSTOP) the moment a broadcast starts. Limited to 2 CPUs, low priority.

## Storage layout

Next to `recordings/<id>.mp4` in the same bucket:

```text
hls/<id>/manifest.json          written last — its presence means "complete"
hls/<id>/<1440p|1080p|…>/index.m3u8, init.mp4, seg_00000.m4s, …
hls/<id>/failed.json            only after a failed attempt (retried up to 3 times)
```

The platform reads `manifest.json` and serves the playlists with signed segment URLs
(`app/server/streams/recording-hls.ts`, `GET /api/streams/recordings/:id/hls/master.m3u8`). Until
the copies exist — or if HLS fails in the browser — the player keeps using the MP4. Deleting a
recording on the platform deletes its `hls/<id>/` folder too.

## Install / update (on the stream server, as root)

```sh
# 1. sources from the repo → /opt/livekit/transcoder, image fix-transcoder
python3 /opt/livekit/transcoder/make-env.py /opt/livekit/egress.yaml /opt/livekit/transcoder.env   # once; never prints secrets
mkdir -p /opt/livekit/transcoder-work && chown 1000:1000 /opt/livekit/transcoder-work
docker build -t fix-transcoder /opt/livekit/transcoder

# 2. one recording as a check, then exit
docker run --rm --network host --cpus 2 --memory 3g --env-file /opt/livekit/transcoder.env \
  -v /opt/livekit/transcoder-work:/work fix-transcoder node src/worker.ts --once recordings/<id>.mp4

# 3. the service (optionally `--first recordings/<id>.mp4 …` to do those before the rest)
docker run -d --name livekit-transcoder --restart unless-stopped --network host --cpus 2 --memory 3g \
  --log-opt max-size=10m --log-opt max-file=3 --env-file /opt/livekit/transcoder.env \
  -v /opt/livekit/transcoder-work:/work fix-transcoder
```

To update: copy new sources, `docker build`, then `docker rm -f livekit-transcoder` and step 3 again.

## Operating

- Logs (one JSON line per event — `download_start`, `transcode_start`, `paused_for_broadcast`,
  `done`, `failed`): `docker logs --tail 50 livekit-transcoder`
- Stop: `docker rm -f livekit-transcoder` — players fall back to the MP4 only for recordings
  without copies; existing copies keep working.
- Redo one recording: delete `hls/<id>/manifest.json` (and `failed.json`) in the bucket.
- Disk: ~1.1 GB of copies per 1.5 h broadcast on top of the 0.8 GB original; the job needs ~2.5×
  the source size free in `/opt/livekit/transcoder-work` while it runs.
- Speed: ~1× real time on 2 cores — copies are ready roughly as long after a broadcast as it lasted.

## Local check (any machine with ffmpeg)

`transcode.ts` has no storage or LiveKit access, so it can be run on a downloaded clip:
`FFMPEG_PATH=… FFPROBE_PATH=… node -e "…transcodeRecording('source.mp4', 'out')…"`.
Unit tests: `npx vitest run transcoder`; types: `npx tsc -p transcoder/tsconfig.json`.
