import { EnrollmentStatus, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { AuthServiceError } from "@/app/server/auth";
import { prisma } from "@/app/server/db";

/** Curator/owner always; a student only if actively enrolled in a practicum. */
export async function assertPracticumViewer(userId: string): Promise<{ practicumId: string; role: UserRole }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
  if (!user || user.status !== UserStatus.ACTIVE) throw new AuthServiceError("SESSION_INVALID", "User is not active");

  if (user.role === UserRole.CURATOR || user.role === UserRole.OWNER) {
    const practicum = await prisma.practicum.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
    if (!practicum) throw new AuthServiceError("INVALID_INPUT", "Practicum is not configured");
    return { practicumId: practicum.id, role: user.role };
  }

  const enrollment = await prisma.enrollment.findFirst({
    where: { studentId: userId, status: EnrollmentStatus.ACTIVE, OR: [{ accessUntil: null }, { accessUntil: { gt: new Date() } }] },
    orderBy: { createdAt: "asc" },
    select: { practicumId: true },
  });
  if (!enrollment) throw new AuthServiceError("FORBIDDEN", "Student is not enrolled in a practicum");
  return { practicumId: enrollment.practicumId, role: user.role };
}
