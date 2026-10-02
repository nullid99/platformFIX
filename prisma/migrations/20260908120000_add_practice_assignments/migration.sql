-- Практическое задание: an assignment that targets a whole practicum (no lesson, no deadline,
-- no requirements) instead of a module. moduleId becomes optional; practicumId is the new
-- always-set targeting column, backfilled from the existing module's practicum for every
-- pre-existing (regular) assignment so nothing already in the table is left without one.
ALTER TABLE "Assignment" ALTER COLUMN "moduleId" DROP NOT NULL;
ALTER TABLE "Assignment" ADD COLUMN "practicumId" TEXT;
ALTER TABLE "Assignment" ADD COLUMN "isPractice" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Assignment" a
SET "practicumId" = m."practicumId"
FROM "Module" m
WHERE a."moduleId" = m.id;

ALTER TABLE "Assignment" ALTER COLUMN "practicumId" SET NOT NULL;

ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_practicumId_fkey" FOREIGN KEY ("practicumId") REFERENCES "Practicum"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Assignment_practicumId_isPractice_status_idx" ON "Assignment"("practicumId", "isPractice", "status");
