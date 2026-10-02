-- Student's chosen display time zone (see User.timeZone). Nullable, no backfill.
ALTER TABLE "User" ADD COLUMN "timeZone" TEXT;
