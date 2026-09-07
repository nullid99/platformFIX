-- Removes the "pin a student to a curator" feature (CuratorAssignment) entirely: it no longer
-- gates anything (every active curator can already see every student/thread), and the only
-- remaining UI for it (claim/transfer) was unreachable dead code. Dropping the table also drops
-- its own FK constraints and indexes, so nothing else needs to change.
DROP TABLE "CuratorAssignment";
