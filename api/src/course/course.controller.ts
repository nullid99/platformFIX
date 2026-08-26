import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  InternalServerErrorException,
  Req,
  Param,
  Body,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import type { Request } from "express";
import { AUTH_COOKIE_NAMES, AuthServiceError, authService } from "@/app/server/auth";
import { courseService } from "@/app/server/course";
import { getRequestContext } from "../common/request-context";
import { parseCreateModuleBody, parseCreateVimeoMediaBody, parseUpdateMediaKindBody } from "./course-input";

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
  public async manage(@Req() request: RequestWithCookies) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");

    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.getForCurator(session.userId) };
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

  @Put("lessons/:lessonId")
  public async updateLesson(@Req() request: RequestWithCookies, @Param("lessonId") lessonId: string, @Body() body: unknown) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    if (!body || typeof body !== "object" || typeof (body as { title?: unknown }).title !== "string") throw new BadRequestException("title is required");
    try {
      const session = await authService.validateSession(token);
      const input = body as { title: string; description?: string };
      return { data: await courseService.updateLesson(session.userId, lessonId, input) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException("Lesson update failed");
    }
  }

  @Put("lessons/:lessonId/media/reorder")
  public async reorderLessonMedia(@Req() request: RequestWithCookies, @Param("lessonId") lessonId: string, @Body() body: unknown) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    if (!body || typeof body !== "object" || !Array.isArray((body as { mediaIds?: unknown }).mediaIds) || !(body as { mediaIds: unknown[] }).mediaIds.every((id) => typeof id === "string")) {
      throw new BadRequestException("mediaIds is required");
    }
    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.reorderLessonMedia(session.userId, lessonId, (body as { mediaIds: string[] }).mediaIds) };
    } catch (error) {
      if (error instanceof AuthServiceError) mapError(error);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException("Lesson media reorder failed");
    }
  }

  @Put("modules/:moduleId")
  public async updateModule(@Req() request: RequestWithCookies, @Param("moduleId") moduleId: string, @Body() body: unknown) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    if (!body || typeof body !== "object" || typeof (body as { title?: unknown }).title !== "string") throw new BadRequestException("title is required");
    try {
      const session = await authService.validateSession(token);
      const input = body as { title: string; description?: string };
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

  @Put("media/:mediaId/lesson")
  public async attachMediaToLesson(@Req() request: RequestWithCookies, @Param("mediaId") mediaId: string, @Body() body: unknown) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    if (!body || typeof body !== "object" || typeof (body as { lessonId?: unknown }).lessonId !== "string") throw new BadRequestException("lessonId is required");
    try {
      const session = await authService.validateSession(token);
      return { data: await courseService.attachMediaToLesson(session.userId, mediaId, (body as { lessonId: string }).lessonId) };
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
