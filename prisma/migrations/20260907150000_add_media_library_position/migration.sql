-- Curator's manual drag order for the practicum-wide "Медиатека" overview, separate from the
-- per-module/per-scope `position` column so reordering one list never disturbs the other.
ALTER TABLE "MediaAsset" ADD COLUMN "libraryPosition" INTEGER NOT NULL DEFAULT 0;
