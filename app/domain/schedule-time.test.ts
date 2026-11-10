import { describe, expect, it } from "vitest";
import { slotBookingClosesAt } from "./schedule-time";

describe("slotBookingClosesAt", () => {
  it("closes 24 hours before the slot's Kyiv start time", () => {
    // 19:00 Kyiv on 12 Nov (UTC+2 in winter) is 17:00 UTC; a day earlier is 11 Nov 17:00 UTC.
    expect(slotBookingClosesAt("2026-11-12", "19:00 — 20:30").toISOString()).toBe("2026-11-11T17:00:00.000Z");
  });

  it("follows summer time", () => {
    // 10:00 Kyiv on 15 Jul (UTC+3) is 07:00 UTC.
    expect(slotBookingClosesAt("2026-07-15", "10:00").toISOString()).toBe("2026-07-14T07:00:00.000Z");
  });

  it("counts from the start of the day when the label has no time", () => {
    expect(slotBookingClosesAt("2026-11-12", "вечером").toISOString()).toBe("2026-11-10T22:00:00.000Z");
  });
});
