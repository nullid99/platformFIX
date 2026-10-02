-- Global "private stream" switch (see PlatformSettings.streamsPrivate for why it's global, not
-- per-practicum). Off by default so no existing broadcast behavior changes on deploy.
ALTER TABLE "PlatformSettings" ADD COLUMN "streamsPrivate" BOOLEAN NOT NULL DEFAULT false;
