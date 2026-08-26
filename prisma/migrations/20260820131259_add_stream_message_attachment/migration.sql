-- AlterTable
ALTER TABLE "StreamMessage" ADD COLUMN     "fileId" TEXT;

-- CreateIndex
CREATE INDEX "StreamMessage_fileId_idx" ON "StreamMessage"("fileId");

-- AddForeignKey
ALTER TABLE "StreamMessage" ADD CONSTRAINT "StreamMessage_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
