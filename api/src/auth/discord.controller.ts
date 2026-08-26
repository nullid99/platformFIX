import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
  AUTH_COOKIE_NAMES,
  AuthServiceError,
  authService,
  discordOAuthService,
  getAuthCookies,
  getDiscordStateCookie,
  getExpiredDiscordStateCookie,
  isOpaqueToken,
} from "@/app/server/auth";
import { getRequestContext } from "../common/request-context";

type RequestWithCookies = Request & {
  cookies?: Record<string, string | undefined>;
};

function getWebOrigin(): string {
  return process.env.WEB_ORIGIN ?? "http://localhost:3000";
}

function getErrorRedirect(reason = "failed"): string {
  return `${getWebOrigin()}/?auth=${reason}`;
}

@Controller("auth/discord")
export class DiscordController {
  @Get("start")
  public async start(
    @Query("invite") invitationToken: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    try {
      if (invitationToken && !isOpaqueToken(invitationToken, "invite")) {
        throw new BadRequestException("Invitation is invalid");
      }

      const challenge = await discordOAuthService.createChallenge(invitationToken);
      const stateCookie = getDiscordStateCookie(challenge.state);
      response.cookie(stateCookie.name, stateCookie.value, stateCookie.options);
      response.redirect(challenge.authorizationUrl);
    } catch {
      response.redirect(getErrorRedirect());
    }
  }

  @Get("callback")
  public async callback(
    @Req() request: RequestWithCookies,
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") discordError: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const stateCookie = request.cookies?.[AUTH_COOKIE_NAMES.discordState];

    try {
      if (discordError || !code || !state || !stateCookie || state !== stateCookie) {
        throw new AuthServiceError("DISCORD_AUTH_FAILED", "Discord callback validation failed");
      }

      const challenge = await discordOAuthService.consumeChallenge(state);
      const identity = await discordOAuthService.exchangeCode(code, challenge);
      const context = getRequestContext(request);
      const deviceKey = request.cookies?.[AUTH_COOKIE_NAMES.device];
      const result = challenge.invitationToken
        ? await authService.acceptInvitation({
            ...context,
            invitationToken: challenge.invitationToken,
            provider: identity.provider,
            providerSubject: identity.providerSubject,
            username: identity.username,
            displayName: identity.displayName,
            avatarUrl: identity.avatarUrl,
            deviceKey,
          })
        : await authService.loginWithIdentity({
            ...context,
            provider: identity.provider,
            providerSubject: identity.providerSubject,
            username: identity.username,
            displayName: identity.displayName,
            avatarUrl: identity.avatarUrl,
            deviceKey,
          });

      for (const cookie of getAuthCookies(result.session)) {
        response.cookie(cookie.name, cookie.value, cookie.options);
      }

      const expiredStateCookie = getExpiredDiscordStateCookie();
      response.cookie(expiredStateCookie.name, expiredStateCookie.value, expiredStateCookie.options);
      const authState = result.session.status === "PENDING" ? "device-pending" : "success";
      response.redirect(`${getWebOrigin()}/?auth=${authState}`);
    } catch (error) {
      const expiredStateCookie = getExpiredDiscordStateCookie();
      response.cookie(expiredStateCookie.name, expiredStateCookie.value, expiredStateCookie.options);
      const reason = error instanceof AuthServiceError && error.code === "INVALID_INVITATION"
        ? "invite-required"
        : "failed";
      response.redirect(getErrorRedirect(reason));
    }
  }
}
