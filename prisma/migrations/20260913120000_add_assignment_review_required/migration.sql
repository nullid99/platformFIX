-- "ДЗ без проверки" — an assignment the student can mark done themselves, without a curator
-- review, so a lesson with no real homework can still unlock the next one. See
-- AssignmentService#completeWithoutReview and Assignment.reviewRequired in schema.prisma.
ALTER TABLE "Assignment" ADD COLUMN "reviewRequired" BOOLEAN NOT NULL DEFAULT true;
