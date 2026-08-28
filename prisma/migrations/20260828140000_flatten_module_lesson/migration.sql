-- Collapse the Module -> Lesson -> {MediaAsset, Assignment} hierarchy into
-- Module -> {MediaAsset, Assignment} directly. Every Lesson row's parent
-- moduleId is well-defined, so every FK that pointed at a Lesson is simply
-- repointed at that lesson's module — no data loss.

-- 1. Add the new nullable moduleId columns.
ALTER TABLE "Assignment" ADD COLUMN "moduleId" TEXT;
ALTER TABLE "MediaAsset" ADD COLUMN "moduleId" TEXT;

-- 2. Backfill from the (still present) Lesson table.
UPDATE "Assignment" a
SET "moduleId" = l."moduleId"
FROM "Lesson" l
WHERE a."lessonId" = l."id";

UPDATE "MediaAsset" m
SET "moduleId" = l."moduleId"
FROM "Lesson" l
WHERE m."lessonId" = l."id";

UPDATE "DiscussionThread" dt
SET "moduleId" = l."moduleId"
FROM "Lesson" l
WHERE dt."lessonId" = l."id"
  AND dt."moduleId" IS NULL;

-- 3. Assignment.moduleId is required.
ALTER TABLE "Assignment" ALTER COLUMN "moduleId" SET NOT NULL;

-- 4. Repoint Assignment's FK/index from Lesson to Module.
ALTER TABLE "Assignment" DROP CONSTRAINT "Assignment_lessonId_fkey";
DROP INDEX "Assignment_lessonId_status_idx";
ALTER TABLE "Assignment" DROP COLUMN "lessonId";
CREATE INDEX "Assignment_moduleId_status_idx" ON "Assignment"("moduleId", "status");
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. Repoint MediaAsset's FK/index/unique from Lesson to Module.
ALTER TABLE "MediaAsset" DROP CONSTRAINT "MediaAsset_lessonId_fkey";
DROP INDEX "MediaAsset_lessonId_status_position_idx";
DROP INDEX "MediaAsset_provider_providerKey_lessonId_key";
ALTER TABLE "MediaAsset" DROP COLUMN "lessonId";
CREATE INDEX "MediaAsset_moduleId_status_position_idx" ON "MediaAsset"("moduleId", "status", "position");
CREATE UNIQUE INDEX "MediaAsset_provider_providerKey_moduleId_key" ON "MediaAsset"("provider", "providerKey", "moduleId");
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 6. Drop DiscussionThread's lessonId (moduleId already existed and is now backfilled).
ALTER TABLE "DiscussionThread" DROP CONSTRAINT "DiscussionThread_lessonId_fkey";
DROP INDEX "DiscussionThread_lessonId_createdAt_idx";
ALTER TABLE "DiscussionThread" DROP COLUMN "lessonId";

-- 7. Drop the now-unreferenced Lesson table and its type enum.
DROP TABLE "Lesson";
DROP TYPE "LessonType";
