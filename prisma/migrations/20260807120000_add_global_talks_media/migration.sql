-- Add a practicum scope so media without a lesson remains private to its course.
ALTER TYPE "MediaAssetKind" ADD VALUE 'TALKS';

ALTER TABLE "MediaAsset" ADD COLUMN "practicumId" TEXT;

UPDATE "MediaAsset" AS media
SET "practicumId" = module."practicumId"
FROM "Lesson" AS lesson
JOIN "Module" AS module ON module."id" = lesson."moduleId"
WHERE media."lessonId" = lesson."id";

ALTER TABLE "MediaAsset" ALTER COLUMN "practicumId" SET NOT NULL;
ALTER TABLE "MediaAsset" ALTER COLUMN "lessonId" DROP NOT NULL;

ALTER TABLE "MediaAsset" DROP CONSTRAINT IF EXISTS "MediaAsset_lessonId_fkey";
ALTER TABLE "MediaAsset"
  ADD CONSTRAINT "MediaAsset_practicumId_fkey"
  FOREIGN KEY ("practicumId") REFERENCES "Practicum"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaAsset"
  ADD CONSTRAINT "MediaAsset_lessonId_fkey"
  FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "MediaAsset_practicumId_status_position_idx"
  ON "MediaAsset"("practicumId", "status", "position");
