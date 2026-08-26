-- AlterEnum
BEGIN;
CREATE TYPE "IdentityProvider_new" AS ENUM ('DISCORD', 'LOCAL');
ALTER TABLE "ExternalIdentity" ALTER COLUMN "provider" TYPE "IdentityProvider_new" USING ("provider"::text::"IdentityProvider_new");
ALTER TABLE "Invitation" ALTER COLUMN "targetProvider" TYPE "IdentityProvider_new" USING ("targetProvider"::text::"IdentityProvider_new");
ALTER TABLE "LoginEvent" ALTER COLUMN "provider" TYPE "IdentityProvider_new" USING ("provider"::text::"IdentityProvider_new");
ALTER TYPE "IdentityProvider" RENAME TO "IdentityProvider_old";
ALTER TYPE "IdentityProvider_new" RENAME TO "IdentityProvider";
DROP TYPE "public"."IdentityProvider_old";
COMMIT;

-- DropTable
DROP TABLE "TelegramAuthChallenge";

