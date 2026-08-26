-- DropIndex
DROP INDEX "Assignment_lessonId_key";

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "allowedFormats" JSONB,
ADD COLUMN     "maxAttempts" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "requirements" JSONB;

-- AlterTable
ALTER TABLE "Submission" ADD COLUMN     "attachments" JSONB;

-- CreateIndex
CREATE INDEX "Assignment_lessonId_status_idx" ON "Assignment"("lessonId", "status");
