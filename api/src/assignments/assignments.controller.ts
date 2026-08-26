import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  Delete,
  ForbiddenException,
  Get,
  InternalServerErrorException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { AUTH_COOKIE_NAMES, AuthServiceError, authService } from "@/app/server/auth";
import { assignmentService } from "@/app/server/assignments";
import { parseAssignmentMaterials } from "./assignment-input";

type RequestWithCookies = Request & { cookies?: Record<string, string | undefined> };
type JsonBody = Record<string, unknown>;

function text(value: unknown, field: string, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") throw new BadRequestException(`${field} must be a string`);
  return value;
}

function stringArray(value: unknown, field: string, optional = false): string[] | undefined {
  if (value === undefined && optional) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new BadRequestException(`${field} must be an array of strings`);
  return value;
}

function assignmentInput(body: JsonBody, partial = false) {
  return {
    lessonId: text(body.lessonId, "lessonId", true),
    title: text(body.title, "title", partial),
    description: text(body.description, "description", partial),
    moduleNumber: text(body.moduleNumber, "moduleNumber", partial),
    moduleTitle: text(body.moduleTitle, "moduleTitle", partial),
    deadline: text(body.deadline, "deadline", true),
    requirements: stringArray(body.requirements, "requirements", partial),
    allowedFormats: stringArray(body.allowedFormats, "allowedFormats", partial),
    materials: parseAssignmentMaterials(body.materials, true),
  };
}

function mapError(error: unknown): never {
  if (!(error instanceof AuthServiceError)) {
    if (process.env.NODE_ENV !== "production" && error instanceof Error) {
      throw new InternalServerErrorException(error.message);
    }
    throw new InternalServerErrorException("Assignment operation failed");
  }
  if (error.code === "FORBIDDEN") throw new ForbiddenException(error.message);
  if (error.code === "INVALID_INPUT") throw new BadRequestException(error.message);
  if (error.code === "AUTH_CONFLICT") throw new ConflictException(error.message);
  if (error.code === "SESSION_INVALID") throw new UnauthorizedException("Session is invalid or expired");
  throw new InternalServerErrorException("Assignment operation failed");
}

@Controller("assignments")
export class AssignmentsController {
  @Get("manage")
  public async manage(@Req() request: RequestWithCookies) {
    const session = await this.requireSession(request);
    try {
      return { data: await assignmentService.listForCurator(session.userId) };
    } catch (error) {
      mapError(error);
    }
  }

  @Get()
  public async list(@Req() request: RequestWithCookies) {
    const session = await this.requireSession(request);
    try {
      return { data: await assignmentService.listForStudent(session.userId) };
    } catch (error) {
      mapError(error);
    }
  }

  @Post()
  public async create(@Req() request: RequestWithCookies, @Body() body: JsonBody) {
    const session = await this.requireSession(request);
    try {
      return { data: await assignmentService.create(session.userId, assignmentInput(body) as Parameters<typeof assignmentService.create>[1]) };
    } catch (error) {
      mapError(error);
    }
  }

  @Patch(":assignmentId")
  public async update(@Req() request: RequestWithCookies, @Param("assignmentId") assignmentId: string, @Body() body: JsonBody) {
    const session = await this.requireSession(request);
    try {
      return { data: await assignmentService.update(session.userId, assignmentId, assignmentInput(body, true) as Parameters<typeof assignmentService.update>[2]) };
    } catch (error) {
      mapError(error);
    }
  }

  @Delete(":assignmentId")
  public async archive(@Req() request: RequestWithCookies, @Param("assignmentId") assignmentId: string) {
    const session = await this.requireSession(request);
    try {
      await assignmentService.archive(session.userId, assignmentId);
      return { data: { status: "ARCHIVED" } };
    } catch (error) {
      mapError(error);
    }
  }

  @Post(":assignmentId/submissions")
  public async submit(@Req() request: RequestWithCookies, @Param("assignmentId") assignmentId: string, @Body() body: JsonBody) {
    const session = await this.requireSession(request);
    const attachments = body.attachments;
    const fileIds = body.fileIds;
    if (attachments !== undefined && (!Array.isArray(attachments) || attachments.some((item) => !item || typeof item !== "object" || Array.isArray(item)))) throw new BadRequestException("attachments must be an array");
    if (fileIds !== undefined && (!Array.isArray(fileIds) || fileIds.some((item) => typeof item !== "string"))) throw new BadRequestException("fileIds must be an array of strings");
    try {
      return { data: await assignmentService.submit(session.userId, assignmentId, { answerText: text(body.answerText, "answerText", true), attachments: attachments as Array<{ name: string; type: string; size: number }> | undefined, fileIds: fileIds as string[] | undefined }) };
    } catch (error) {
      mapError(error);
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

@Controller("review")
export class ReviewController {
  @Get("submissions")
  public async list(@Req() request: RequestWithCookies) {
    const session = await this.requireSession(request);
    try {
      return { data: await assignmentService.listQueue(session.userId) };
    } catch (error) {
      mapError(error);
    }
  }

  @Patch("submissions/:submissionId")
  public async decide(@Req() request: RequestWithCookies, @Param("submissionId") submissionId: string, @Body() body: JsonBody) {
    const session = await this.requireSession(request);
    if (body.decision !== "accepted" && body.decision !== "revision") throw new BadRequestException("decision is invalid");
    const checkedRequirements = stringArray(body.checkedRequirements, "checkedRequirements", true);
    try {
      return { data: await assignmentService.decide(session.userId, submissionId, body.decision, text(body.feedback, "feedback", true), checkedRequirements) };
    } catch (error) {
      mapError(error);
    }
  }

  @Post("submissions/:submissionId/claim")
  public async claim(@Req() request: RequestWithCookies, @Param("submissionId") submissionId: string) {
    const session = await this.requireSession(request);
    try {
      return { data: await assignmentService.claim(session.userId, submissionId) };
    } catch (error) {
      mapError(error);
    }
  }

  @Post("submissions/:submissionId/release")
  public async release(@Req() request: RequestWithCookies, @Param("submissionId") submissionId: string) {
    const session = await this.requireSession(request);
    try {
      return { data: await assignmentService.releaseClaim(session.userId, submissionId) };
    } catch (error) {
      mapError(error);
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
