import "dotenv/config";
import { IdentityProvider, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { seedOpenModuleAccess } from "@/app/server/course/module-access";

const confirmation = process.env.BOOTSTRAP_LOCAL_TEST_USERS_CONFIRM;

async function ensureLocalUser(role: UserRole, subject: string, username: string, displayName: string): Promise<string> {
  const existingIdentity = await prisma.externalIdentity.findUnique({
    where: { provider_providerSubject: { provider: IdentityProvider.LOCAL, providerSubject: subject } },
    select: { userId: true },
  });

  if (existingIdentity) {
    await prisma.user.update({ where: { id: existingIdentity.userId }, data: { role, status: UserStatus.ACTIVE } });
    return existingIdentity.userId;
  }

  const user = await prisma.user.create({
    data: {
      role,
      status: UserStatus.ACTIVE,
      externalIdentities: { create: { provider: IdentityProvider.LOCAL, providerSubject: subject, username, displayName } },
    },
    select: { id: true },
  });
  return user.id;
}

async function main(): Promise<void> {
  if (confirmation !== "I_UNDERSTAND_STAGING_TEST_USERS") {
    throw new Error("Set BOOTSTRAP_LOCAL_TEST_USERS_CONFIRM to the exact confirmation phrase");
  }

  const practicum = await prisma.practicum.findFirst({ where: { isActive: true }, select: { id: true } });
  if (!practicum) throw new Error("Bootstrap the course before creating local test users");

  await ensureLocalUser(UserRole.CURATOR, "local-curator", "local-curator", "Тестовый куратор");
  const studentId = await ensureLocalUser(UserRole.STUDENT, "local-student", "local-student", "Тестовый ученик");

  const enrollment = await prisma.enrollment.upsert({
    where: { studentId_practicumId: { studentId, practicumId: practicum.id } },
    update: { status: "ACTIVE" },
    create: { studentId, practicumId: practicum.id, status: "ACTIVE" },
    select: { id: true },
  });
  // Real students only ever get an Enrollment via the invitation-accept path, which also
  // seeds EnrollmentModuleAccess for every module marked open-by-default (see auth-service.ts).
  // This script creates the Enrollment directly, so it has to seed access the same way —
  // otherwise the test student is enrolled but locked out of every module (isModuleOpenForStudent
  // in module-access.ts returns false with no access row), and e.g. a freshly published
  // assignment never appears in "Задания" for them.
  await seedOpenModuleAccess(prisma, enrollment.id, practicum.id);

  console.log("Local staging test users are ready");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Local test user bootstrap failed");
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
