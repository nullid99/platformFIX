-- "Эфир ведёт: Имя" — who started the current broadcast (see Practicum.streamStartedById).
ALTER TABLE "Practicum" ADD COLUMN "streamStartedById" TEXT;
ALTER TABLE "Practicum" ADD COLUMN "streamStartedAt" TIMESTAMP(3);
ALTER TABLE "Practicum" ADD CONSTRAINT "Practicum_streamStartedById_fkey" FOREIGN KEY ("streamStartedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
