import { BadRequestException } from "@nestjs/common";
import { ScheduleEventType } from "../../../app/generated/prisma/enums";
import type { ScheduleEventInput } from "../../../app/server/schedule/schedule-service";

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new BadRequestException(`${field} is invalid`);
  return value.trim();
}

export function parseScheduleEventBody(value: unknown): ScheduleEventInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException("body must be an object");
  const body = value as Record<string, unknown>;
  if (!Object.values(ScheduleEventType).includes(body.type as ScheduleEventType)) throw new BadRequestException("type is invalid");
  if (body.live !== undefined && typeof body.live !== "boolean") throw new BadRequestException("live must be a boolean");
  return { type: body.type as ScheduleEventType, title: text(body.title, "title", 180), date: text(body.date, "date", 10), time: text(body.time, "time", 80), description: text(body.description, "description", 5_000), live: body.live as boolean | undefined, coverPath: typeof body.coverPath === "string" ? body.coverPath.trim().slice(0, 500) : undefined };
}

export function parseBookingSettingsBody(value: unknown): { backtestSlotLimit: number; preSessionSlotLimit: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException("body must be an object");
  const body = value as Record<string, unknown>;
  if (typeof body.backtestSlotLimit !== "number") throw new BadRequestException("backtestSlotLimit is invalid");
  if (typeof body.preSessionSlotLimit !== "number") throw new BadRequestException("preSessionSlotLimit is invalid");
  return { backtestSlotLimit: body.backtestSlotLimit, preSessionSlotLimit: body.preSessionSlotLimit };
}
