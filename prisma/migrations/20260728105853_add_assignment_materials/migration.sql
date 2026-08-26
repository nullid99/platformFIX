-- CreateEnum
CREATE TYPE "AssignmentMaterialKind" AS ENUM ('LINK', 'FILE');

-- CreateTable
CREATE TABLE "AssignmentMaterial" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "kind" "AssignmentMaterialKind" NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "fileId" TEXT,
    "mimeType" TEXT,
    "byteSize" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssignmentMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssignmentMaterial_assignmentId_position_idx" ON "AssignmentMaterial"("assignmentId", "position");

-- CreateIndex
CREATE INDEX "AssignmentMaterial_fileId_idx" ON "AssignmentMaterial"("fileId");

-- AddForeignKey
ALTER TABLE "AssignmentMaterial" ADD CONSTRAINT "AssignmentMaterial_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentMaterial" ADD CONSTRAINT "AssignmentMaterial_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
