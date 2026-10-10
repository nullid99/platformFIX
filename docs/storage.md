# File Storage

## Current Local Adapter

Development files are stored under `FILE_STORAGE_ROOT`, defaulting to `.storage/private`. The directory is outside `public` and is never served by Next.js. The API checks the session and ownership before returning a stream.

The upload flow is:

```text
POST /api/files
PUT  /api/files/:fileId/content
POST /api/assignments/:assignmentId/submissions { fileIds: [...] }
GET  /api/files/:fileId/content
```

The file is attached to a submission only after the upload is complete and the student owns the file. A curator can read it only when the student is assigned to that curator; the owner can read it for administration.

## Production Choice

For Hetzner, use Hetzner Object Storage or another S3-compatible private bucket. The application should keep the same `FileService` interface and replace only the storage adapter. The bucket must have public access disabled, versioning or lifecycle rules enabled, and server-side encryption enabled where available.

The production upload should use short-lived presigned URLs. The API must create the object key and validate the metadata before issuing a URL. The browser must never receive bucket credentials. Downloads should use a short-lived signed URL or an API stream after the same authorization check.

## Required Hardening Before Production

- antivirus or malware scanning before a file becomes `UPLOADED`;
- content sniffing and extension validation, not only the client MIME type;
- upload and download rate limits;
- lifecycle cleanup for abandoned `PENDING` files;
- backups and retention policy;
- audit events for upload, preview and download;
- private Vimeo settings for externally hosted video.

## Stream Recordings (LiveKit) and HLS Copies

Broadcast recordings live in a separate MinIO bucket on the stream server (`recordings/<id>.mp4`,
written by LiveKit egress) and are played through short-lived signed URLs minted by the API after
the usual access check (`GET /api/streams/recordings/:id/play`). The transcoder on the stream
server adds HLS copies in several qualities under `hls/<id>/`; when they exist the player uses
them (`/api/streams/recordings/:id/hls/master.m3u8`, every segment signed the same way) and falls
back to the MP4 otherwise. Layout, installation and operation: `transcoder/README.md`.
