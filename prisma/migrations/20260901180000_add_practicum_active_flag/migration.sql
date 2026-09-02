ALTER TABLE "Practicum" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: the earliest-created practicum keeps being "the" one every curator-side resolver
-- picked before this migration (orderBy createdAt asc), so existing behavior doesn't change
-- until an owner explicitly starts a new practicum.
UPDATE "Practicum"
SET "isActive" = true
WHERE id = (SELECT id FROM "Practicum" ORDER BY "createdAt" ASC LIMIT 1);

-- At most one active practicum at a time, enforced at the DB level.
CREATE UNIQUE INDEX "Practicum_isActive_unique" ON "Practicum" ("isActive") WHERE "isActive" = true;
