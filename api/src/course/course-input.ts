import { BadRequestException } from "@nestjs/common";
import { MediaAssetKind, MediaAudience } from "../../../app/generated/prisma/enums";

export type CreateModuleBody = {
  title: string;
  description?: string;
  section?: string;
  coverPath?: string;
  mediaGroups?: string[];
};

export type CreateVimeoMediaBody = {
  moduleId?: string;
  scheduleEventId?: string;
  groupId?: string;
  title: string;
  description?: string;
  kind: MediaAssetKind;
  audience?: MediaAudience;
  vimeoUrl: string;
};

export type UpdateMediaKindBody = {
  kind: MediaAssetKind;
  audience?: MediaAudience;
  moduleId?: string;
  scheduleEventId?: string;
  groupId?: string;
};

function parseAudience(value: unknown): MediaAudience | undefined {
  return value === MediaAudience.ADVANCED ? MediaAudience.ADVANCED : undefined;
}

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
  let mediaGroups: string[] | undefined;
  if (body.mediaGroups !== undefined) {
    if (!Array.isArray(body.mediaGroups) || !body.mediaGroups.every((item) => typeof item === "string")) {
      throw new BadRequestException("mediaGroups must be an array of strings");
    }
    mediaGroups = body.mediaGroups;
  }

  return {
    title: text(body.title, "title", 180)!,
    description: optionalText(body.description, "description", 5_000),
    section: optionalText(body.section, "section", 40),
    coverPath,
    mediaGroups,
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
  const groupId = text(body.groupId, "groupId", 100, true);
  if (kind !== MediaAssetKind.TALKS && !moduleId && !scheduleEventId) throw new BadRequestException("moduleId is required unless media is linked to a schedule event");

  return {
    moduleId,
    scheduleEventId,
    groupId,
    title: text(body.title, "title", 180)!,
    description: text(body.description, "description", 2_000, true),
    kind: kind as MediaAssetKind,
    audience: parseAudience(body.audience),
    vimeoUrl: text(body.vimeoUrl, "vimeoUrl", 2_000)!,
  };
}

export function parseCreateMediaGroupBody(value: unknown): { title: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("body must be an object");
  }
  const body = value as Record<string, unknown>;
  return { title: text(body.title, "title", 80)! };
}

export function parseRenameMediaBody(value: unknown): { title: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("body must be an object");
  }

  const body = value as Record<string, unknown>;
  return { title: text(body.title, "title", 180)! };
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
  const groupId = text(body.groupId, "groupId", 100, true);
  if (kind !== MediaAssetKind.TALKS && !moduleId && !scheduleEventId) throw new BadRequestException("moduleId is required unless media is linked to a schedule event");

  return { kind: kind as MediaAssetKind, audience: parseAudience(body.audience), moduleId, scheduleEventId, groupId };
}
