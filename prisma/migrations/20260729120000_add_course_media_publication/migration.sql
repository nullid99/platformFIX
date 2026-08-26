-- CreateEnum
CREATE TYPE "MediaAssetKind" AS ENUM ('LESSON_VIDEO', 'STREAM', 'QA', 'BREAKDOWN');

-- CreateEnum
CREATE TYPE "MediaAssetStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "MediaAsset"
  ADD COLUMN "kind" "MediaAssetKind" NOT NULL DEFAULT 'STREAM',
  ADD COLUMN "status" "MediaAssetStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "description" TEXT,
  ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "publishedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Existing media was already visible to students before this migration.
UPDATE "MediaAsset"
SET "status" = 'PUBLISHED', "publishedAt" = "createdAt";

-- Replace the less selective lookup index.
DROP INDEX "MediaAsset_lessonId_idx";
CREATE INDEX "MediaAsset_lessonId_status_position_idx" ON "MediaAsset"("lessonId", "status", "position");
