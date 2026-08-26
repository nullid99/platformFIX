import { Prisma } from "@/app/generated/prisma/client";
import { EnrollmentStatus, MediaAssetStatus, ScheduleEventType, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { AuthServiceError } from "@/app/server/auth";
import { prisma } from "@/app/server/db";
import { activeStudentEmails, activeStudentIds } from "@/app/server/notifications/recipient-service";
import { sendNewEventNotification } from "@/app/server/notifications/email-service";
import { notificationService } from "@/app/server/notifications/notification-service";

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
};

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
  } else if (media.provider.toUpperCase() === "CLOUDFLARE_STREAM") {
    const [subdomain, uid] = media.providerKey.split("/");
    if (subdomain && uid) {
      embedUrl = `https://${subdomain}/${uid}/iframe`;
      thumbnailUrl = `https://${subdomain}/${uid}/thumbnails/thumbnail.jpg`;
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
    const practicumId = enrollment?.practicumId ?? (await prisma.practicum.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } }))?.id;
    if (!practicumId) throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");

    const events = await prisma.scheduleEvent.findMany({
      where: { practicumId },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      include: {
        mediaAssets: { where: user.role === UserRole.STUDENT ? { status: MediaAssetStatus.PUBLISHED } : undefined, orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
        bookedBy: { include: { externalIdentities: { orderBy: { createdAt: "asc" }, take: 1 } } },
      },
    });
    return events.map((event) => this.toDto(event, userId));
  }

  public async book(actorId: string, eventId: string) {
    await this.assertActiveUser(actorId, UserRole.STUDENT);
    try {
      const event = await prisma.$transaction(async (tx) => {
        const current = await tx.scheduleEvent.findUnique({ where: { id: eventId }, select: { id: true, type: true, bookedByStudentId: true } });
        if (!current) throw new AuthServiceError("INVALID_INPUT", "Schedule event does not exist");
        if (current.type !== ScheduleEventType.BACKTEST) throw new AuthServiceError("INVALID_INPUT", "Only backtest slots can be booked");
        if (current.bookedByStudentId) throw new AuthServiceError("AUTH_CONFLICT", "This slot is already booked");
        // One individual call per student for the whole practicum — checked against ANY
        // event they hold, not just this one, since the call is a one-time resource.
        const existingBooking = await tx.scheduleEvent.findFirst({ where: { type: ScheduleEventType.BACKTEST, bookedByStudentId: actorId }, select: { id: true } });
        if (existingBooking) throw new AuthServiceError("INVALID_INPUT", "You already booked your one backtest call");
        return tx.scheduleEvent.update({
          where: { id: eventId },
          data: { bookedByStudentId: actorId, bookedAt: new Date() },
          include: { mediaAssets: true, bookedBy: { include: { externalIdentities: { orderBy: { createdAt: "asc" }, take: 1 } } } },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return this.toDto(event, actorId);
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
    const current = await prisma.scheduleEvent.findUnique({ where: { id: eventId }, select: { id: true, bookedByStudentId: true } });
    if (!current) throw new AuthServiceError("INVALID_INPUT", "Schedule event does not exist");
    const isSelf = current.bookedByStudentId === actorId;
    const isCuratorOverride = actor.role === UserRole.CURATOR || actor.role === UserRole.OWNER;
    if (!isSelf && !isCuratorOverride) throw new AuthServiceError("FORBIDDEN", "Only the student who booked this slot or a curator can cancel it");
    const event = await prisma.scheduleEvent.update({
      where: { id: eventId },
      data: { bookedByStudentId: null, bookedAt: null },
      include: { mediaAssets: true, bookedBy: { include: { externalIdentities: { orderBy: { createdAt: "asc" }, take: 1 } } } },
    });
    return this.toDto(event, actorId);
  }

  public async create(actorId: string, input: ScheduleEventInput) {
    await this.assertCurator(actorId);
    const practicum = await prisma.practicum.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
    if (!practicum) throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");
    const event = await prisma.scheduleEvent.create({ data: { ...this.eventFields(input), practicumId: practicum.id } });
    const eventDate = new Intl.DateTimeFormat("ru-RU").format(event.date);
    void activeStudentEmails(practicum.id)
      .then((emails) => Promise.all(emails.map((to) => sendNewEventNotification({ to, eventTitle: event.title, eventDate, eventId: event.id }))))
      .catch((error: unknown) => console.error("Schedule recipient lookup failed", error instanceof Error ? error.message : "unknown error"));
    void activeStudentIds(practicum.id)
      .then((studentIds) => notificationService.createMany(studentIds, "NEW_EVENT", `Новое событие: ${event.title}`, `${eventDate}`, event.id))
      .catch((error: unknown) => console.error("Schedule notification dispatch failed", error instanceof Error ? error.message : "unknown error"));
    return this.toDto(event, actorId);
  }

  public async update(actorId: string, eventId: string, input: ScheduleEventInput) {
    await this.assertCurator(actorId);
    const practicumId = await this.curatorPracticumId();
    const existing = await prisma.scheduleEvent.findUnique({ where: { id: requiredText(eventId, "eventId", 100) }, select: { practicumId: true } });
    if (!existing || existing.practicumId !== practicumId) throw new AuthServiceError("INVALID_INPUT", "Schedule event does not exist");
    const event = await prisma.scheduleEvent.update({ where: { id: eventId }, data: this.eventFields(input) }).catch(() => null);
    if (!event) throw new AuthServiceError("INVALID_INPUT", "Schedule event does not exist");
    return this.toDto(event, actorId);
  }

  public async remove(actorId: string, eventId: string) {
    await this.assertCurator(actorId);
    const practicumId = await this.curatorPracticumId();
    const normalizedEventId = requiredText(eventId, "eventId", 100);
    const existing = await prisma.scheduleEvent.findUnique({ where: { id: normalizedEventId }, select: { practicumId: true } });
    if (!existing || existing.practicumId !== practicumId) throw new AuthServiceError("INVALID_INPUT", "Schedule event does not exist");
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
  }, actorId?: string) {
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
    const practicum = await prisma.practicum.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
    if (!practicum) throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");
    return practicum.id;
  }
}

export const scheduleService = new ScheduleService();
