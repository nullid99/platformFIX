-- "Завершить эфир" on a schedule event (see ScheduleEvent.streamEndedAt). Nullable, no backfill.
ALTER TABLE "ScheduleEvent" ADD COLUMN "streamEndedAt" TIMESTAMP(3);
