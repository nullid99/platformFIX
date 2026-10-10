#!/usr/bin/env python3
"""Builds the transcoder's env file from egress.yaml — same MinIO bucket and LiveKit keys egress uses.

Run on the stream server: python3 make-env.py /opt/livekit/egress.yaml /opt/livekit/transcoder.env
The file is created readable by root only, and no secret value is ever printed.
"""
import os
import re
import sys

source = sys.argv[1] if len(sys.argv) > 1 else "/opt/livekit/egress.yaml"
target = sys.argv[2] if len(sys.argv) > 2 else "/opt/livekit/transcoder.env"

top, s3, section = {}, {}, None
with open(source, encoding="utf-8") as handle:
    for line in handle:
        match = re.match(r"^(\s*)([A-Za-z0-9_]+):\s*(.*?)\s*$", line.rstrip("\n"))
        if not match or line.lstrip().startswith("#"):
            continue
        indent, key, value = match.groups()
        value = value.strip("\"'")
        if not indent:
            section = None if value else key
            if value:
                top[key] = value
        elif section == "s3":
            s3[key] = value

env = {
    "S3_ENDPOINT": s3.get("endpoint", ""),
    "S3_BUCKET": s3.get("bucket", ""),
    "S3_ACCESS_KEY": s3.get("access_key", ""),
    "S3_SECRET_KEY": s3.get("secret", ""),
    # The LiveKit server API is plain HTTP on the same port egress reaches over WebSocket.
    "LIVEKIT_URL": re.sub(r"^ws", "http", top.get("ws_url", "")),
    "LIVEKIT_API_KEY": top.get("api_key", ""),
    "LIVEKIT_API_SECRET": top.get("api_secret", ""),
    "WORK_DIR": "/work",
}
missing = [name for name, value in env.items() if not value]
if missing:
    sys.exit(f"egress.yaml is missing: {', '.join(missing)}")

descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
    handle.write("".join(f"{name}={value}\n" for name, value in env.items()))
os.chmod(target, 0o600)
print(f"{target} written: storage {env['S3_ENDPOINT']} bucket {env['S3_BUCKET']}, LiveKit {env['LIVEKIT_URL']}")
