import { prisma } from "@/app/server/db";

/**
 * Per-practicum "private stream" switch — see Practicum.streamsPrivate for why this is a
 * per-cohort column rather than a global singleton like notification-settings.ts. Kept
 * dependency-free (just prisma) so stream-service.ts and the NestJS-layer
 * stream-live-notifier.ts can both read it without importing each other.
 */
export async function isStreamPrivate(practicumId: string): Promise<boolean> {
  const practicum = await prisma.practicum.findUnique({ where: { id: practicumId }, select: { streamsPrivate: true } });
  return practicum?.streamsPrivate ?? false;
}
