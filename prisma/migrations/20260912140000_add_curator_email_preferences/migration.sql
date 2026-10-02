-- Per-curator email preferences ("Новое ДЗ на проверку" / "Новый вопрос от ученика") — the
-- in-app bell always fires regardless, this only gates the extra email. See User.notifyNewSubmission
-- / User.notifyNewQuestion in schema.prisma and notification-service.ts.
ALTER TABLE "User" ADD COLUMN "notifyNewSubmission" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "notifyNewQuestion" BOOLEAN NOT NULL DEFAULT true;

-- New notification type for a student's submission landing in the review queue — did not exist
-- before this migration, so curators had no way to know about a new ДЗ without checking manually.
ALTER TYPE "NotificationType" ADD VALUE 'NEW_SUBMISSION';
