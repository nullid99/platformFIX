-- One-click "Напомнить" on the curator's "Прогресс" page (CuratorProgressView) — sends the
-- student a normal in-app + email notification through the existing dual-channel system,
-- same as every other NotificationType, not a new delivery mechanism.
ALTER TYPE "NotificationType" ADD VALUE 'CURATOR_REMINDER';
