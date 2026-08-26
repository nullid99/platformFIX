-- Drop the unused submission-attempts cap. It was never enforced anywhere in the
-- submit/review flow, only stored and displayed — removing it as dead schema weight.
ALTER TABLE "Assignment" DROP COLUMN "maxAttempts";
