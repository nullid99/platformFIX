-- CreateTable
CREATE TABLE "DiscordAuthChallenge" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "codeVerifierCiphertext" TEXT NOT NULL,
    "invitationTokenCiphertext" TEXT,
    "redirectUri" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscordAuthChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiscordAuthChallenge_stateHash_key" ON "DiscordAuthChallenge"("stateHash");

-- CreateIndex
CREATE INDEX "DiscordAuthChallenge_expiresAt_usedAt_idx" ON "DiscordAuthChallenge"("expiresAt", "usedAt");
