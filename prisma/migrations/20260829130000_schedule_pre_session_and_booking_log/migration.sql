ALTER TYPE "ScheduleEventType" ADD VALUE 'PRE_SESSION';

ALTER TABLE "Practicum" ADD COLUMN "backtestSlotLimit" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Practicum" ADD COLUMN "preSessionSlotLimit" INTEGER NOT NULL DEFAULT 1;

CREATE TYPE "ScheduleBookingAction" AS ENUM ('BOOKED', 'CANCELLED');

CREATE TABLE "ScheduleBooking" (
    "id" TEXT NOT NULL,
    "practicumId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" "ScheduleEventType" NOT NULL,
    "eventTitle" TEXT NOT NULL,
    "eventDate" DATE NOT NULL,
    "eventTime" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "action" "ScheduleBookingAction" NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleBooking_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ScheduleBooking_studentId_createdAt_idx" ON "ScheduleBooking"("studentId", "createdAt");
CREATE INDEX "ScheduleBooking_practicumId_eventType_createdAt_idx" ON "ScheduleBooking"("practicumId", "eventType", "createdAt");

ALTER TABLE "ScheduleBooking" ADD CONSTRAINT "ScheduleBooking_practicumId_fkey" FOREIGN KEY ("practicumId") REFERENCES "Practicum"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduleBooking" ADD CONSTRAINT "ScheduleBooking_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduleBooking" ADD CONSTRAINT "ScheduleBooking_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
