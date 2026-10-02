import { Body, Controller, Get, InternalServerErrorException, Param, Post, Put, Req, UnauthorizedException, ForbiddenException, BadRequestException } from "@nestjs/common";
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

  /** The one global switch — see PlatformSettings in schema.prisma for why it isn't per-practicum. */
  @Get("settings")
  public async getSettings(@Req() request: RequestWithCookies) {
    try { return { data: await notificationService.getGlobalSettings(await sessionUser(request)) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  @Put("settings")
  public async updateSettings(@Req() request: RequestWithCookies, @Body() body: { notificationsEnabled?: unknown }) {
    if (typeof body?.notificationsEnabled !== "boolean") throw new BadRequestException("notificationsEnabled must be a boolean");
    try { return { data: await notificationService.updateGlobalSettings(await sessionUser(request), body.notificationsEnabled) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  /** Curator/owner only, personal — which categories additionally email this specific curator (see getEmailPreferences on the service). */
  @Get("email-preferences")
  public async getEmailPreferences(@Req() request: RequestWithCookies) {
    try { return { data: await notificationService.getEmailPreferences(await sessionUser(request)) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  @Put("email-preferences")
  public async updateEmailPreferences(@Req() request: RequestWithCookies, @Body() body: { notifyNewSubmission?: unknown; notifyNewQuestion?: unknown }) {
    if (body?.notifyNewSubmission !== undefined && typeof body.notifyNewSubmission !== "boolean") throw new BadRequestException("notifyNewSubmission must be a boolean");
    if (body?.notifyNewQuestion !== undefined && typeof body.notifyNewQuestion !== "boolean") throw new BadRequestException("notifyNewQuestion must be a boolean");
    try {
      return { data: await notificationService.updateEmailPreferences(await sessionUser(request), { notifyNewSubmission: body.notifyNewSubmission, notifyNewQuestion: body.notifyNewQuestion }) };
    } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }
}
