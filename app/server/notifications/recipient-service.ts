import { EnrollmentStatus, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";

function uniqueEmails(values: Array<string | null>): string[] {
  return [...new Set(values.map((value) => value?.trim().toLowerCase()).filter((value): value is string => Boolean(value)))];
}

export async function activeStudentEmails(practicumId: string): Promise<string[]> {
  const enrollments = await prisma.enrollment.findMany({
    where: {
      practicumId,
      status: EnrollmentStatus.ACTIVE,
      OR: [{ accessUntil: null }, { accessUntil: { gt: new Date() } }],
      student: { status: UserStatus.ACTIVE, role: UserRole.STUDENT, email: { not: null } },
    },
    select: { student: { select: { email: true } } },
  });
  return uniqueEmails(enrollments.map((enrollment) => enrollment.student.email));
}

export async function activeStudentIds(practicumId: string): Promise<string[]> {
  const enrollments = await prisma.enrollment.findMany({
    where: {
      practicumId,
      status: EnrollmentStatus.ACTIVE,
      OR: [{ accessUntil: null }, { accessUntil: { gt: new Date() } }],
      student: { status: UserStatus.ACTIVE, role: UserRole.STUDENT },
    },
    select: { studentId: true },
  });
  return [...new Set(enrollments.map((enrollment) => enrollment.studentId))];
}

export async function activeCuratorEmails(curatorId?: string): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: {
      status: UserStatus.ACTIVE,
      role: { in: [UserRole.CURATOR, UserRole.OWNER] },
      email: { not: null },
      ...(curatorId ? { id: curatorId } : {}),
    },
    select: { email: true },
  });
  return uniqueEmails(users.map((user) => user.email));
}

export async function activeCuratorIds(): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: { status: UserStatus.ACTIVE, role: { in: [UserRole.CURATOR, UserRole.OWNER] } },
    select: { id: true },
  });
  return users.map((user) => user.id);
}

export async function userEmail(userId: string): Promise<string | undefined> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, status: true } });
  return user?.status === UserStatus.ACTIVE ? user.email?.trim().toLowerCase() || undefined : undefined;
}
