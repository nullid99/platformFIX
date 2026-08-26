import { BadRequestException, Controller, ForbiddenException, Get, Headers, HttpCode, InternalServerErrorException, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { AUTH_COOKIE_NAMES, AuthServiceError, authService } from "@/app/server/auth";
import { streamService, verifyStreamWebhookSignature } from "@/app/server/streams";

type RequestWithCookies = Request & { cookies?: Record<string, string | undefined> };
type RequestWithRawBody = Request & { rawBody?: Buffer };

type StreamWebhookPayload = {
  uid?: string;
  readyToStream?: boolean;
  playback?: { hls?: string; dash?: string };
};

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
    try { return { data: await streamService.getLiveInput(await sessionUser(request)) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  @Post("live-input")
  public async create(@Req() request: RequestWithCookies) {
    try { return { data: await streamService.ensureLiveInput(await sessionUser(request)) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  @Get("status")
  public async status(@Req() request: RequestWithCookies) {
    try { return { data: await streamService.getPlaybackStatus(await sessionUser(request)) }; } catch (error) { if (error instanceof AuthServiceError) mapError(error); throw error; }
  }

  /** Called by Cloudflare, not by our own frontend — authenticated via HMAC signature, not a session cookie. */
  @Post("webhook")
  @HttpCode(200)
  public async webhook(@Req() request: RequestWithRawBody, @Headers("webhook-signature") signatureHeader: string | undefined) {
    const secret = process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET?.trim();
    if (!secret) { console.error("Stream webhook received but CLOUDFLARE_STREAM_WEBHOOK_SECRET is not configured"); return { received: false }; }
    if (!request.rawBody || !verifyStreamWebhookSignature(signatureHeader, request.rawBody, secret)) {
      throw new UnauthorizedException("Invalid webhook signature");
    }

    const payload = request.body as StreamWebhookPayload;
    if (payload.readyToStream && payload.uid) {
      await streamService.handleRecordingReady({ videoUid: payload.uid, playbackUrl: payload.playback?.hls ?? payload.playback?.dash });
    }
    return { received: true };
  }
}
