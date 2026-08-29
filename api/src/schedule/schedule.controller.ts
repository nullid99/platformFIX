import { BadRequestException, Body, ConflictException, Controller, Delete, Get, InternalServerErrorException, Param, Post, Put, Req, UnauthorizedException, ForbiddenException } from "@nestjs/common";
import type { Request } from "express";
import { AUTH_COOKIE_NAMES, AuthServiceError, authService } from "@/app/server/auth";
import { scheduleService } from "@/app/server/schedule";
import { parseBookingSettingsBody, parseScheduleEventBody } from "./schedule-input";

type RequestWithCookies = Request & { cookies?: Record<string, string | undefined> };

function mapError(error: unknown): never {
  if (!(error instanceof AuthServiceError)) throw new InternalServerErrorException("Schedule operation failed");
  if (error.code === "FORBIDDEN") throw new ForbiddenException(error.message);
  if (error.code === "INVALID_INPUT") throw new BadRequestException(error.message);
  if (error.code === "AUTH_CONFLICT") throw new ConflictException(error.message);
  throw new UnauthorizedException("Session is invalid or expired");
}

async function sessionUser(request: RequestWithCookies): Promise<string> {
  const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
  if (!token) throw new UnauthorizedException("Session is required");
  return (await authService.validateSession(token)).userId;
}

@Controller("schedule")
export class ScheduleController {
  @Get()
  public async list(@Req() request: RequestWithCookies) {
    try { return { data: await scheduleService.getForUser(await sessionUser(request)) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  @Post()
  public async create(@Req() request: RequestWithCookies, @Body() body: unknown) {
    try { return { data: await scheduleService.create(await sessionUser(request), parseScheduleEventBody(body)) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); if (error instanceof BadRequestException) throw error; throw error; }
  }

  @Get("settings")
  public async getSettings(@Req() request: RequestWithCookies) {
    try { return { data: await scheduleService.getBookingSettings(await sessionUser(request)) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  @Put("settings")
  public async updateSettings(@Req() request: RequestWithCookies, @Body() body: unknown) {
    try { return { data: await scheduleService.updateBookingSettings(await sessionUser(request), parseBookingSettingsBody(body)) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); if (error instanceof BadRequestException) throw error; throw error; }
  }

  @Put(":eventId")
  public async update(@Req() request: RequestWithCookies, @Param("eventId") eventId: string, @Body() body: unknown) {
    try { return { data: await scheduleService.update(await sessionUser(request), eventId, parseScheduleEventBody(body)) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); if (error instanceof BadRequestException) throw error; throw error; }
  }

  @Delete(":eventId")
  public async remove(@Req() request: RequestWithCookies, @Param("eventId") eventId: string) {
    try { return { data: await scheduleService.remove(await sessionUser(request), eventId) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  @Post(":eventId/book")
  public async book(@Req() request: RequestWithCookies, @Param("eventId") eventId: string) {
    try { return { data: await scheduleService.book(await sessionUser(request), eventId) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  @Post(":eventId/cancel-booking")
  public async cancelBooking(@Req() request: RequestWithCookies, @Param("eventId") eventId: string) {
    try { return { data: await scheduleService.cancelBooking(await sessionUser(request), eventId) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }
}
