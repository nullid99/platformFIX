-- Curator-managed cover templates for the schedule-event picker — see ScheduleCoverTemplate in
-- schema.prisma. Seeded with the 5 covers that used to be hardcoded in the frontend so nothing
-- disappears from the picker after this migration; they stay as plain static-asset paths.
CREATE TABLE "ScheduleCoverTemplate" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "coverPath" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleCoverTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ScheduleCoverTemplate_position_idx" ON "ScheduleCoverTemplate"("position");

INSERT INTO "ScheduleCoverTemplate" ("id", "label", "coverPath", "position") VALUES
    ('cltpl00000000000000000001', 'Backtest', '/event-covers/BACKTEST.png', 0),
    ('cltpl00000000000000000002', 'Morning', '/event-covers/MORNING.png', 1),
    ('cltpl00000000000000000003', 'Q&A', '/event-covers/QA.png', 2),
    ('cltpl00000000000000000004', 'Pre-session', '/event-covers/pre-session-cover.webp', 3),
    ('cltpl00000000000000000005', 'Лекция', '/event-covers/LECTURE.png', 4);
