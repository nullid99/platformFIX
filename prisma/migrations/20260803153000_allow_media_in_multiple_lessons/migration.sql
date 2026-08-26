DROP INDEX IF EXISTS "MediaAsset_provider_providerKey_key";

CREATE UNIQUE INDEX "MediaAsset_provider_providerKey_lessonId_key" ON "MediaAsset"("provider", "providerKey", "lessonId");
