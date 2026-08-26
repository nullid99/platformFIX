ALTER TABLE "Submission"
  ADD COLUMN "reviewerId" TEXT,
  ADD COLUMN "claimedAt" TIMESTAMP(3);

CREATE INDEX "Submission_reviewerId_status_idx"
  ON "Submission"("reviewerId", "status");

ALTER TABLE "Submission"
  ADD CONSTRAINT "Submission_reviewerId_fkey"
  FOREIGN KEY ("reviewerId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
