import { Prisma } from "@/app/generated/prisma/client";
import { EnrollmentStatus, MediaAssetStatus, ScheduleBookingAction, ScheduleEventType, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { AuthServiceError } from "@/app/server/auth";
import { prisma } from "@/app/server/db";
import { activeStudentEmails, activeStudentIds } from "@/app/server/notifications/recipient-service";
import { sendNewEventNotification } from "@/app/server/notifications/email-service";
import { notificationService } from "@/app/server/notifications/notification-service";
import { getActivePracticumId } from "@/app/server/course/practicum-service";

export type ScheduleEventInput = {
  type: ScheduleEventType;
  title: string;
  date: string;
  time: string;
  description: string;
  live?: boolean;
  coverPath?: string;
};

const eventTypeLabels: Record<ScheduleEventType, string> = {
  [ScheduleEventType.PRACTICE]: "Практическая часть",
  [ScheduleEventType.QA]: "Q&A",
  [ScheduleEventType.BREAKDOWN]: "Разбор ДЗ",
  [ScheduleEventType.BACKTEST]: "Бэктест (индивидуально)",
  [ScheduleEventType.LECTURE]: "Лекция",
  [ScheduleEventType.PRE_SESSION]: "Пресессия (индивидуально)",
};

const BOOKABLE_TYPES = new Set<ScheduleEventType>([ScheduleEventType.BACKTEST, ScheduleEventType.PRE_SESSION]);
const MIN_SLOT_LIMIT = 0;
const MAX_SLOT_LIMIT = 20;

type BookingLimits = { backtestSlotLimit: number; preSessionSlotLimit: number };

function slotLimitForType(type: ScheduleEventType, limits: BookingLimits): number | null {
  if (type === ScheduleEventType.BACKTEST) return limits.backtestSlotLimit;
  if (type === ScheduleEventType.PRE_SESSION) return limits.preSessionSlotLimit;
  return null;
}

function requiredText(value: string, field: string, maximumLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new AuthServiceError("INVALID_INPUT", `${field} is invalid`);
  }
  return normalized;
}

function parseDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AuthServiceError("INVALID_INPUT", "date is invalid");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new AuthServiceError("INVALID_INPUT", "date is invalid");
  }
  return date;
}

function dateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function mediaDto(media: { id: string; title: string | null; provider: string; providerKey: string; status: MediaAssetStatus }) {
  let embedUrl: string | null = null;
  let thumbnailUrl: string | null = null;

  if (media.provider.toUpperCase() === "VIMEO") {
    const videoId = media.providerKey.split("?", 1)[0];
    const hash = new URLSearchParams(media.providerKey.split("?")[1] ?? "").get("h");
    if (/^\d+$/.test(videoId)) {
      embedUrl = `https://player.vimeo.com/video/${videoId}${hash ? `?h=${encodeURIComponent(hash)}` : ""}`;
      thumbnailUrl = `https://vumbnail.com/${videoId}.jpg`;
    }
  }

  return { id: media.id, title: media.title, provider: media.provider, status: media.status, embedUrl, thumbnailUrl };
}

