import { StoredFileStatus, UserRole } from "@/app/generated/prisma/enums";
import { AuthServiceError } from "@/app/server/auth";
import { prisma } from "@/app/server/db";
import { assertPracticumViewer } from "./access";

const MESSAGE_MAX_LENGTH = 2_000;
const HISTORY_LIMIT = 50;

// Fixed set so the picker is small and every reaction renders consistently — matches the
// quick-react row Discord shows, not a full emoji keyboard.
export const ALLOWED_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"] as const;
export type AllowedReaction = (typeof ALLOWED_REACTIONS)[number];

export type StreamChatMessageDto = {
  id: string;
  body: string;
  createdAt: string;
  authorId: string;
  authorName: string;
  authorRole: UserRole;
  attachment: { fileId: string; url: string } | null;
  replyTo: { id: string; authorName: string; authorRole: UserRole; body: string } | null;
  reactions: Array<{ emoji: string; userIds: string[] }>;
};

type AuthorForDto = {
  id: string;
  role: UserRole;
  email: string | null;
  externalIdentities: Array<{ displayName: string | null; username: string | null }>;
};

type MessageForDto = {
  id: string;
  body: string;
  createdAt: Date;
  fileId: string | null;
  author: AuthorForDto;
  replyTo: { id: string; body: string; author: AuthorForDto } | null;
  reactions: Array<{ emoji: string; userId: string }>;
};

const AUTHOR_SELECT = { id: true, role: true, email: true, externalIdentities: { select: { displayName: true, username: true }, orderBy: { createdAt: "asc" as const }, take: 1 } };
const REPLY_TO_INCLUDE = { select: { id: true, body: true, author: { select: AUTHOR_SELECT } } };
const REACTIONS_INCLUDE = { select: { emoji: true, userId: true } };

function authorName(author: AuthorForDto): string {
  return author.externalIdentities[0]?.displayName ?? author.externalIdentities[0]?.username ?? author.email ?? "Пользователь";
}

function groupReactions(reactions: Array<{ emoji: string; userId: string }>): Array<{ emoji: string; userIds: string[] }> {
  const byEmoji = new Map<string, string[]>();
  for (const reaction of reactions) {
    const userIds = byEmoji.get(reaction.emoji) ?? [];
    userIds.push(reaction.userId);
    byEmoji.set(reaction.emoji, userIds);
  }
  return [...byEmoji.entries()].map(([emoji, userIds]) => ({ emoji, userIds }));
}

export class StreamChatService {
  public async assertAccess(userId: string): Promise<{ practicumId: string; role: UserRole }> {
    return assertPracticumViewer(userId);
  }

  public async listRecent(userId: string): Promise<StreamChatMessageDto[]> {
    const { practicumId } = await this.assertAccess(userId);
    const practicum = await prisma.practicum.findUnique({ where: { id: practicumId }, select: { currentStreamSessionStartedAt: true } });
    const messages = await prisma.streamMessage.findMany({
      where: practicum?.currentStreamSessionStartedAt
        ? { practicumId, createdAt: { gte: practicum.currentStreamSessionStartedAt } }
        : { practicumId },
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT,
      include: { author: { select: AUTHOR_SELECT }, replyTo: REPLY_TO_INCLUDE, reactions: REACTIONS_INCLUDE },
    });
    return messages.reverse().map((message) => this.toDto(message));
  }

  public async postMessage(userId: string, body: string, fileId?: string, replyToId?: string): Promise<StreamChatMessageDto> {
    const { practicumId } = await this.assertAccess(userId);
    const normalized = body.trim();
    if (normalized.length > MESSAGE_MAX_LENGTH) throw new AuthServiceError("INVALID_INPUT", "Message is invalid");

    let attachedFileId: string | undefined;
    if (fileId) {
      const file = await prisma.storedFile.findUnique({ where: { id: fileId }, select: { id: true, ownerId: true, status: true, mimeType: true, streamMessages: { select: { id: true } } } });
      if (!file || file.ownerId !== userId || file.status !== StoredFileStatus.UPLOADED || !file.mimeType.startsWith("image/") || file.streamMessages.length > 0) {
        throw new AuthServiceError("INVALID_INPUT", "Attachment is invalid");
      }
      attachedFileId = file.id;
    }

    if (!normalized && !attachedFileId) throw new AuthServiceError("INVALID_INPUT", "Message is invalid");

    let validReplyToId: string | undefined;
    if (replyToId) {
      const target = await prisma.streamMessage.findUnique({ where: { id: replyToId }, select: { practicumId: true } });
      if (target && target.practicumId === practicumId) validReplyToId = replyToId;
    }

    const message = await prisma.streamMessage.create({
      data: { practicumId, authorId: userId, body: normalized, fileId: attachedFileId, replyToId: validReplyToId },
      include: { author: { select: AUTHOR_SELECT }, replyTo: REPLY_TO_INCLUDE, reactions: REACTIONS_INCLUDE },
    });
    return this.toDto(message);
  }

  /** Toggles the actor's own reaction — adding it if absent, removing it if already set. */
  public async toggleReaction(userId: string, messageId: string, emoji: string): Promise<{ messageId: string; emoji: string; userId: string; added: boolean }> {
    const { practicumId } = await this.assertAccess(userId);
    if (!(ALLOWED_REACTIONS as readonly string[]).includes(emoji)) throw new AuthServiceError("INVALID_INPUT", "Reaction is invalid");
    const message = await prisma.streamMessage.findUnique({ where: { id: messageId }, select: { practicumId: true } });
    if (!message || message.practicumId !== practicumId) throw new AuthServiceError("INVALID_INPUT", "Message does not exist");

    const existing = await prisma.streamMessageReaction.findUnique({ where: { messageId_userId_emoji: { messageId, userId, emoji } } });
    if (existing) {
      await prisma.streamMessageReaction.delete({ where: { id: existing.id } });
      return { messageId, emoji, userId, added: false };
    }
    await prisma.streamMessageReaction.create({ data: { messageId, userId, emoji } });
    return { messageId, emoji, userId, added: true };
  }

  private toDto(message: MessageForDto): StreamChatMessageDto {
    return {
      id: message.id,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
      authorId: message.author.id,
      authorName: authorName(message.author),
      authorRole: message.author.role,
      attachment: message.fileId ? { fileId: message.fileId, url: `/api/files/${message.fileId}/content` } : null,
      replyTo: message.replyTo ? { id: message.replyTo.id, authorName: authorName(message.replyTo.author), authorRole: message.replyTo.author.role, body: message.replyTo.body } : null,
      reactions: groupReactions(message.reactions),
    };
  }
}

export const streamChatService = new StreamChatService();
