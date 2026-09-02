import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ScheduleEventType } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { activeCuratorEmails, activeCuratorIds } from "@/app/server/notifications/recipient-service";
import { sendScheduleReminderNotification } from "@/app/server/notifications/email-service";
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

/** Combines the date-only column with the free-text "HH:MM — HH:MM" time label, same convention the frontend uses (ScheduleEvent.eventStartDate). */
function eventStartsAt(event: { date: Date; time: string }): Date | null {
  const startLabel = event.time.split(/\s*[—–-]\s*/)[0]?.trim();
  if (!startLabel) return null;
  const dateKey = event.date.toISOString().slice(0, 10);
  const start = new Date(`${dateKey}T${startLabel}:00`);
  return Number.isNaN(start.getTime()) ? null : start;
}

/**
 * Reminds curators 15 minutes before any scheduled event (Q&A, backtest review, lecture, etc.)
 * so they have time to get set up before going live — independent of any open browser tab.
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
    const events = await prisma.scheduleEvent.findMany({ select: { id: true, type: true, title: true, date: true, time: true } }).catch((error: unknown) => {
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
      void this.notifyCurators(event);
    }
  }

  private async notifyCurators(event: { id: string; type: ScheduleEventType; title: string; time: string }): Promise<void> {
    const typeLabel = EVENT_TYPE_LABELS[event.type] ?? event.type;
    try {
      const emails = await activeCuratorEmails();
      await Promise.all(emails.map((to) => sendScheduleReminderNotification({ to, eventTitle: event.title, eventTypeLabel: typeLabel, eventTime: event.time, eventId: event.id })));
      const curatorIds = await activeCuratorIds();
      await notificationService.createMany(curatorIds, "SCHEDULE_REMINDER", `Через 15 минут: ${event.title}`, typeLabel, event.id);
    } catch (error) {
      console.error("Schedule reminder dispatch failed", error instanceof Error ? error.message : "unknown error");
    }
  }
}
