import type { Prisma } from "@/app/generated/prisma/client";
import { EnrollmentStatus } from "@/app/generated/prisma/enums";
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

/**
 * True once a curator/owner has hit "Завершить поток" (Practicum.completedAt set) — the signal
 * every write path (assignment submission, discussion create/reply) checks and refuses on, while
 * every read path stays untouched. See the field's own doc comment in schema.prisma for why this
 * is a separate flag from Enrollment/Practicum.accessUntil rather than reusing either.
 */
export async function isPracticumCompleted(practicumId: string, client: DatabaseClient = prisma): Promise<boolean> {
  const practicum = await client.practicum.findUnique({ where: { id: practicumId }, select: { completedAt: true } });
  return Boolean(practicum?.completedAt);
}

/**
 * A student's own current practicum (their one ACTIVE, unexpired enrollment) plus whether it's
 * been marked completed — the single lookup listForStudent-style DTO builders need to stamp a
 * `practicumCompleted` flag on every row without a second round-trip per item. Null when the
 * student has no active enrollment at all (matches every other "active, unexpired" check in the
 * codebase — see course-service.ts#getForUser's activeEnrollmentFilter).
 */
export async function getStudentActivePracticum(studentId: string, client: DatabaseClient = prisma): Promise<{ id: string; completedAt: Date | null } | null> {
  const enrollment = await client.enrollment.findFirst({
    where: { studentId, status: EnrollmentStatus.ACTIVE, OR: [{ accessUntil: null }, { accessUntil: { gt: new Date() } }] },
    orderBy: { createdAt: "desc" },
    select: { practicum: { select: { id: true, completedAt: true } } },
  });
  return enrollment?.practicum ?? null;
}
