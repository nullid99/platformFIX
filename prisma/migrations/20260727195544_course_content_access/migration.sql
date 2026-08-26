-- CreateEnum
CREATE TYPE "ModuleAccessStatus" AS ENUM ('LOCKED', 'UNLOCKED', 'COMPLETED');

-- AlterTable
ALTER TABLE "Module" ADD COLUMN     "coverPath" TEXT,
ADD COLUMN     "section" TEXT NOT NULL DEFAULT 'Education';

-- CreateTable
CREATE TABLE "EnrollmentModuleAccess" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "status" "ModuleAccessStatus" NOT NULL DEFAULT 'LOCKED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "unlockedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnrollmentModuleAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EnrollmentModuleAccess_moduleId_status_idx" ON "EnrollmentModuleAccess"("moduleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EnrollmentModuleAccess_enrollmentId_moduleId_key" ON "EnrollmentModuleAccess"("enrollmentId", "moduleId");

-- AddForeignKey
ALTER TABLE "EnrollmentModuleAccess" ADD CONSTRAINT "EnrollmentModuleAccess_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrollmentModuleAccess" ADD CONSTRAINT "EnrollmentModuleAccess_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE CASCADE ON UPDATE CASCADE;
