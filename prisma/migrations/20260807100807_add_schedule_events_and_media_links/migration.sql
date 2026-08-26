-- CreateEnum
CREATE TYPE "ScheduleEventType" AS ENUM ('PRACTICE', 'QA', 'BREAKDOWN');

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "scheduleEventId" TEXT;

-- CreateTable
CREATE TABLE "ScheduleEvent" (
    "id" TEXT NOT NULL,
    "practicumId" TEXT NOT NULL,
    "type" "ScheduleEventType" NOT NULL,
    "title" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "time" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "live" BOOLEAN NOT NULL DEFAULT false,
    "coverPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleEvent_practicumId_date_idx" ON "ScheduleEvent"("practicumId", "date");

-- CreateIndex
CREATE INDEX "ScheduleEvent_practicumId_type_date_idx" ON "ScheduleEvent"("practicumId", "type", "date");

-- CreateIndex
CREATE INDEX "MediaAsset_scheduleEventId_status_position_idx" ON "MediaAsset"("scheduleEventId", "status", "position");

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_scheduleEventId_fkey" FOREIGN KEY ("scheduleEventId") REFERENCES "ScheduleEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleEvent" ADD CONSTRAINT "ScheduleEvent_practicumId_fkey" FOREIGN KEY ("practicumId") REFERENCES "Practicum"("id") ON DELETE CASCADE ON UPDATE CASCADE;
