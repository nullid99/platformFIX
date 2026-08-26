-- CreateEnum
CREATE TYPE "DiscussionStatus" AS ENUM ('NEW', 'WAITING', 'ANSWERED', 'CLOSED');

-- CreateEnum
CREATE TYPE "DiscussionVisibility" AS ENUM ('PRIVATE', 'COHORT');

-- AlterTable
ALTER TABLE "MediaAsset" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "DiscussionThread" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "curatorId" TEXT,
    "moduleId" TEXT,
    "lessonId" TEXT,
    "assignmentId" TEXT,
    "title" TEXT NOT NULL,
    "status" "DiscussionStatus" NOT NULL DEFAULT 'NEW',
    "visibility" "DiscussionVisibility" NOT NULL DEFAULT 'PRIVATE',
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscussionThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscussionMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscussionMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscussionAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fileId" TEXT,
    "sourceUrl" TEXT,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscussionAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DiscussionThread_studentId_lastMessageAt_idx" ON "DiscussionThread"("studentId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "DiscussionThread_curatorId_status_lastMessageAt_idx" ON "DiscussionThread"("curatorId", "status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "DiscussionThread_lessonId_createdAt_idx" ON "DiscussionThread"("lessonId", "createdAt");

-- CreateIndex
CREATE INDEX "DiscussionThread_assignmentId_createdAt_idx" ON "DiscussionThread"("assignmentId", "createdAt");

-- CreateIndex
CREATE INDEX "DiscussionMessage_threadId_createdAt_idx" ON "DiscussionMessage"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "DiscussionMessage_authorId_createdAt_idx" ON "DiscussionMessage"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "DiscussionAttachment_messageId_createdAt_idx" ON "DiscussionAttachment"("messageId", "createdAt");

-- CreateIndex
CREATE INDEX "DiscussionAttachment_fileId_idx" ON "DiscussionAttachment"("fileId");

-- AddForeignKey
ALTER TABLE "DiscussionThread" ADD CONSTRAINT "DiscussionThread_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscussionThread" ADD CONSTRAINT "DiscussionThread_curatorId_fkey" FOREIGN KEY ("curatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscussionThread" ADD CONSTRAINT "DiscussionThread_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscussionThread" ADD CONSTRAINT "DiscussionThread_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscussionThread" ADD CONSTRAINT "DiscussionThread_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscussionMessage" ADD CONSTRAINT "DiscussionMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "DiscussionThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscussionMessage" ADD CONSTRAINT "DiscussionMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscussionAttachment" ADD CONSTRAINT "DiscussionAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "DiscussionMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscussionAttachment" ADD CONSTRAINT "DiscussionAttachment_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
