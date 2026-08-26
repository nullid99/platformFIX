import { BadRequestException } from "@nestjs/common";

export type AssignmentMaterialInput =
  | { kind: "LINK"; title: string; url: string }
  | { kind: "FILE"; title: string; fileId: string };

export function parseAssignmentMaterials(value: unknown, optional = false): AssignmentMaterialInput[] | undefined {
  if (value === undefined && optional) return undefined;
  if (!Array.isArray(value)) throw new BadRequestException("materials must be an array");

  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new BadRequestException("material must be an object");
    }
    const candidate = item as Record<string, unknown>;
    if (candidate.kind !== "LINK" && candidate.kind !== "FILE") {
      throw new BadRequestException("material kind is invalid");
    }
    if (typeof candidate.title !== "string") {
      throw new BadRequestException("material title must be a string");
    }
    if (candidate.kind === "LINK" && typeof candidate.url !== "string") {
      throw new BadRequestException("material url must be a string");
    }
    if (candidate.kind === "FILE" && typeof candidate.fileId !== "string") {
      throw new BadRequestException("material fileId must be a string");
    }
    return candidate.kind === "LINK"
      ? { kind: "LINK" as const, title: candidate.title, url: candidate.url as string }
      : { kind: "FILE" as const, title: candidate.title, fileId: candidate.fileId as string };
  });
}
