import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  InternalServerErrorException,
  Req,
  Param,
  Query,
  Body,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import type { Request } from "express";
import { AUTH_COOKIE_NAMES, AuthServiceError, authService } from "@/app/server/auth";
import { courseService, createNewPracticum, deletePracticum, getPracticumDeletionImpact, getStudentProgress, listPracticums, sendStudentReminder, setActivePracticum, setPracticumCompleted, setPracticumStreamsPrivate, setWorkingPracticum } from "@/app/server/course";
import { getRequestContext } from "../common/request-context";
import { parseCreateMediaGroupBody, parseCreateModuleBody, parseCreateVimeoMediaBody, parseRenameMediaBody, parseUpdateMediaKindBody } from "./course-input";

type RequestWithCookies = Request & { cookies?: Record<string, string | undefined> };

function mapError(error: unknown): never {
  if (!(error instanceof AuthServiceError)) throw new InternalServerErrorException("Course operation failed");
  if (error.code === "FORBIDDEN") throw new ForbiddenException(error.message);
  if (error.code === "INVALID_INPUT") throw new BadRequestException(error.message);
  throw new UnauthorizedException("Session is invalid or expired");
}

@Controller("course")
export class CourseController {
  @Get("manage")
  public async manage(@Req() request: RequestWithCookies, @Query("viewPracticumId") viewPracticumId?: string) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");

    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.getForCurator(session.userId, { viewPracticumId }) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      throw new UnauthorizedException("Session is invalid or expired");
    }
  }

  @Post("media")
  public async createMedia(@Req() request: RequestWithCookies, @Body() body: unknown) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");

    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.createVimeoMedia(session.userId, parseCreateVimeoMediaBody(body)) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException("Course media operation failed");
    }
  }

  @Post("modules")
  public async createModule(@Req() request: RequestWithCookies, @Body() body: unknown) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.createModule(session.userId, parseCreateModuleBody(body)) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException("Module creation failed");
    }
  }

  @Put("modules/:moduleId/media/reorder")
  public async reorderModuleMedia(@Req() request: RequestWithCookies, @Param("moduleId") moduleId: string, @Body() body: unknown) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    if (!body || typeof body !== "object" || !Array.isArray((body as { mediaIds?: unknown }).mediaIds) || !(body as { mediaIds: unknown[] }).mediaIds.every((id) => typeof id === "string")) {
      throw new BadRequestException("mediaIds is required");
    }
    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.reorderModuleMedia(session.userId, moduleId, (body as { mediaIds: string[] }).mediaIds) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException("Module media reorder failed");
    }
  }

  @Put("media/reorder")
  public async reorderMediaLibrary(@Req() request: RequestWithCookies, @Body() body: unknown) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    if (!body || typeof body !== "object" || !Array.isArray((body as { mediaIds?: unknown }).mediaIds) || !(body as { mediaIds: unknown[] }).mediaIds.every((id) => typeof id === "string")) {
      throw new BadRequestException("mediaIds is required");
    }
    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.reorderMediaLibrary(session.userId, (body as { mediaIds: string[] }).mediaIds) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException("Media library reorder failed");
    }
  }

  @Put("modules/:moduleId")
  public async updateModule(@Req() request: RequestWithCookies, @Param("moduleId") moduleId: string, @Body() body: unknown) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    if (!body || typeof body !== "object" || typeof (body as { title?: unknown }).title !== "string") throw new BadRequestException("title is required");
    const rawQaQuestions = (body as { qaQuestions?: unknown }).qaQuestions;
    if (rawQaQuestions !== undefined && (!Array.isArray(rawQaQuestions) || rawQaQuestions.some((item) => typeof item !== "string"))) {
      throw new BadRequestException("qaQuestions must be an array of strings");
    }
    try {
      const session = await authService.validateSession(token);
      const input = body as { title: string; description?: string; qaQuestions?: string[] };
      return { data: await courseService.updateModule(session.userId, moduleId, input) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException("Module update failed");
    }
  }

  @Delete("modules/:moduleId")
  public async deleteModule(@Req() request: RequestWithCookies, @Param("moduleId") moduleId: string) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.deleteModule(session.userId, moduleId) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      throw new InternalServerErrorException("Module deletion failed");
    }
  }

  @Post("modules/:moduleId/media-groups")
  public async createMediaGroup(@Req() request: RequestWithCookies, @Param("moduleId") moduleId: string, @Body() body: unknown) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.createMediaGroup(session.userId, moduleId, parseCreateMediaGroupBody(body).title) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException("Block creation failed");
    }
  }

  @Delete("media-groups/:groupId")
  public async deleteMediaGroup(@Req() request: RequestWithCookies, @Param("groupId") groupId: string) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.deleteMediaGroup(session.userId, groupId) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      throw new InternalServerErrorException("Block deletion failed");
    }
  }

  @Post("media/:mediaId/publish")
  public async publishMedia(@Req() request: RequestWithCookies, @Param("mediaId") mediaId: string) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");

    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.publishMedia(session.userId, mediaId) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      throw new InternalServerErrorException("Course media operation failed");
    }
  }

  @Delete("media/:mediaId")
  public async deleteMedia(@Req() request: RequestWithCookies, @Param("mediaId") mediaId: string) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");

    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.archiveMedia(session.userId, mediaId) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      throw new InternalServerErrorException("Course media deletion failed");
    }
  }

  @Put("media/:mediaId/module")
  public async attachMediaToModule(@Req() request: RequestWithCookies, @Param("mediaId") mediaId: string, @Body() body: unknown) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    if (!body || typeof body !== "object" || typeof (body as { moduleId?: unknown }).moduleId !== "string") throw new BadRequestException("moduleId is required");
    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.attachMediaToModule(session.userId, mediaId, (body as { moduleId: string }).moduleId) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      throw new InternalServerErrorException("Course media operation failed");
    }
  }

  @Put("media/:mediaId/kind")
  public async updateMediaKind(@Req() request: RequestWithCookies, @Param("mediaId") mediaId: string, @Body() body: unknown) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.updateMediaClassification(session.userId, mediaId, parseUpdateMediaKindBody(body)) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException("Course media operation failed");
    }
  }

  @Put("media/:mediaId/title")
  public async renameMedia(@Req() request: RequestWithCookies, @Param("mediaId") mediaId: string, @Body() body: unknown) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.renameMedia(session.userId, mediaId, parseRenameMediaBody(body).title) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException("Course media operation failed");
    }
  }

  @Post("media/:mediaId/access")
  public async recordMediaAccess(@Req() request: RequestWithCookies, @Param("mediaId") mediaId: string) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    try {
      const session = await authService.validateSession(token);
      const context = getRequestContext(request);
      await courseService.recordPlaybackEvent(session.userId, mediaId, context);
      return { data: { status: "RECORDED" } };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      throw new InternalServerErrorException("Playback logging failed");
    }
  }

  @Get("media/:mediaId/viewers")
  public async mediaViewers(@Req() request: RequestWithCookies, @Param("mediaId") mediaId: string) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.listMediaViewers(session.userId, mediaId) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      throw new InternalServerErrorException("Playback history lookup failed");
    }
  }

  @Post("modules/:moduleId/access")
  public async setModuleAccess(@Req() request: RequestWithCookies, @Param("moduleId") moduleId: string, @Body() body: unknown) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    try {
      const session = await authService.validateSession(token);
      if (!body || typeof body !== "object" || typeof (body as { unlocked?: unknown }).unlocked !== "boolean") throw new BadRequestException("unlocked is required");
      return { data: await courseService.setModuleAccess(session.userId, moduleId, (body as { unlocked: boolean }).unlocked) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException("Course access operation failed");
    }
  }

  @Post("modules/:moduleId/students/:studentId/access")
  public async setStudentModuleAccess(@Req() request: RequestWithCookies, @Param("moduleId") moduleId: string, @Param("studentId") studentId: string, @Body() body: unknown) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    try {
      const session = await authService.validateSession(token);
      if (!body || typeof body !== "object" || typeof (body as { unlocked?: unknown }).unlocked !== "boolean") throw new BadRequestException("unlocked is required");
      return { data: await courseService.setStudentModuleAccess(session.userId, studentId, moduleId, (body as { unlocked: boolean }).unlocked) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException("Course access operation failed");
    }
  }

  @Post("modules/:moduleId/students/:studentId/complete")
  public async markModuleCompletedForStudent(@Req() request: RequestWithCookies, @Param("moduleId") moduleId: string, @Param("studentId") studentId: string) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.markModuleCompletedForStudent(session.userId, studentId, moduleId) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      throw new InternalServerErrorException("Course access operation failed");
    }
  }

  @Post("modules/:moduleId/complete")
  public async markModuleCompletedForAllStudents(@Req() request: RequestWithCookies, @Param("moduleId") moduleId: string) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.markModuleCompletedForAllStudents(session.userId, moduleId) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      throw new InternalServerErrorException("Course access operation failed");
    }
  }

  @Get("students/:studentId/access")
  public async listStudentModuleAccess(@Req() request: RequestWithCookies, @Param("studentId") studentId: string) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.listStudentModuleAccess(session.userId, studentId) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      throw new InternalServerErrorException("Course access lookup failed");
    }
  }

  /** Owner-only — freezes the current practicum and starts a fresh one; every new module/stream/schedule event/invitation targets the new one from this point on. */
  @Post("practicum")
  public async startNewPracticum(@Req() request: RequestWithCookies, @Body() body: unknown) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    if (!body || typeof body !== "object" || typeof (body as { title?: unknown }).title !== "string") throw new BadRequestException("title is required");
    try {
      const session = await authService.validateSession(token);
      const input = body as { title: string; description?: string };
      return { data: await createNewPracticum(session.userId, input) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException("Starting a new practicum failed");
    }
  }

  /** Owner or curator — every past and present practicum (owners switch the active one; curators use it to target an invitation). */
  /** Owner or curator — the "Прогресс" page's cohort-wide student roster, aggregated server-side. */
  @Get("students/progress")
  public async getStudentsProgress(@Req() request: RequestWithCookies, @Query("practicumId") practicumId?: string) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    if (!practicumId) throw new BadRequestException("practicumId is required");
    try {
      const session = await authService.validateSession(token);
      return { data: await getStudentProgress(session.userId, practicumId) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      throw new InternalServerErrorException("Student progress lookup failed");
    }
  }

  /** Owner or curator — the "Прогресс" page's "Напомнить" button. */
  @Post("students/:studentId/remind")
  public async remindStudent(@Req() request: RequestWithCookies, @Param("studentId") studentId: string, @Body() body: unknown) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    const practicumId = body && typeof body === "object" && "practicumId" in body ? (body as { practicumId: unknown }).practicumId : undefined;
    if (typeof practicumId !== "string" || !practicumId) throw new BadRequestException("practicumId must be a string");
    try {
      const session = await authService.validateSession(token);
      return { data: await sendStudentReminder(session.userId, studentId, practicumId) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      throw new InternalServerErrorException("Sending the reminder failed");
    }
  }

  @Get("practicums")
  public async getPracticums(@Req() request: RequestWithCookies) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    try {
      const session = await authService.validateSession(token);
      return { data: await listPracticums(session.userId) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      throw new InternalServerErrorException("Practicum list failed");
    }
  }

  /**
   * Owner or curator — points the caller's own content creation at a practicum, independent of
   * which one is active for live streaming. `practicumId: null` clears the pick (falls back to
   * the active practicum again).
   */
  @Post("working-practicum")
  public async setWorkingPracticum(@Req() request: RequestWithCookies, @Body() body: unknown) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    const practicumId = body && typeof body === "object" && "practicumId" in body
      ? (body as { practicumId: unknown }).practicumId
      : undefined;
    if (practicumId !== null && typeof practicumId !== "string") throw new BadRequestException("practicumId must be a string or null");
    try {
      const session = await authService.validateSession(token);
      return { data: await setWorkingPracticum(session.userId, practicumId) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException("Setting the working practicum failed");
    }
  }

  /** Owner-only — re-activates an existing practicum instead of creating a new one (e.g. switching back). */
  @Post("practicums/:practicumId/activate")
  public async activatePracticum(@Req() request: RequestWithCookies, @Param("practicumId") practicumId: string) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    try {
      const session = await authService.validateSession(token);
      return { data: await setActivePracticum(session.userId, practicumId) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      throw new InternalServerErrorException("Switching practicum failed");
    }
  }

  /** Owner or curator — per-practicum "private stream" switch, from the "Потоки" list. */
  @Put("practicums/:practicumId/streams-private")
  public async setPracticumVisibility(@Req() request: RequestWithCookies, @Param("practicumId") practicumId: string, @Body() body: { streamsPrivate?: unknown }) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    if (typeof body?.streamsPrivate !== "boolean") throw new BadRequestException("streamsPrivate must be a boolean");
    try {
      const session = await authService.validateSession(token);
      return { data: await setPracticumStreamsPrivate(session.userId, practicumId, body.streamsPrivate) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException("Setting practicum stream visibility failed");
    }
  }

  /** Owner or curator, reversible — "Завершить поток" on the "Потоки" list. */
  @Put("practicums/:practicumId/completed")
  public async setPracticumCompleted(@Req() request: RequestWithCookies, @Param("practicumId") practicumId: string, @Body() body: { completed?: unknown }) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    if (typeof body?.completed !== "boolean") throw new BadRequestException("completed must be a boolean");
    try {
      const session = await authService.validateSession(token);
      return { data: await setPracticumCompleted(session.userId, practicumId, body.completed) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException("Setting practicum completion failed");
    }
  }

  /** Owner-only — counts behind the confirmation screen before deletePracticum below. */
  @Get("practicums/:practicumId/deletion-impact")
  public async getPracticumDeletionImpact(@Req() request: RequestWithCookies, @Param("practicumId") practicumId: string) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    try {
      const session = await authService.validateSession(token);
      return { data: await getPracticumDeletionImpact(session.userId, practicumId) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      throw new InternalServerErrorException("Loading practicum deletion impact failed");
    }
  }

  /** Owner-only, permanent — see practicum-admin-service.ts#deletePracticum for the cascade and the two server-side guards. */
  @Delete("practicums/:practicumId")
  public async deletePracticum(@Req() request: RequestWithCookies, @Param("practicumId") practicumId: string, @Body() body: { confirmTitle?: unknown }) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    if (typeof body?.confirmTitle !== "string") throw new BadRequestException("confirmTitle must be a string");
    try {
      const session = await authService.validateSession(token);
      await deletePracticum(session.userId, practicumId, body.confirmTitle);
      return { data: { deleted: true } };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException("Deleting practicum failed");
    }
  }

  @Get()
  public async get(@Req() request: RequestWithCookies) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");

    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.getForUser(session.userId) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      throw new UnauthorizedException("Session is invalid or expired");
    }
  }
}
