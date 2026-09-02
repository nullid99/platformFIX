import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, InternalServerErrorException, Param, Post, Put, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { Request, Response } from "express";
import { AUTH_COOKIE_NAMES, AuthServiceError, authService } from "@/app/server/auth";
import { streamChatService, streamService, webhookReceiver } from "@/app/server/streams";

type RequestWithCookies = Request & { cookies?: Record<string, string | undefined> };

function mapError(error: unknown): never {
  if (!(error instanceof AuthServiceError)) throw new InternalServerErrorException("Stream operation failed");
  if (error.code === "FORBIDDEN") throw new ForbiddenException(error.message);
  if (error.code === "INVALID_INPUT") throw new BadRequestException(error.message);
  throw new UnauthorizedException("Session is invalid or expired");
}

async function sessionUser(request: RequestWithCookies): Promise<string> {
  const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
  if (!token) throw new UnauthorizedException("Session is required");
  return (await authService.validateSession(token)).userId;
}

@Controller("streams")
export class StreamsController {
  @Get("live-input")
  public async get(@Req() request: RequestWithCookies) {
    try { return { data: await streamService.getIngress(await sessionUser(request)) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  @Post("live-input")
  public async create(@Req() request: RequestWithCookies) {
    try { return { data: await streamService.ensureIngress(await sessionUser(request)) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  @Get("status")
  public async status(@Req() request: RequestWithCookies) {
    try { return { data: await streamService.getPlaybackStatus(await sessionUser(request)) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  @Get("target")
  public async getTarget(@Req() request: RequestWithCookies) {
    try { return { data: await streamService.getStreamTarget(await sessionUser(request)) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  @Put("target")
  public async setTarget(@Req() request: RequestWithCookies, @Body() body: { moduleId?: unknown; scheduleEventId?: unknown; mediaKind?: unknown }) {
    try {
      const moduleId = typeof body?.moduleId === "string" ? body.moduleId : null;
      const scheduleEventId = typeof body?.scheduleEventId === "string" ? body.scheduleEventId : null;
      const mediaKind = body?.mediaKind === "QA" ? "QA" : body?.mediaKind === "STREAM" ? "STREAM" : null;
      return { data: await streamService.setStreamTarget(await sessionUser(request), { moduleId, scheduleEventId, mediaKind }) };
    } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  @Get("media/:mediaId/chat")
  public async getMediaChat(@Req() request: RequestWithCookies, @Param("mediaId") mediaId: string) {
    try { return { data: await streamChatService.getArchivedMessages(await sessionUser(request), mediaId) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  /** The player's `src`/`embedUrl` points here rather than at a static MinIO URL — a presigned S3 URL expires, so it can only be minted per-request, right before the redirect. */
  @Get("recordings/:mediaId/play")
  public async playRecording(@Req() request: RequestWithCookies, @Param("mediaId") mediaId: string, @Res() response: Response) {
    try {
      const url = await streamService.getRecordingPlaybackUrl(await sessionUser(request), mediaId);
      response.redirect(302, url);
    } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  /** Same reasoning as playRecording above, for the cover image shown in the recordings grid. */
  @Get("recordings/:mediaId/thumbnail")
  public async recordingThumbnail(@Req() request: RequestWithCookies, @Param("mediaId") mediaId: string, @Res() response: Response) {
    try {
      const url = await streamService.getRecordingThumbnailUrl(await sessionUser(request), mediaId);
      response.redirect(302, url);
    } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  /** Curator-only — see getRecordingDownloadUrl for why this exists as a separate route from playRecording rather than a query param on it. */
  @Get("recordings/:mediaId/download")
  public async downloadRecording(@Req() request: RequestWithCookies, @Param("mediaId") mediaId: string, @Res() response: Response) {
    try {
      const url = await streamService.getRecordingDownloadUrl(await sessionUser(request), mediaId);
      response.redirect(302, url);
    } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  /** Called by our self-hosted LiveKit server, not by our own frontend — authenticated via the SDK's own JWT check, not a session cookie. Body arrives as a raw Buffer in request.body (see main.ts's dedicated application/webhook+json parser for this route). The livekit-server-sdk's own "Authorize" constant and LiveKit's general docs disagree on the exact header name in the wild, so both are accepted here. */
  @Post("livekit-webhook")
  @HttpCode(200)
  public async livekitWebhook(@Req() request: Request, @Headers("authorize") authorizeHeader: string | undefined, @Headers("authorization") authorizationHeader: string | undefined) {
    if (!Buffer.isBuffer(request.body)) { console.error("LiveKit webhook received with no raw body"); return { received: false }; }
    try {
      const event = await webhookReceiver().receive(request.body.toString("utf8"), authorizeHeader || authorizationHeader);
      await streamService.handleLiveKitWebhookEvent(event);
    } catch (error) {
      console.error("LiveKit webhook verification/handling failed", error instanceof Error ? error.message : "unknown error", "headers:", JSON.stringify(request.headers));
      throw new UnauthorizedException("Invalid webhook signature");
    }
    return { received: true };
  }
}
