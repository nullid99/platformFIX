import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  InternalServerErrorException,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  NotFoundException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
  AUTH_COOKIE_NAMES,
  AuthServiceError,
  authService,
  getAuthCookies,
  getExpiredAuthCookies,
  isLocalTestAuthEnabled,
} from "@/app/server/auth";
import {
  IdentityProvider,
  UserRole,
} from "@/app/generated/prisma/enums";
import { isDiscordUserId } from "@/app/domain/discord";
import { getRequestContext } from "../common/request-context";

type RequestWithCookies = Request & {
  cookies?: Record<string, string | undefined>;
};

type InvitationBody = {
  email?: unknown;
  role?: unknown;
  expiresInHours?: unknown;
  targetProvider?: unknown;
  targetSubject?: unknown;
  practicumId?: unknown;
};

type DevLoginBody = {
  role?: unknown;
};

type ProfileBody = {
  email?: unknown;
};

function getBodyString(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximumLength) : undefined;
}

 

function parseRole(value: unknown): UserRole {
  if (value === UserRole.STUDENT || value === UserRole.CURATOR) return value;
  throw new BadRequestException("role must be STUDENT or CURATOR");
}

function parseProvider(value: unknown): IdentityProvider | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === IdentityProvider.DISCORD) return value;
  throw new BadRequestException("targetProvider is invalid");
}

function parseDiscordSubject(value: unknown): string {
  const subject = typeof value === "string" ? value.trim() : "";
  if (!isDiscordUserId(subject)) {
    throw new BadRequestException("A valid Discord user ID is required");
  }
  return subject;
}

function parseExpiry(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) throw new BadRequestException("expiresInHours must be an integer");
  return parsed;
}

function mapAuthError(error: unknown): never {
  if (!(error instanceof AuthServiceError)) {
    throw new InternalServerErrorException("Authentication operation failed");
  }

  switch (error.code) {
    case "FORBIDDEN":
      throw new ForbiddenException(error.message);
    case "INVALID_INPUT":
      throw new BadRequestException(error.message);
    case "SESSION_INVALID":
      throw new UnauthorizedException("Session is invalid or expired");
    case "INVALID_INVITATION":
    case "INVITATION_EXPIRED":
    case "INVITATION_BOUND_TO_ANOTHER_ACCOUNT":
    case "ACCOUNT_SUSPENDED":
    case "ROLE_CONFLICT":
      throw new BadRequestException(error.message);
    default:
      throw new InternalServerErrorException("Authentication operation failed");
  }
}

@Controller("auth")
export class AuthController {
  @Get("session")
  public async getSession(@Req() request: RequestWithCookies) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");

    try {
      return { data: await authService.validateSession(token) };
    } catch (error) {
      mapAuthError(error);
    }
  }

  @Post("invitations")
  public async createInvitation(
    @Req() request: RequestWithCookies,
    @Body() body: InvitationBody,
  ) {
    const session = await this.requireSession(request);
    if (session.role !== UserRole.OWNER && session.role !== UserRole.CURATOR) throw new ForbiddenException("Curator access required");

    const targetSubject = parseDiscordSubject(body.targetSubject);
    const requestedProvider = parseProvider(body.targetProvider);
    if (requestedProvider && requestedProvider !== IdentityProvider.DISCORD) {
      throw new BadRequestException("Invitations are currently bound to Discord accounts");
    }
    const targetProvider = IdentityProvider.DISCORD;

    try {
      const invitation = await authService.createInvitation({
        actorId: session.userId,
        ...getRequestContext(request),
        role: parseRole(body.role),
        email: getBodyString(body.email, 320),
        expiresInHours: parseExpiry(body.expiresInHours),
        targetProvider,
        targetSubject,
        practicumId: getBodyString(body.practicumId, 100),
      });

      return { data: invitation };
    } catch (error) {
      mapAuthError(error);
    }
  }

  @Patch("profile")
  public async updateProfile(
    @Req() request: RequestWithCookies,
    @Body() body: ProfileBody,
  ) {
    const session = await this.requireSession(request);
    if (body.email !== undefined && body.email !== null && typeof body.email !== "string") {
      throw new BadRequestException("email must be a string");
    }

    try {
      const profile = await authService.updateOwnEmail(
        session.userId,
        body.email === null ? "" : getBodyString(body.email, 320) ?? "",
      );
      return { data: profile };
    } catch (error) {
      mapAuthError(error);
    }
  }

  @Get("verify-email")
  public async verifyEmail(@Query("token") token: string | undefined) {
    if (!token) throw new BadRequestException("Verification token is required");
    try {
      return { data: await authService.verifyEmail(token) };
    } catch (error) {
      mapAuthError(error);
    }
  }

  @Post("logout")
  @HttpCode(204)
  public async logout(
    @Req() request: RequestWithCookies,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (token) {
      try {
        await authService.revokeSession(token);
      } catch (error) {
        if (!(error instanceof AuthServiceError)) mapAuthError(error);
      }
    }

    this.setCookies(response, getExpiredAuthCookies());
  }

  @Post("dev-login")
  public async devLogin(
    @Req() request: RequestWithCookies,
    @Body() body: DevLoginBody,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!isLocalTestAuthEnabled()) {
      throw new NotFoundException();
    }

    try {
      const result = await authService.loginWithLocalTestIdentity(parseRole(body.role), {
        ...getRequestContext(request),
        deviceKey: request.cookies?.[AUTH_COOKIE_NAMES.device],
      });

      this.setCookies(response, getAuthCookies(result.session));
      return { data: { userId: result.userId, role: result.role } };
    } catch (error) {
      mapAuthError(error);
    }
  }

  private async requireSession(request: RequestWithCookies) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");

    try {
      return await authService.validateSession(token);
    } catch (error) {
      mapAuthError(error);
    }
  }

  private setCookies(response: Response, cookies: ReturnType<typeof getAuthCookies>): void {
    for (const cookie of cookies) {
      response.cookie(cookie.name, cookie.value, cookie.options);
    }
  }
}