export class ScheduleService {
  public async getForUser(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
    if (!user || user.status !== UserStatus.ACTIVE) throw new AuthServiceError("SESSION_INVALID", "User is not active");

    const enrollment = user.role === UserRole.STUDENT
      ? await prisma.enrollment.findFirst({
        where: { studentId: userId, status: EnrollmentStatus.ACTIVE, OR: [{ accessUntil: null }, { accessUntil: { gt: new Date() } }] },
        orderBy: { createdAt: "asc" },
        select: { practicumId: true },
      })
      : null;
    if (user.role === UserRole.STUDENT && !enrollment) throw new AuthServiceError("FORBIDDEN", "Student is not enrolled in a practicum");
    const practicumId = enrollment?.practicumId ?? (await getActivePracticumId());
    if (!practicumId) throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");

    const [events, limits] = await Promise.all([
      prisma.scheduleEvent.findMany({
        where: { practicumId },
        orderBy: [{ date: "asc" }, { createdAt: "asc" }],
        include: {
          mediaAssets: { where: user.role === UserRole.STUDENT ? { status: MediaAssetStatus.PUBLISHED } : undefined, orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
          bookedBy: { include: { externalIdentities: { orderBy: { createdAt: "asc" }, take: 1 } } },
        },
      }),
      this.practicumBookingLimits(practicumId),
    ]);
    return events.map((event) => this.toDto(event, userId, limits));
  }

  public async book(actorId: string, eventId: string) {
    await this.assertActiveUser(actorId, UserRole.STUDENT);
    try {
      const { event, limits } = await prisma.$transaction(async (tx) => {
        const current = await tx.scheduleEvent.findUnique({ where: { id: eventId }, select: { id: true, type: true, practicumId: true, bookedByStudentId: true } });
        if (!current) throw new AuthServiceError("INVALID_INPUT", "Schedule event does not exist");
        if (!BOOKABLE_TYPES.has(current.type)) throw new AuthServiceError("INVALID_INPUT", "This event type cannot be booked");
        if (current.bookedByStudentId) throw new AuthServiceError("AUTH_CONFLICT", "This slot is already booked");
        const practicum = await tx.practicum.findUnique({ where: { id: current.practicumId }, select: { backtestSlotLimit: true, preSessionSlotLimit: true } });
        const limits: BookingLimits = { backtestSlotLimit: practicum?.backtestSlotLimit ?? 1, preSessionSlotLimit: practicum?.preSessionSlotLimit ?? 1 };
        const limit = slotLimitForType(current.type, limits) ?? 0;
        // Per-student, per-type limit configured by the curator (Practicum.backtestSlotLimit/
        // preSessionSlotLimit) — a count against that limit, not a one-time existence check,
        // so it can be raised later without code changes.
        const bookedCount = await tx.scheduleEvent.count({ where: { type: current.type, bookedByStudentId: actorId } });
        if (bookedCount >= limit) throw new AuthServiceError("INVALID_INPUT", "You have already used all your available slots of this type");
        const updated = await tx.scheduleEvent.update({
          where: { id: eventId },
          data: { bookedByStudentId: actorId, bookedAt: new Date() },
          include: { mediaAssets: true, bookedBy: { include: { externalIdentities: { orderBy: { createdAt: "asc" }, take: 1 } } } },
        });
        await tx.scheduleBooking.create({
          data: { practicumId: current.practicumId, eventId, eventType: current.type, eventTitle: updated.title, eventDate: updated.date, eventTime: updated.time, studentId: actorId, action: ScheduleBookingAction.BOOKED, actorId },
        });
        return { event: updated, limits };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return this.toDto(event, actorId, limits);
    } catch (error) {
      if (error instanceof AuthServiceError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        throw new AuthServiceError("AUTH_CONFLICT", "This slot was just booked by someone else. Refresh the schedule");
      }
      throw error;
    }
  }

  public async cancelBooking(actorId: string, eventId: string) {
    const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { role: true, status: true } });
    if (!actor || actor.status !== UserStatus.ACTIVE) throw new AuthServiceError("SESSION_INVALID", "User is not active");
    const current = await prisma.scheduleEvent.findUnique({ where: { id: eventId }, select: { id: true, type: true, practicumId: true, bookedByStudentId: true } });
    if (!current) throw new AuthServiceError("INVALID_INPUT", "Schedule event does not exist");
    if (!current.bookedByStudentId) throw new AuthServiceError("INVALID_INPUT", "This slot is not booked");
    const isSelf = current.bookedByStudentId === actorId;
    const isCuratorOverride = actor.role === UserRole.CURATOR || actor.role === UserRole.OWNER;
    if (!isSelf && !isCuratorOverride) throw new AuthServiceError("FORBIDDEN", "Only the student who booked this slot or a curator can cancel it");
    const bookedStudentId = current.bookedByStudentId;
    const { event, limits } = await prisma.$transaction(async (tx) => {
      const updated = await tx.scheduleEvent.update({
        where: { id: eventId },
        data: { bookedByStudentId: null, bookedAt: null },
        include: { mediaAssets: true, bookedBy: { include: { externalIdentities: { orderBy: { createdAt: "asc" }, take: 1 } } } },
      });
      await tx.scheduleBooking.create({
        data: { practicumId: current.practicumId, eventId, eventType: current.type, eventTitle: updated.title, eventDate: updated.date, eventTime: updated.time, studentId: bookedStudentId, action: ScheduleBookingAction.CANCELLED, actorId },
      });
      const practicum = await tx.practicum.findUnique({ where: { id: current.practicumId }, select: { backtestSlotLimit: true, preSessionSlotLimit: true } });
      const limits: BookingLimits = { backtestSlotLimit: practicum?.backtestSlotLimit ?? 1, preSessionSlotLimit: practicum?.preSessionSlotLimit ?? 1 };
      return { event: updated, limits };
    });
    return this.toDto(event, actorId, limits);
  }

  public async create(actorId: string, input: ScheduleEventInput) {
    await this.assertCurator(actorId);
    const activePracticumId = await getActivePracticumId();
    if (!activePracticumId) throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");
    const practicum = await prisma.practicum.findUnique({ where: { id: activePracticumId }, select: { id: true, backtestSlotLimit: true, preSessionSlotLimit: true } });
    if (!practicum) throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");
    const event = await prisma.scheduleEvent.create({ data: { ...this.eventFields(input), practicumId: practicum.id } });
    const eventDate = new Intl.DateTimeFormat("ru-RU").format(event.date);
    void activeStudentEmails(practicum.id)
      .then((emails) => Promise.all(emails.map((to) => sendNewEventNotification({ to, eventTitle: event.title, eventDate, eventId: event.id }))))
      .catch((error: unknown) => console.error("Schedule recipient lookup failed", error instanceof Error ? error.message : "unknown error"));
    void activeStudentIds(practicum.id)
      .then((studentIds) => notificationService.createMany(studentIds, "NEW_EVENT", `Новое событие: ${event.title}`, `${eventDate}`, event.id))
      .catch((error: unknown) => console.error("Schedule notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
    return this.toDto(event, actorId, { backtestSlotLimit: practicum.backtestSlotLimit, preSessionSlotLimit: practicum.preSessionSlotLimit });
  }

  /** No practicum-equality gate — a curator can edit an event from any practicum, finished cohorts included. */
  public async update(actorId: string, eventId: string, input: ScheduleEventInput) {
    await this.assertCurator(actorId);
    const existing = await prisma.scheduleEvent.findUnique({ where: { id: requiredText(eventId, "eventId", 100) }, select: { practicumId: true } });
    if (!existing) throw new AuthServiceError("INVALID_INPUT", "Schedule event does not exist");
    const event = await prisma.scheduleEvent.update({ where: { id: eventId }, data: this.eventFields(input) }).catch(() => null);
    if (!event) throw new AuthServiceError("INVALID_INPUT", "Schedule event does not exist");
    const limits = await this.practicumBookingLimits(existing.practicumId);
    return this.toDto(event, actorId, limits);
  }

  /** No practicum-equality gate — a curator can delete an event from any practicum, finished cohorts included. */
  public async remove(actorId: string, eventId: string) {
    await this.assertCurator(actorId);
    const normalizedEventId = requiredText(eventId, "eventId", 100);
    const existing = await prisma.scheduleEvent.findUnique({ where: { id: normalizedEventId }, select: { id: true } });
    if (!existing) throw new AuthServiceError("INVALID_INPUT", "Schedule event does not exist");
    const deleted = await prisma.scheduleEvent.delete({ where: { id: normalizedEventId } }).catch(() => null);
    if (!deleted) throw new AuthServiceError("INVALID_INPUT", "Schedule event does not exist");
    return { id: deleted.id };
  }

  private eventFields(input: ScheduleEventInput) {
    if (!Object.values(ScheduleEventType).includes(input.type)) throw new AuthServiceError("INVALID_INPUT", "type is invalid");
    const data = {
      type: input.type,
      title: requiredText(input.title, "title", 180),
      date: parseDate(input.date),
      time: requiredText(input.time, "time", 80),
      description: requiredText(input.description, "description", 5_000),
      live: input.live ?? input.type === ScheduleEventType.PRACTICE,
      coverPath: input.coverPath?.trim().slice(0, 500) || null,
    };
    return data;
  }

  private toDto(event: {
    id: string; type: ScheduleEventType; title: string; date: Date; time: string; description: string; live: boolean; coverPath: string | null;
    mediaAssets?: Array<{ id: string; title: string | null; provider: string; providerKey: string; status: MediaAssetStatus }>;
    bookedByStudentId?: string | null;
    bookedBy?: { externalIdentities: Array<{ displayName: string | null; username: string | null }> } | null;
  }, actorId?: string, limits?: BookingLimits) {
    const media = (event.mediaAssets ?? []).map(mediaDto);
    const bookedByIdentity = event.bookedBy?.externalIdentities[0];
    return {
      id: event.id,
      type: event.type,
      typeLabel: eventTypeLabels[event.type],
      title: event.title,
      date: dateString(event.date),
      time: event.time,
      description: event.description,
      live: event.live,
      coverPath: event.coverPath,
      recordingAvailable: media.some((item) => item.status === MediaAssetStatus.PUBLISHED),
      recordings: media,
      bookedByStudentId: event.bookedByStudentId ?? null,
      bookedByStudentName: bookedByIdentity?.displayName ?? bookedByIdentity?.username ?? null,
      isBookedByActor: Boolean(actorId) && event.bookedByStudentId === actorId,
      slotLimit: limits ? slotLimitForType(event.type, limits) : null,
    };
  }

  private async practicumBookingLimits(practicumId: string): Promise<BookingLimits> {
    const practicum = await prisma.practicum.findUnique({ where: { id: practicumId }, select: { backtestSlotLimit: true, preSessionSlotLimit: true } });
    return { backtestSlotLimit: practicum?.backtestSlotLimit ?? 1, preSessionSlotLimit: practicum?.preSessionSlotLimit ?? 1 };
  }

  public async getBookingSettings(actorId: string): Promise<BookingLimits> {
    await this.assertCurator(actorId);
    const practicumId = await this.curatorPracticumId();
    return this.practicumBookingLimits(practicumId);
  }

  public async updateBookingSettings(actorId: string, input: { backtestSlotLimit: number; preSessionSlotLimit: number }): Promise<BookingLimits> {
    await this.assertCurator(actorId);
    const practicumId = await this.curatorPracticumId();
    const backtestSlotLimit = this.clampSlotLimit(input.backtestSlotLimit);
    const preSessionSlotLimit = this.clampSlotLimit(input.preSessionSlotLimit);
    const practicum = await prisma.practicum.update({ where: { id: practicumId }, data: { backtestSlotLimit, preSessionSlotLimit }, select: { backtestSlotLimit: true, preSessionSlotLimit: true } });
    return practicum;
  }

  private clampSlotLimit(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_SLOT_LIMIT || value > MAX_SLOT_LIMIT) {
      throw new AuthServiceError("INVALID_INPUT", `Slot limit must be an integer between ${MIN_SLOT_LIMIT} and ${MAX_SLOT_LIMIT}`);
    }
    return value;
  }

  /** For the curator's student card — the student's current bookings plus their full book/cancel history, scoped to the STUDENT's own practicum (their enrollment), not the curator's active one — a finished cohort's student still has their real booking history. */
  public async getStudentBookingHistory(actorId: string, studentId: string) {
    await this.assertCurator(actorId);
    const enrollment = await prisma.enrollment.findFirst({ where: { studentId }, orderBy: { createdAt: "asc" }, select: { practicumId: true } });
    if (!enrollment) throw new AuthServiceError("INVALID_INPUT", "Student is not enrolled in a practicum");
    const practicumId = enrollment.practicumId;
    const [current, history] = await Promise.all([
      prisma.scheduleEvent.findMany({
        where: { practicumId, bookedByStudentId: studentId },
        orderBy: [{ date: "asc" }, { time: "asc" }],
        select: { id: true, type: true, title: true, date: true, time: true },
      }),
      prisma.scheduleBooking.findMany({
        where: { practicumId, studentId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);
    return {
      current: current.map((event) => ({ id: event.id, type: event.type, typeLabel: eventTypeLabels[event.type], title: event.title, date: dateString(event.date), time: event.time })),
      history: history.map((entry) => ({
        id: entry.id,
        eventType: entry.eventType,
        typeLabel: eventTypeLabels[entry.eventType],
        eventTitle: entry.eventTitle,
        eventDate: dateString(entry.eventDate),
        eventTime: entry.eventTime,
        action: entry.action,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }

  private async assertCurator(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
    if (!user || user.status !== UserStatus.ACTIVE || (user.role !== UserRole.CURATOR && user.role !== UserRole.OWNER)) throw new AuthServiceError("FORBIDDEN", "Curator access required");
  }

  private async assertActiveUser(userId: string, role: UserRole) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
    if (!user || user.status !== UserStatus.ACTIVE || user.role !== role) throw new AuthServiceError("FORBIDDEN", "Student access required");
  }

  private async curatorPracticumId(): Promise<string> {
    const practicumId = await getActivePracticumId();
    if (!practicumId) throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");
    return practicumId;
  }
}

export const scheduleService = new ScheduleService();
