import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// vi.mock below is hoisted above these imports, so the notifier already gets the fakes.
import { ScheduleReminderNotifier } from "./schedule-reminder-notifier";
import { eventTimeInZone } from "@/app/domain/schedule-time";

/**
 * "Через 15 минут" goes to students since 2026-10-03 (curators asked for it): the whole поток for
 * a lecture/Q&A, only the booked student for an individual slot, time in the student's own zone.
 */

const fake = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  users: [] as Array<{ email: string | null; timeZone: string | null }>,
  studentIds: ["s1", "s2"],
  bells: vi.fn(async () => undefined),
  emails: vi.fn(async () => undefined),
}));

vi.mock("@/app/server/db", () => ({
  prisma: {
    scheduleEvent: { findMany: async () => fake.events },
    user: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => fake.users.filter((_, index) => where.id.in.includes(`s${index + 1}`)) },
  },
}));
vi.mock("@/app/server/notifications/recipient-service", () => ({ activeStudentIds: async () => fake.studentIds }));
vi.mock("@/app/server/notifications/email-service", () => ({ sendStudentEventReminderNotification: fake.emails }));
vi.mock("@/app/server/notifications/notification-service", () => ({ notificationService: { createMany: fake.bells } }));

// An event 10 minutes from now, written the way curators enter it: Kyiv wall-clock.
function eventInTenMinutes(extra: Record<string, unknown>) {
  const start = new Date(Date.now() + 10 * 60_000);
  const kyiv = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(start).map((part) => [part.type, part.value]));
  return { id: `ev-${Math.random()}`, practicumId: "p1", type: "LECTURE", title: "Market Logic", date: new Date(`${kyiv.year}-${kyiv.month}-${kyiv.day}T00:00:00Z`), time: `${kyiv.hour}:${kyiv.minute}`, bookedByStudentId: null, ...extra };
}

describe("ScheduleReminderNotifier — reminders go to students", () => {
  beforeEach(() => {
    fake.bells.mockClear();
    fake.emails.mockClear();
    fake.users = [{ email: "a@example.com", timeZone: null }, { email: "b@example.com", timeZone: "Asia/Almaty" }];
  });
  afterEach(() => vi.useRealTimers());

  async function tick() {
    const notifier = new ScheduleReminderNotifier();
    await notifier["tick"]();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  it("a lecture reminds every student of the поток, with each one's own time", async () => {
    fake.events = [eventInTenMinutes({})];
    await tick();
    expect(fake.bells).toHaveBeenCalledWith(["s1", "s2"], "SCHEDULE_REMINDER", "Через 15 минут: Market Logic", "Лекция", fake.events[0].id);
    const labels = fake.emails.mock.calls.map((call) => (call as unknown as [{ to: string; timeLabel: string }])[0]);
    expect(labels.find((item) => item.to === "a@example.com")?.timeLabel).toMatch(/^в \d\d:\d\d по Киеву$/);
    expect(labels.find((item) => item.to === "b@example.com")?.timeLabel).toMatch(/по вашему времени \(по Киеву \d\d:\d\d\)$/);
  });

  it("an individual backtest slot reminds only the student who booked it", async () => {
    fake.events = [eventInTenMinutes({ type: "BACKTEST", bookedByStudentId: "s2" })];
    await tick();
    expect(fake.bells).toHaveBeenCalledWith(["s2"], "SCHEDULE_REMINDER", "Через 15 минут: Market Logic", "Бэктест", fake.events[0].id);
  });

  it("a free slot nobody booked reminds nobody", async () => {
    fake.events = [eventInTenMinutes({ type: "PRE_SESSION", bookedByStudentId: null })];
    await tick();
    expect(fake.bells).not.toHaveBeenCalled();
  });
});

describe("eventTimeInZone", () => {
  it("converts per date — Almaty is +2h on Kyiv summer time, +3h after the switch", () => {
    expect(eventTimeInZone("2026-10-03", "13:00 — 14:00", "Asia/Almaty")).toBe("15:00 — 16:00");
    expect(eventTimeInZone("2026-11-10", "13:00", "Asia/Almaty")).toBe("16:00");
    expect(eventTimeInZone("2026-11-10", "весь день", "Asia/Almaty")).toBeNull();
  });
});
