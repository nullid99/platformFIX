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
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { AUTH_COOKIE_NAMES, AuthServiceError, authService } from "@/app/server/auth";
import { UserRole } from "@/app/generated/prisma/enums";
import { assignmentService } from "@/app/server/assignments";
import { scheduleService } from "@/app/server/schedule";

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
  public async getStudents(@Req() request: RequestWithCookies, @Query("practicumId") practicumId?: string) {
    const session = await this.requireSession(request);

    try {
      return { data: await authService.getStudentDirectory(session.userId, { practicumId }) };
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

  @Patch(":studentId/advanced")
  public async updateStudentAdvanced(
    @Req() request: RequestWithCookies,
    @Param("studentId") studentId: string,
    @Body() body: { isAdvanced?: unknown },
  ) {
    const session = await this.requireSession(request);
    const isAdvanced = body.isAdvanced === true;
    try {
      return { data: { isAdvanced: await authService.setStudentAdvanced(session.userId, studentId, isAdvanced) } };
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

  @Get(":studentId/bookings")
  public async getStudentBookings(@Req() request: RequestWithCookies, @Param("studentId") studentId: string) {
    const session = await this.requireSession(request);
    try {
      return { data: await scheduleService.getStudentBookingHistory(session.userId, studentId) };
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

  /**
   * Owner-only student <-> curator switch. Path stays under /security/students for both
   * directions (the :userId is just an id, not required to already be a student) so the same
   * endpoint serves the button on both the "Ученики" and "Команда" profile cards.
   */
  @Post(":userId/role")
  public async setRole(
    @Req() request: RequestWithCookies,
    @Param("userId") userId: string,
    @Body() body: { role?: unknown },
  ) {
    const session = await this.requireSession(request);
    if (session.role !== UserRole.OWNER) throw new ForbiddenException("Owner access required");
    if (body.role !== "STUDENT" && body.role !== "CURATOR") throw new BadRequestException("role must be STUDENT or CURATOR");

    try {
      return { data: await authService.setUserRole(session.userId, userId, body.role) };
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

  /** Owner or curator — permanent, unlike suspend. Client is expected to confirm with the human first. */
  @Post(":studentId/delete")
  public async deleteStudent(
    @Req() request: RequestWithCookies,
    @Param("studentId") studentId: string,
  ) {
    const session = await this.requireSession(request);
    try {
      await authService.deleteStudent(session.userId, studentId);
      return { data: { deleted: true } };
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

/**
 * Owner-only staff-security roster: a curator's devices are no longer reachable from
 * /security/students once they're promoted (getStudentSecurityOverview/assertCanManage*
 * on the student side reject a non-student target), so this is where a stuck 3rd-device
 * approval for a curator gets granted. Session approve/revoke reuse the exact same
 * authService calls as the student controller — assertCanManageDeviceSecurity there already
 * accepts any target role, only the *listing/overview* endpoints needed a staff-side home.
 */
@Controller("security/team")
export class TeamSecurityController {
  @Get()
  public async getTeam(@Req() request: RequestWithCookies) {
    const session = await this.requireSession(request);
    try {
      return { data: await authService.getTeamDirectory(session.userId) };
    } catch (error) {
      mapSecurityError(error);
    }
  }

  @Get(":memberId")
  public async getTeamMemberSecurity(@Req() request: RequestWithCookies, @Param("memberId") memberId: string) {
    const session = await this.requireSession(request);
    try {
      return { data: await authService.getTeamMemberSecurityOverview(session.userId, memberId) };
    } catch (error) {
      mapSecurityError(error);
    }
  }

  /** Owner-only — promotes a curator to a full, undifferentiated owner. See auth-service.ts#grantOwnerRole. */
  @Post(":memberId/grant-owner")
  public async grantOwner(@Req() request: RequestWithCookies, @Param("memberId") memberId: string) {
    const session = await this.requireSession(request);
    if (session.role !== UserRole.OWNER) throw new ForbiddenException("Owner access required");
    try {
      return { data: await authService.grantOwnerRole(session.userId, memberId) };
    } catch (error) {
      mapSecurityError(error);
    }
  }

  /** Owner-only — demotes another owner back to curator. See auth-service.ts#revokeOwnerRole for the three guards (self, protected owner, last remaining owner). */
  @Post(":memberId/revoke-owner")
  public async revokeOwner(@Req() request: RequestWithCookies, @Param("memberId") memberId: string) {
    const session = await this.requireSession(request);
    if (session.role !== UserRole.OWNER) throw new ForbiddenException("Owner access required");
    try {
      return { data: await authService.revokeOwnerRole(session.userId, memberId) };
    } catch (error) {
      mapSecurityError(error);
    }
  }

  @Post(":memberId/revoke-sessions")
  public async revokeAllSessions(
    @Req() request: RequestWithCookies,
    @Param("memberId") memberId: string,
    @Body() body: { reason?: unknown },
  ) {
    const session = await this.requireSession(request);
    if (session.role !== UserRole.OWNER) throw new ForbiddenException("Owner access required");
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "Owner action";
    if (!reason) throw new ForbiddenException("A reason is required");
    try {
      const revokedCount = await authService.revokeUserSessions(session.userId, memberId, reason);
      return { data: { revokedCount } };
    } catch (error) {
      mapSecurityError(error);
    }
  }

  @Post(":memberId/sessions/:sessionId/revoke")
  public async revokeSession(
    @Req() request: RequestWithCookies,
    @Param("memberId") memberId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: { reason?: unknown },
  ) {
    const session = await this.requireSession(request);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "Security review";
    if (!reason) throw new ForbiddenException("A reason is required");
    try {
      await authService.revokeUserSession(session.userId, memberId, sessionId, reason);
      return { data: { revoked: true } };
    } catch (error) {
      mapSecurityError(error);
    }
  }

  @Post(":memberId/sessions/:sessionId/approve")
  public async approveSession(
    @Req() request: RequestWithCookies,
    @Param("memberId") memberId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: { reason?: unknown },
  ) {
    const session = await this.requireSession(request);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "Security review";
    if (!reason) throw new ForbiddenException("A reason is required");
    try {
      await authService.approveUserSession(session.userId, memberId, sessionId, reason);
      return { data: { approved: true } };
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
