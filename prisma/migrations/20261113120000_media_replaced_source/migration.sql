-- "Заменить на Vimeo": the same MediaAsset row switches provider, so its place, date, lesson,
-- chat archive and view log stay. These remember what it played from before (our own recording's
-- object key), so the file can be found again — to restore it, or to delete it from the stream
-- server on purpose. All nullable; existing rows are untouched.
ALTER TABLE "MediaAsset" ADD COLUMN "replacedFromProvider" TEXT;
ALTER TABLE "MediaAsset" ADD COLUMN "replacedFromKey" TEXT;
ALTER TABLE "MediaAsset" ADD COLUMN "replacedAt" TIMESTAMP(3);
