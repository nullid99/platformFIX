-- CreateTable
CREATE TABLE "StreamMessage" (
    "id" TEXT NOT NULL,
    "practicumId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StreamMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StreamMessage_practicumId_createdAt_idx" ON "StreamMessage"("practicumId", "createdAt");

-- AddForeignKey
ALTER TABLE "StreamMessage" ADD CONSTRAINT "StreamMessage_practicumId_fkey" FOREIGN KEY ("practicumId") REFERENCES "Practicum"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StreamMessage" ADD CONSTRAINT "StreamMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
