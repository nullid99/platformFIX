-- AlterTable
ALTER TABLE "StreamMessage" ADD COLUMN     "replyToId" TEXT;

-- CreateTable
CREATE TABLE "StreamMessageReaction" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StreamMessageReaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StreamMessageReaction_messageId_idx" ON "StreamMessageReaction"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "StreamMessageReaction_messageId_userId_emoji_key" ON "StreamMessageReaction"("messageId", "userId", "emoji");

-- CreateIndex
CREATE INDEX "StreamMessage_replyToId_idx" ON "StreamMessage"("replyToId");

-- AddForeignKey
ALTER TABLE "StreamMessage" ADD CONSTRAINT "StreamMessage_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "StreamMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StreamMessageReaction" ADD CONSTRAINT "StreamMessageReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "StreamMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StreamMessageReaction" ADD CONSTRAINT "StreamMessageReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
