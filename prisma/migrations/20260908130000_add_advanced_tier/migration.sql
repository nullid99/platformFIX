-- Advanced tier: a curator-granted, per-person flag that unlocks the "Advanced" Module.section
-- track and Advanced-only recordings — see course-service.ts#getForUser and CourseView's third
-- tab. MediaAudience is independent of MediaAssetKind (kind = what it is, audience = who sees it).
CREATE TYPE "MediaAudience" AS ENUM ('ALL', 'ADVANCED');

ALTER TABLE "User" ADD COLUMN "isAdvanced" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MediaAsset" ADD COLUMN "audience" "MediaAudience" NOT NULL DEFAULT 'ALL';
