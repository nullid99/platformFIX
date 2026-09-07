ALTER TABLE "User" ADD COLUMN "workingPracticumId" TEXT;

ALTER TABLE "User" ADD CONSTRAINT "User_workingPracticumId_fkey"
  FOREIGN KEY ("workingPracticumId") REFERENCES "Practicum"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
