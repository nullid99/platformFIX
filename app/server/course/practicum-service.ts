import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/app/server/db";

type DatabaseClient = typeof prisma | Prisma.TransactionClient;

/**
 * The practicum every new curator-side action (module, stream, schedule event, invitation)
 * targets by default. Deliberately dependency-free besides prisma — auth-service.ts is among the
 * callers, and it lives behind the same barrel this file would otherwise need to import errors
 * from, so this stays a leaf module nothing can form an import cycle through. Each caller already
 * has its own AuthServiceError import and throws it itself when this returns null.
 * Accepts an optional transaction client so a caller already inside a `$transaction` (e.g.
 * auth-service.ts accepting an invitation) reads a consistent snapshot instead of a separate
 * connection.
 */
export async function getActivePracticumId(client: DatabaseClient = prisma): Promise<string | null> {
  const practicum = await client.practicum.findFirst({ where: { isActive: true }, select: { id: true } });
  return practicum?.id ?? null;
}

/**
 * The practicum a specific curator/owner is currently creating content in — their personal
 * User.workingPracticumId, falling back to the active practicum when they haven't picked one
 * (new accounts, or before this feature existed). This is what every content-creation resolver
 * (module, schedule event, standalone media, invitation default) should call — NOT
 * getActivePracticumId, which is reserved for live-stream targeting only. Same dependency-free,
 * transaction-aware shape as getActivePracticumId, for the same reason (see its own comment).
 */
export async function getWorkingPracticumId(userId: string, client: DatabaseClient = prisma): Promise<string | null> {
  const user = await client.user.findUnique({ where: { id: userId }, select: { workingPracticumId: true } });
  if (user?.workingPracticumId) {
    const stillExists = await client.practicum.findUnique({ where: { id: user.workingPracticumId }, select: { id: true } });
    if (stillExists) return stillExists.id;
  }
  return getActivePracticumId(client);
}
