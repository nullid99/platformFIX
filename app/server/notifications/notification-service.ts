import { NotificationType, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { AuthServiceError } from "@/app/server/auth";

const MAX_LIST = 30;

export class NotificationService {
  public async create(userId: string, type: NotificationType, title: string, body?: string, entityId?: string): Promise<void> {
    await prisma.notification.create({ data: { userId, type, title, body, entityId } });
  }

  public async createMany(userIds: readonly string[], type: NotificationType, title: string, body?: string, entityId?: string): Promise<void> {
    if (userIds.length === 0) return;
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
}

export const notificationService = new NotificationService();
