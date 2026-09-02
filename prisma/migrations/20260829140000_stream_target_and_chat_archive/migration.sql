ALTER TABLE "Practicum" ADD COLUMN "pendingStreamModuleId" TEXT;
ALTER TABLE "Practicum" ADD COLUMN "pendingStreamScheduleEventId" TEXT;

ALTER TABLE "MediaAsset" ADD COLUMN "chatSessionStartedAt" TIMESTAMP(3);
ALTER TABLE "MediaAsset" ADD COLUMN "chatSessionEndedAt" TIMESTAMP(3);
