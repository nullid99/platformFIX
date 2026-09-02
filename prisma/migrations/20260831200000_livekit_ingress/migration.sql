-- AlterTable
ALTER TABLE "Practicum" RENAME COLUMN "streamLiveInputUid" TO "liveKitIngressId";
ALTER TABLE "Practicum" ADD COLUMN     "isCurrentlyLive" BOOLEAN NOT NULL DEFAULT false;
