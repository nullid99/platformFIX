-- Recording file size in bytes, read off the LiveKit egress webhook's own FileInfo. BigInt
-- because a single 1440p recording clears the 2GB Int limit well within an hour.
ALTER TABLE "MediaAsset" ADD COLUMN "byteSize" BIGINT;
