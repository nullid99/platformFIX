import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ScheduleEventType } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { EVENT_TIMEZONE, eventTimeInZone, zonedTimeToUtc } from "@/app/domain/schedule-time";
import { activeStudentIds } from "@/app/server/notifications/recipient-service";
import { sendStudentEventReminderNotification } from "@/app/server/notifications/email-service";
import { notificationService } from "@/app/server/notifications/notification-service";

const POLL_INTERVAL_MS = 60_000;
const REMINDER_LEAD_MS = 15 * 60_000;

const EVENT_TYPE_LABELS: Record<ScheduleEventType, string> = {
  PRACTICE: "Практическая часть",
  QA: "Q&A",
  BREAKDOWN: "Разбор ДЗ",
  BACKTEST: "Бэктест",
  LECTURE: "Лекция",
  PRE_SESSION: "Пресессия",
};

/** Combines the date-only column with the free-text "HH:MM — HH:MM" time label, same convention the frontend uses (ScheduleEvent.eventStartDate). Interpreted as Kyiv time (see schedule-time.ts) — this runs inside a UTC container, so a plain unzoned `new Date(...)` would fire reminders hours late. */
function eventStartsAt(event: { date: Date; time: string }): Date | null {
  const startLabel = event.time.split(/\s*[—–-]\s*/)[0]?.trim();
  if (!startLabel) return null;
  const dateKey = event.date.toISOString().slice(0, 10);
  const start = zonedTimeToUtc(dateKey, startLabel);
  return Number.isNaN(start.getTime()) ? null : start;
}

/**
 * "Через 15 минут" — reminds the поток's students 15 minutes before a scheduled event (lecture,
 * Q&A, …); for an individual slot (Бэктест/Пресессия) only the student who booked it. Went to
 * curators only until 2026-10-03, when it was switched to students at the curators' request. The
 * time in the email is in the student's own zone if they picked one in Профиль, else Kyiv.
 */
@Injectable()
export class ScheduleReminderNotifier implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  // Event ids already reminded — cleared implicitly once an event's start time passes the
  // reminder window (see tick(), which stops considering it), so this only holds near-term ids.
  private readonly notified = new Set<string>();

  public onModuleInit(): void {
    this.timer = setInterval(() => { void this.tick(); }, POLL_INTERVAL_MS);
  }

  public onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const events = await prisma.scheduleEvent.findMany({
      where: { practicum: { completedAt: null } },
      select: { id: true, practicumId: true, type: true, title: true, date: true, time: true, bookedByStudentId: true },
    }).catch((error: unknown) => {
      console.error("Schedule reminder poll failed", error instanceof Error ? error.message : "unknown error");
      return [];
    });

    for (const event of events) {
      if (this.notified.has(event.id)) continue;
      const startsAt = eventStartsAt(event);
      if (!startsAt) continue;
      const msUntilStart = startsAt.getTime() - now;
      if (msUntilStart <= 0 || msUntilStart > REMINDER_LEAD_MS) continue;
      this.notified.add(event.id);
      void this.notifyStudents(event);
    }
  }

  private async notifyStudents(event: { id: string; practicumId: string; type: ScheduleEventType; title: string; date: Date; time: string; bookedByStudentId: string | null }): Promise<void> {
    const typeLabel = EVENT_TYPE_LABELS[event.type] ?? event.type;
    try {
      const isIndividualSlot = event.type === ScheduleEventType.BACKTEST || event.type === ScheduleEventType.PRE_SESSION;
      const studentIds = isIndividualSlot
        ? (event.bookedByStudentId ? [event.bookedByStudentId] : [])
        : await activeStudentIds(event.practicumId);
      if (studentIds.length === 0) return;
      await notificationService.createMany(studentIds, "SCHEDULE_REMINDER", `Через 15 минут: ${event.title}`, typeLabel, event.id);
      const dateKey = event.date.toISOString().slice(0, 10);
      const recipients = await prisma.user.findMany({ where: { id: { in: studentIds }, email: { not: null } }, select: { email: true, timeZone: true } });
      await Promise.all(recipients.map((recipient) => {
        const ownTime = recipient.timeZone && recipient.timeZone !== EVENT_TIMEZONE ? eventTimeInZone(dateKey, event.time, recipient.timeZone) : null;
        const timeLabel = ownTime && ownTime !== event.time ? `в ${ownTime} по вашему времени (по Киеву ${event.time})` : `в ${event.time} по Киеву`;
        return recipient.email && sendStudentEventReminderNotification({ to: recipient.email, eventTitle: event.title, eventTypeLabel: typeLabel, timeLabel, eventId: event.id });
      }));
    } catch (error) {
      console.error("Schedule reminder dispatch failed", error instanceof Error ? error.message : "unknown error");
    }
  }
}
