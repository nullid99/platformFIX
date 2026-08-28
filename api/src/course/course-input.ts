import { BadRequestException } from "@nestjs/common";
import { MediaAssetKind } from "../../../app/generated/prisma/enums";

export type CreateModuleBody = {
  title: string;
  description?: string;
  section?: string;
  coverPath?: string;
};

export type CreateVimeoMediaBody = {
  moduleId?: string;
  scheduleEventId?: string;
  title: string;
  description?: string;
  kind: MediaAssetKind;
  vimeoUrl: string;
};

export type UpdateMediaKindBody = {
  kind: MediaAssetKind;
  moduleId?: string;
  scheduleEventId?: string;
};

function text(value: unknown, field: string, maximumLength: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") throw new BadRequestException(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) throw new BadRequestException(`${field} is invalid`);
  return normalized;
}

function optionalText(value: unknown, field: string, maximumLength: number): string | undefined {
  return text(value, field, maximumLength, true);
}

export function parseCreateModuleBody(value: unknown): CreateModuleBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("body must be an object");
  }

  const body = value as Record<string, unknown>;
  const coverPath = optionalText(body.coverPath, "coverPath", 500);
  if (coverPath && !coverPath.startsWith("/")) throw new BadRequestException("coverPath must be a local public path");

  return {
    title: text(body.title, "title", 180)!,
    description: optionalText(body.description, "description", 5_000),
    section: optionalText(body.section, "section", 40),
    coverPath,
  };
}

export function parseCreateVimeoMediaBody(value: unknown): CreateVimeoMediaBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("body must be an object");
  }

  const body = value as Record<string, unknown>;
  const kind = body.kind;
  if (!Object.values(MediaAssetKind).includes(kind as MediaAssetKind)) {
    throw new BadRequestException("kind is invalid");
  }

  const moduleId = text(body.moduleId, "moduleId", 100, true);
  const scheduleEventId = text(body.scheduleEventId, "scheduleEventId", 100, true);
  if (kind !== MediaAssetKind.TALKS && !moduleId && !scheduleEventId) throw new BadRequestException("moduleId is required unless media is linked to a schedule event");

  return {
    moduleId,
    scheduleEventId,
    title: text(body.title, "title", 180)!,
    description: text(body.description, "description", 2_000, true),
    kind: kind as MediaAssetKind,
    vimeoUrl: text(body.vimeoUrl, "vimeoUrl", 2_000)!,
  };
}

export function parseUpdateMediaKindBody(value: unknown): UpdateMediaKindBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("body must be an object");
  }

  const body = value as Record<string, unknown>;
  const kind = body.kind;
  if (!Object.values(MediaAssetKind).includes(kind as MediaAssetKind)) {
    throw new BadRequestException("kind is invalid");
  }

  const moduleId = text(body.moduleId, "moduleId", 100, true);
  const scheduleEventId = text(body.scheduleEventId, "scheduleEventId", 100, true);
  if (kind !== MediaAssetKind.TALKS && !moduleId && !scheduleEventId) throw new BadRequestException("moduleId is required unless media is linked to a schedule event");

  return { kind: kind as MediaAssetKind, moduleId, scheduleEventId };
}
