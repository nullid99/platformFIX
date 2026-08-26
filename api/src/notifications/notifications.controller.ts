import { Controller, Get, InternalServerErrorException, Param, Post, Req, UnauthorizedException, ForbiddenException } from "@nestjs/common";
import type { Request } from "express";
import { AUTH_COOKIE_NAMES, AuthServiceError, authService } from "@/app/server/auth";
import { notificationService } from "@/app/server/notifications/notification-service";

type RequestWithCookies = Request & { cookies?: Record<string, string | undefined> };

function mapError(error: unknown): never {
  if (!(error instanceof AuthServiceError)) throw new InternalServerErrorException("Notification operation failed");
  if (error.code === "FORBIDDEN") throw new ForbiddenException(error.message);
  throw new UnauthorizedException("Session is invalid or expired");
}

async function sessionUser(request: RequestWithCookies): Promise<string> {
  const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
  if (!token) throw new UnauthorizedException("Session is required");
  return (await authService.validateSession(token)).userId;
}

@Controller("notifications")
export class NotificationsController {
  @Get()
  public async list(@Req() request: RequestWithCookies) {
    try { return { data: await notificationService.listForUser(await sessionUser(request)) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  @Post(":notificationId/read")
  public async markRead(@Req() request: RequestWithCookies, @Param("notificationId") notificationId: string) {
    const userId = await sessionUser(request);
    await notificationService.markRead(userId, notificationId);
    return { data: { status: "READ" } };
  }

  @Post("read-all")
  public async markAllRead(@Req() request: RequestWithCookies) {
    const userId = await sessionUser(request);
    await notificationService.markAllRead(userId);
    return { data: { status: "READ" } };
  }
}
