import {
  BadRequestException,
  Body,
  Controller,
  Get,
  InternalServerErrorException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  ForbiddenException,
} from "@nestjs/common";
import type { Request } from "express";
import { AUTH_COOKIE_NAMES, AuthServiceError, authService } from "@/app/server/auth";
import { discussionService, type CreateDiscussionInput, type CreateDiscussionMessageInput } from "@/app/server/discussions/discussion-service";

type RequestWithCookies = Request & { cookies?: Record<string, string | undefined> };
type JsonBody = Record<string, unknown>;

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new BadRequestException(`${field} must be a string`);
  return value;
}

function attachments(value: unknown): CreateDiscussionInput["attachments"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new BadRequestException("attachments must be an array");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new BadRequestException("attachment is invalid");
    const record = item as Record<string, unknown>;
    const byteSize = typeof record.byteSize === "number" ? record.byteSize : Number(record.byteSize);
    if (typeof record.originalName !== "string" || typeof record.mimeType !== "string" || !Number.isSafeInteger(byteSize)) throw new BadRequestException("attachment metadata is invalid");
    return { fileId: optionalString(record.fileId, "attachment.fileId"), sourceUrl: optionalString(record.sourceUrl, "attachment.sourceUrl"), originalName: record.originalName, mimeType: record.mimeType, byteSize };
  });
}

function createInput(body: JsonBody): CreateDiscussionInput {
  if (typeof body.title !== "string" || typeof body.body !== "string") throw new BadRequestException("title and body are required");
  return {
    title: body.title,
    body: body.body,
    moduleId: optionalString(body.moduleId, "moduleId"),
    assignmentId: optionalString(body.assignmentId, "assignmentId"),
    curatorId: optionalString(body.curatorId, "curatorId"),
    visibility: body.visibility === "COHORT" ? "COHORT" : "PRIVATE",
    sourceUrl: optionalString(body.sourceUrl, "sourceUrl"),
    attachments: attachments(body.attachments),
  };
}

function messageInput(body: JsonBody): CreateDiscussionMessageInput {
  if (typeof body.body !== "string") throw new BadRequestException("body is required");
  return { body: body.body, sourceUrl: optionalString(body.sourceUrl, "sourceUrl"), attachments: attachments(body.attachments) };
}

function mapError(error: unknown): never {
  if (!(error instanceof AuthServiceError)) throw new InternalServerErrorException("Discussion operation failed");
  if (error.code === "FORBIDDEN") throw new ForbiddenException(error.message);
  if (error.code === "INVALID_INPUT") throw new BadRequestException(error.message);
  throw new InternalServerErrorException("Discussion operation failed");
}

@Controller("discussions")
export class DiscussionsController {
  @Get()
  public async studentList(@Req() request: RequestWithCookies) {
    const session = await this.requireSession(request);
    try { return { data: await discussionService.listForStudent(session.userId) }; } catch (error) { mapError(error); }
  }

  @Get("manage")
  public async curatorList(@Req() request: RequestWithCookies) {
    const session = await this.requireSession(request);
    try { return { data: await discussionService.listForCurator(session.userId) }; } catch (error) { mapError(error); }
  }

  @Get("cohort")
  public async cohortList(@Req() request: RequestWithCookies) {
    const session = await this.requireSession(request);
    try { return { data: await discussionService.listCohortForStudent(session.userId) }; } catch (error) { mapError(error); }
  }

  @Post()
  public async create(@Req() request: RequestWithCookies, @Body() body: JsonBody) {
    const session = await this.requireSession(request);
    try { return { data: await discussionService.create(session.userId, createInput(body)) }; } catch (error) { mapError(error); }
  }

  @Post(":threadId/messages")
  public async reply(@Req() request: RequestWithCookies, @Param("threadId") threadId: string, @Body() body: JsonBody) {
    const session = await this.requireSession(request);
    try { return { data: await discussionService.reply(session.userId, threadId, messageInput(body)) }; } catch (error) { mapError(error); }
  }

  @Post(":threadId/close")
  public async close(@Req() request: RequestWithCookies, @Param("threadId") threadId: string) {
    const session = await this.requireSession(request);
    try { return { data: await discussionService.close(session.userId, threadId) }; } catch (error) { mapError(error); }
  }

  private async requireSession(request: RequestWithCookies) {
    const token = request.cookies?.[AUTH_COOKIE_NAMES.session];
    if (!token) throw new UnauthorizedException("Session is required");
    try { return await authService.validateSession(token); } catch { throw new UnauthorizedException("Session is invalid or expired"); }
  }
}
