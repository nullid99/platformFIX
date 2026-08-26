-- CreateTable
CREATE TABLE "MediaPlaybackEvent" (
    "id" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaPlaybackEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MediaPlaybackEvent_mediaAssetId_createdAt_idx" ON "MediaPlaybackEvent"("mediaAssetId", "createdAt");

-- CreateIndex
CREATE INDEX "MediaPlaybackEvent_userId_createdAt_idx" ON "MediaPlaybackEvent"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "MediaPlaybackEvent" ADD CONSTRAINT "MediaPlaybackEvent_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaPlaybackEvent" ADD CONSTRAINT "MediaPlaybackEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
