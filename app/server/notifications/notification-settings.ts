import { prisma } from "@/app/server/db";

const SETTINGS_ID = "singleton";

/**
 * One global switch, not tied to any Practicum — see PlatformSettings in schema.prisma. Kept
 * dependency-free (just prisma) like module-access.ts, since both notification-service.ts and
 * email-service.ts need it and neither should import the other.
 */
export async function areNotificationsEnabled(): Promise<boolean> {
  const settings = await prisma.platformSettings.findUnique({ where: { id: SETTINGS_ID }, select: { notificationsEnabled: true } });
  // No row only happens if the migration's seed insert was somehow lost — default to on rather
  // than silently going deaf.
  return settings?.notificationsEnabled ?? true;
}

export async function setNotificationsEnabled(enabled: boolean): Promise<boolean> {
  const settings = await prisma.platformSettings.upsert({
    where: { id: SETTINGS_ID },
    update: { notificationsEnabled: enabled },
    create: { id: SETTINGS_ID, notificationsEnabled: enabled },
    select: { notificationsEnabled: true },
  });
  return settings.notificationsEnabled;
}
