import { describe, expect, test } from "vitest";
import { NotificationType } from "./generated/prisma/enums";
import { NOTIFICATION_ICON } from "./page";

// The bell popover (app/page.tsx) renders a full-crash-prone lookup keyed by NotificationType —
// NOTIFICATION_ICON[item.type].icon — for every notification the API can send. A backend enum
// value with no matching frontend entry used to crash the whole popover for every user who had
// even one such notification (see NEW_SUBMISSION, added 2026-09-12, missed until 2026-09-21).
// The lookup now falls back to a default icon instead of throwing, but this test exists so a
// missing type is caught here — at development time — rather than rediscovered live.
describe("notification type coverage", () => {
  test("every NotificationType enum value has a NOTIFICATION_ICON entry", () => {
    const missing = Object.values(NotificationType).filter((type) => !(type in NOTIFICATION_ICON));
    expect(missing).toEqual([]);
  });
});
