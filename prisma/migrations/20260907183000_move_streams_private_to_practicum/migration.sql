-- Moves the "private stream" switch from the global PlatformSettings singleton to a per-Practicum
-- column: it must reset to off for a brand-new cohort instead of silently carrying over from
-- whichever practicum it was last toggled on for. Off by default, so no existing broadcast
-- behavior changes for any current practicum.
ALTER TABLE "Practicum" ADD COLUMN "streamsPrivate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PlatformSettings" DROP COLUMN "streamsPrivate";
