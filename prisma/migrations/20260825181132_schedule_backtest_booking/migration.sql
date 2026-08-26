-- AlterEnum
ALTER TYPE "ScheduleEventType" ADD VALUE 'BACKTEST';

-- AlterTable
ALTER TABLE "ScheduleEvent" ADD COLUMN     "bookedAt" TIMESTAMP(3),
ADD COLUMN     "bookedByStudentId" TEXT;

-- CreateIndex
CREATE INDEX "ScheduleEvent_bookedByStudentId_idx" ON "ScheduleEvent"("bookedByStudentId");

-- AddForeignKey
ALTER TABLE "ScheduleEvent" ADD CONSTRAINT "ScheduleEvent_bookedByStudentId_fkey" FOREIGN KEY ("bookedByStudentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
