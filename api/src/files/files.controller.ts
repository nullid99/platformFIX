import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  InternalServerErrorException,
  Param,
  Post,
  Put,
  Req,
  Res,
  StreamableFile,
  UnauthorizedException,
  ForbiddenException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { AUTH_COOKIE_NAMES, AuthServiceError, authService } from "@/app/server/auth";
import { fileService } from "@/app/server/files";

type RequestWithCookies = Request & { cookies?: Record<string, string | undefined> };
type JsonBody = Record<string, unknown>;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${field} is required`);
  return value.trim();
}

function requiredInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new BadRequestException(`${field} must be an integer`);
  return parsed;
}

function mapError(error: unknown): never {
  if (!(error instanceof AuthServiceError)) throw new InternalServerErrorException("File operation failed");
  if (error.code === "FORBIDDEN") throw new ForbiddenException(error.message);
  if (error.code === "INVALID_INPUT") throw new BadRequestException(error.message);
  throw new InternalServerErrorException("File operation failed");
}

@Controller("files")
export class FilesController {
  @Post()
  public async create(@Req() request: RequestWithCookies, @Body() body: JsonBody) {
    const session = await this.requireSession(request);
    try {
      return {
        data: await fileService.createUpload(session.userId, {
          originalName: requiredString(body.originalName, "originalName"),
          mimeType: requiredString(body.mimeType, "mimeType"),
          byteSize: requiredInteger(body.byteSize, "byteSize"),
        }, body.purpose === "MODULE_COVER" ? "module-cover" : body.purpose === "CHAT" ? "chat" : "submission"),
      };
    } catch (error) {
      mapError(error);
    }
  }

  @Post(":fileId/module-cover/:moduleId")
  public async attachModuleCover(@Req() request: RequestWithCookies, @Param("fileId") fileId: string, @Param("moduleId") moduleId: string) {
    const session = await this.requireSession(request);
    try {
      return { data: await fileService.attachToModuleCover(session.userId, moduleId, fileId) };
    } catch (error) {
      mapError(error);
    }
  }

  @Put(":fileId/content")
  public async upload(@Req() request: RequestWithCookies, @Param("fileId") fileId: string) {
    const session = await this.requireSession(request);
    try {
      await fileService.uploadContent(session.userId, fileId, request);
      return { data: { status: "UPLOADED" } };
    } catch (error) {
      mapError(error);
    }
  }

  @Get(":fileId/content")
  public async read(@Req() request: RequestWithCookies, @Param("fileId") fileId: string, @Res({ passthrough: true }) response: Response) {
    const session = await this.requireSession(request);
    try {
      const file = await fileService.getReadable(session.userId, fileId);
      const encodedName = encodeURIComponent(file.originalName).replace(/'/g, "%27");
      response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodedName}`);
      response.setHeader("Cache-Control", "private, no-store");
      return new StreamableFile(file.stream, { type: file.mimeType, length: file.byteSize });
    } catch (error) {
      mapError(error);
    }
  }

  @Delete(":fileId")
  public async delete(@Req() request: RequestWithCookies, @Param("fileId") fileId: string) {
    const session = await this.requireSession(request);
    try {
      await fileService.deleteUnattached(session.userId, fileId);
      return { data: { status: "DELETED" } };
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
