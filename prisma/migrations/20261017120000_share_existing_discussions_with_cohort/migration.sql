-- "Отвечено ранее" now shows only threads the student agreed to share (visibility = COHORT).
-- Until now every thread was created PRIVATE and still shown there, so keep today's behaviour for
-- the existing ones (security review STG-1, 2026-10-17).
UPDATE "DiscussionThread" SET "visibility" = 'COHORT' WHERE "visibility" = 'PRIVATE';
