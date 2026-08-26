-- AlterTable
ALTER TABLE "EnrollmentModuleAccess" ADD COLUMN     "isOverride" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Module" ADD COLUMN     "defaultAccess" "ModuleAccessStatus" NOT NULL DEFAULT 'LOCKED';

-- Backfill: before this migration there was no real "open to everyone" flag — the
-- curator's admin screen just guessed from one arbitrary student's access row. Treat a
-- module as having been intentionally opened if ANY active student already has it
-- unlocked/completed, so behavior for the already-configured cohort doesn't change.
UPDATE "Module"
SET "defaultAccess" = 'UNLOCKED'
WHERE "id" IN (
  SELECT DISTINCT ema."moduleId"
  FROM "EnrollmentModuleAccess" ema
  JOIN "Enrollment" e ON e.id = ema."enrollmentId"
  WHERE e.status = 'ACTIVE' AND ema.status IN ('UNLOCKED', 'COMPLETED')
);
