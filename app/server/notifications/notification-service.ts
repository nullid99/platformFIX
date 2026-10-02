import { NotificationType, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { AuthServiceError } from "@/app/server/auth";
import { areNotificationsEnabled, setNotificationsEnabled } from "./notification-settings";

const MAX_LIST = 30;

export type CuratorEmailPreferences = { notifyNewSubmission: boolean; notifyNewQuestion: boolean };

// A curator's "pause everything" switch (see PlatformSettings) is for content-change noise —
// stream/media/assignment/module chatter — while they migrate recordings between cohorts.
// Account security stays on regardless: a new-device alert going silent because someone was
// mid-migration would be a much worse outcome than one extra email.
const ALWAYS_DELIVERED: ReadonlySet<NotificationType> = new Set([NotificationType.SECURITY_ALERT]);

export class NotificationService {
  public async create(userId: string, type: NotificationType, title: string, body?: string, entityId?: string): Promise<void> {
    if (!ALWAYS_DELIVERED.has(type) && !(await areNotificationsEnabled())) return;
    await prisma.notification.create({ data: { userId, type, title, body, entityId } });
  }

  public async createMany(userIds: readonly string[], type: NotificationType, title: string, body?: string, entityId?: string): Promise<void> {
    if (userIds.length === 0) return;
    if (!ALWAYS_DELIVERED.has(type) && !(await areNotificationsEnabled())) return;
    await prisma.notification.createMany({ data: userIds.map((userId) => ({ userId, type, title, body, entityId })) });
  }

  public async listForUser(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    if (!user || user.status !== UserStatus.ACTIVE) throw new AuthServiceError("FORBIDDEN", "User is not active");
    const [items, unreadCount] = await Promise.all([
      prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: MAX_LIST }),
      prisma.notification.count({ where: { userId, read: false } }),
    ]);
    return { items, unreadCount };
  }

  public async markRead(userId: string, notificationId: string): Promise<void> {
    await prisma.notification.updateMany({ where: { id: notificationId, userId }, data: { read: true } });
  }

  public async markAllRead(userId: string): Promise<void> {
    await prisma.notification.updateMany({ where: { userId, read: false }, data: { read: true } });
  }

  /** Curator/owner only — backs the toggle in the dashboard settings. */
  public async getGlobalSettings(actorId: string): Promise<{ notificationsEnabled: boolean }> {
    await this.assertCurator(actorId);
    return { notificationsEnabled: await areNotificationsEnabled() };
  }

  public async updateGlobalSettings(actorId: string, enabled: boolean): Promise<{ notificationsEnabled: boolean }> {
    await this.assertCurator(actorId);
    return { notificationsEnabled: await setNotificationsEnabled(enabled) };
  }

  /**
   * Curator/owner only, personal — which categories additionally send this specific curator an
   * email. The bell (create/createMany above) always fires regardless of this; it only gates the
   * extra channel, same split as the global switch above but per-person instead of platform-wide.
   */
  public async getEmailPreferences(actorId: string): Promise<CuratorEmailPreferences> {
    await this.assertCurator(actorId);
    return prisma.user.findUniqueOrThrow({ where: { id: actorId }, select: { notifyNewSubmission: true, notifyNewQuestion: true } });
  }

  public async updateEmailPreferences(actorId: string, input: Partial<CuratorEmailPreferences>): Promise<CuratorEmailPreferences> {
    await this.assertCurator(actorId);
    const data: Partial<CuratorEmailPreferences> = {};
    if (input.notifyNewSubmission !== undefined) data.notifyNewSubmission = input.notifyNewSubmission;
    if (input.notifyNewQuestion !== undefined) data.notifyNewQuestion = input.notifyNewQuestion;
    return prisma.user.update({ where: { id: actorId }, data, select: { notifyNewSubmission: true, notifyNewQuestion: true } });
  }

  private async assertCurator(userId: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
    if (!user || user.status !== UserStatus.ACTIVE || (user.role !== UserRole.CURATOR && user.role !== UserRole.OWNER)) {
      throw new AuthServiceError("FORBIDDEN", "Curator access required");
    }
  }
}

export const notificationService = new NotificationService();
