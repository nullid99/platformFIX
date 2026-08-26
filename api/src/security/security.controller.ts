import {
  Body,
  BadRequestException,
  Controller,
  ConflictException,
  ForbiddenException,
  Get,
  Patch,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { AUTH_COOKIE_NAMES, AuthServiceError, authService } from "@/app/server/auth";
import { UserRole } from "@/app/generated/prisma/enums";
import { assignmentService } from "@/app/server/assignments";

type RequestWithCookies = Request & {
  cookies?: Record<string, string | undefined>;
};

function mapSecurityError(error: unknown): never {
  if (error instanceof AuthServiceError && error.code === "FORBIDDEN") {
    throw new ForbiddenException(error.message);
  }
  if (error instanceof AuthServiceError && error.code === "INVALID_INPUT") {
    throw new BadRequestException(error.message);
  }
  if (error instanceof AuthServiceError && error.code === "AUTH_CONFLICT") {
    throw new ConflictException(error.message);
  }

  throw error;
}

@Controller("security/students")
export class SecurityController {
  @Get()
  public async getStudents(@Req() request: RequestWithCookies) {
    const session = await this.requireSession(request);

    try {
      return { data: await authService.getStudentDirectory(session.userId) };
    } catch (error) {
      mapSecurityError(error);
    }
  }

  @Get("/curators")
  public async getCurators(@Req() request: RequestWithCookies) {
    const session = await this.requireSession(request);

    try {
      return { data: await authService.getCuratorDirectory(session.userId) };
    } catch (error) {
      mapSecurityError(error);
    }
  }

  @Get(":studentId")
  public async getStudentSecurity(
    @Req() request: RequestWithCookies,
    @Param("studentId") studentId: string,
  ) {
    const session = await this.requireSession(request);

    try {
      return {
        data: await authService.getStudentSecurityOverview(session.userId, studentId),
      };
    } catch (error) {
      mapSecurityError(error);
    }
  }

  @Patch(":studentId/email")
  public async updateStudentEmail(
    @Req() request: RequestWithCookies,
    @Param("studentId") studentId: string,
    @Body() body: { email?: unknown },
  ) {
    const session = await this.requireSession(request);
    const email = typeof body.email === "string" ? body.email.slice(0, 320) : "";
    try {
      return { data: { email: await authService.updateStudentEmail(session.userId, studentId, email) } };
    } catch (error) {
      mapSecurityError(error);
    }
  }

  @Post(":studentId/claim")
  public async claimStudent(
    @Req() request: RequestWithCookies,
    @Param("studentId") studentId: string,
  ) {
    const session = await this.requireSession(request);
    try {
      return { data: await authService.claimStudent(session.userId, studentId) };
    } catch (error) {
      mapSecurityError(error);
    }
  }

  @Patch(":studentId/assignment")
  public async transferStudent(
    @Req() request: RequestWithCookies,
    @Param("studentId") studentId: string,
    @Body() body: { curatorId?: unknown },
  ) {
    const session = await this.requireSession(request);
    const curatorId = typeof body.curatorId === "string" ? body.curatorId.slice(0, 100) : "";

    try {
      return { data: await authService.transferStudent(session.userId, studentId, curatorId) };
    } catch (error) {
      mapSecurityError(error);
    }
  }

  @Get(":studentId/assignments")
  public async getStudentAssignments(@Req() request: RequestWithCookies, @Param("studentId") studentId: string) {
    const session = await this.requireSession(request);
    try {
      return { data: await assignmentService.listStudentHistory(session.userId, studentId) };
    } catch (error) {
      mapSecurityError(error);
    }
  }

  @Post(":studentId/revoke-sessions")
  public async revokeSessions(
    @Req() request: RequestWithCookies,
    @Param("studentId") studentId: string,
    @Body() body: { reason?: unknown },
  ) {
    const session = await this.requireSession(request);
    if (session.role !== UserRole.OWNER) throw new ForbiddenException("Owner access required");

    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "Owner action";
    if (!reason) throw new ForbiddenException("A reason is required");

    try {
      const revokedCount = await authService.revokeUserSessions(session.userId, studentId, reason);
      return { data: { revokedCount } };
    } catch (error) {
      mapSecurityError(error);
    }
  }

  @Post(":studentId/sessions/:sessionId/revoke")
  public async revokeSession(
    @Req() request: RequestWithCookies,
    @Param("studentId") studentId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: { reason?: unknown },
  ) {
    const session = await this.requireSession(request);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "Security review";
    if (!reason) throw new ForbiddenException("A reason is required");
    try {
      await authService.revokeUserSession(session.userId, studentId, sessionId, reason);
      return { data: { revoked: true } };
    } catch (error) {
      mapSecurityError(error);
    }
  }

  @Post(":studentId/sessions/:sessionId/approve")
  public async approveSession(
    @Req() request: RequestWithCookies,
    @Param("studentId") studentId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: { reason?: unknown },
  ) {
    const session = await this.requireSession(request);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "Security review";
    if (!reason) throw new ForbiddenException("A reason is required");
    try {
      await authService.approveUserSession(session.userId, studentId, sessionId, reason);
      return { data: { approved: true } };
    } catch (error) {
      mapSecurityError(error);
    }
  }

  @Post(":studentId/suspend")
  public async suspendStudent(
    @Req() request: RequestWithCookies,
    @Param("studentId") studentId: string,
    @Body() body: { reason?: unknown },
  ) {
    const session = await this.requireSession(request);
    if (session.role !== UserRole.OWNER) throw new ForbiddenException("Owner access required");

    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "Owner action";
    if (!reason) throw new ForbiddenException("A reason is required");

    try {
      await authService.suspendUser(session.userId, studentId, reason);
      return { data: { status: "SUSPENDED" } };
    } catch (error) {
      mapSecurityError(error);
    }
  }

  private async requireSession(request: RequestWithCookies) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");

    try {
      return await authService.validateSession(token);
    } catch {
      throw new UnauthorizedException("Session is invalid or expired");
    }
  }
}
