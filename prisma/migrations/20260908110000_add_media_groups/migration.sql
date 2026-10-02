-- Curator-defined named sections inside a lesson (e.g. "Бектест", "Пресессия") for grouping
-- MediaAsset recordings — built for Практика lessons' flexible template, but not restricted to it.
CREATE TABLE "MediaGroup" (
    "id" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MediaGroup_moduleId_position_key" ON "MediaGroup"("moduleId", "position");
CREATE INDEX "MediaGroup_moduleId_idx" ON "MediaGroup"("moduleId");

ALTER TABLE "MediaGroup" ADD CONSTRAINT "MediaGroup_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Which group a recording belongs to inside its module — null for anything not sorted into one
-- (including every Теория lesson, which never uses groups).
ALTER TABLE "MediaAsset" ADD COLUMN "groupId" TEXT;
CREATE INDEX "MediaAsset_groupId_status_position_idx" ON "MediaAsset"("groupId", "status", "position");
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "MediaGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
