import { describe, expect, test } from "vitest";
import { convertEventTime } from "./page";

// Events are entered in Kyiv time; students see them in their own zone. Converted per event date,
// so countries with different (or no) DST switches are right on both sides of the switch.
describe("convertEventTime (Kyiv → viewer zone)", () => {
  test("Kazakhstan (no DST): +2h while Kyiv is on summer time, +3h after Kyiv's switch", () => {
    expect(convertEventTime("2026-10-01", "13:00 — 14:00", "Asia/Almaty")).toEqual({ date: "2026-10-01", time: "15:00 — 16:00" });
    expect(convertEventTime("2026-11-10", "13:00 — 14:00", "Asia/Almaty")).toEqual({ date: "2026-11-10", time: "16:00 — 17:00" });
  });

  test("Germany switches with Kyiv: always one hour behind", () => {
    expect(convertEventTime("2026-10-03", "13:00 — 14:00", "Europe/Berlin")).toEqual({ date: "2026-10-03", time: "12:00 — 13:00" });
    expect(convertEventTime("2026-11-10", "13:00 — 14:00", "Europe/Berlin")).toEqual({ date: "2026-11-10", time: "12:00 — 13:00" });
  });

  test("the date moves too when the time crosses midnight (New York)", () => {
    expect(convertEventTime("2026-10-03", "02:00 — 03:00", "America/New_York")).toEqual({ date: "2026-10-02", time: "19:00 — 20:00" });
  });

  test("a single time and Kyiv itself", () => {
    expect(convertEventTime("2026-10-03", "18:30", "Europe/Warsaw")).toEqual({ date: "2026-10-03", time: "17:30" });
    expect(convertEventTime("2026-10-03", "18:30 — 19:30", "Europe/Kyiv")).toEqual({ date: "2026-10-03", time: "18:30 — 19:30" });
  });

  test("free text that isn't a time is left as typed", () => {
    expect(convertEventTime("2026-10-03", "весь день", "Europe/Berlin")).toBeNull();
  });
});
