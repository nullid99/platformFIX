/**
 * Every ScheduleEvent's date/time is entered and displayed as Kyiv civil time (the practicum's
 * one shared schedule, regardless of where a given curator or student happens to be sitting) —
 * see EVENT_TIMEZONE below. `new Date("2026-09-05T19:00:00")` (no offset) is NOT safe for this:
 * it resolves to whatever timezone the *runtime* happens to be in, which is Kyiv time in a
 * browser physically in Ukraine but UTC in the API's Docker container — the two disagreeing by
 * a fixed 2-3h caused reminder emails to fire hours late. zonedTimeToUtc pins the conversion to
 * Kyiv explicitly, correct in both places and across the DST transition, using only the ICU
 * timezone database already bundled with Node/V8 (no date library needed).
 */
export const EVENT_TIMEZONE = "Europe/Kyiv";

/** Converts a "YYYY-MM-DD" date key + "HH:MM" wall-clock time in `timeZone` into the UTC instant it represents. */
export function zonedTimeToUtc(dateKey: string, hhmm: string, timeZone: string = EVENT_TIMEZONE): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  const [hour, minute] = hhmm.split(":").map(Number);
  // First guess: treat the wall-clock numbers as if they were already UTC, then measure how far
  // that guess actually lands from the intended zone and correct by the difference. One
  // iteration is enough since a timezone's UTC offset doesn't change within the few hours this
  // correction can ever be off by.
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(utcGuess)).map((part) => [part.type, part.value]));
  const asZoned = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return new Date(utcGuess - (asZoned - utcGuess));
}

/** "YYYY-MM-DD" calendar-date key for `date` as seen in `timeZone` — lets a booking date compare against "today" without off-by-one drift from the server's own UTC clock. */
export function dateKeyInZone(date: Date, timeZone: string = EVENT_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Today's calendar-date key in `timeZone` — see dateKeyInZone. */
export function todayDateKey(timeZone: string = EVENT_TIMEZONE): string {
  return dateKeyInZone(new Date(), timeZone);
}

/** Formats a UTC instant as "DD.MM.YYYY HH:MM" wall-clock time in `timeZone` — e.g. auto-naming an unattached stream recording that has no lesson/event title to borrow. */
export function formatZonedDateTime(date: Date, timeZone: string = EVENT_TIMEZONE): string {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`;
}

/**
 * A schedule time label ("13:00" or "13:00 — 14:00", Kyiv wall-clock on `dateKey`) shown in another
 * zone — e.g. a student's chosen zone in their reminder email. Null for free text that isn't a time.
 */
export function eventTimeInZone(dateKey: string, time: string, timeZone: string): string | null {
  const match = time.match(/^\s*(\d{1,2}:\d{2})\s*(?:[—–-]\s*(\d{1,2}:\d{2}))?\s*$/);
  if (!match) return null;
  const toZone = (hhmm: string) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(zonedTimeToUtc(dateKey, hhmm)).map((part) => [part.type, part.value]));
    return `${parts.hour}:${parts.minute}`;
  };
  return match[2] ? `${toZone(match[1])} — ${toZone(match[2])}` : toZone(match[1]);
}
