ALTER TYPE "NotificationType" ADD VALUE 'NEW_MODULE';
ALTER TYPE "NotificationType" ADD VALUE 'MODULE_OPENED';

-- One global row, not tied to any Practicum — see PlatformSettings doc comment in schema.prisma.
CREATE TABLE "PlatformSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "PlatformSettings" ("id", "notificationsEnabled", "updatedAt") VALUES ('singleton', true, CURRENT_TIMESTAMP);
