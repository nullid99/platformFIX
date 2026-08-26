-- CreateTable
CREATE TABLE "TelegramAuthChallenge" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "codeVerifierCiphertext" TEXT NOT NULL,
    "invitationTokenCiphertext" TEXT,
    "redirectUri" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramAuthChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramAuthChallenge_stateHash_key" ON "TelegramAuthChallenge"("stateHash");

-- CreateIndex
CREATE INDEX "TelegramAuthChallenge_expiresAt_usedAt_idx" ON "TelegramAuthChallenge"("expiresAt", "usedAt");
