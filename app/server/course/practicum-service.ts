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
