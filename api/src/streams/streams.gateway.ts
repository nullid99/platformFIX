import { ConnectedSocket, MessageBody, OnGatewayConnection, SubscribeMessage, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import { AUTH_COOKIE_NAMES, AuthServiceError, authService } from "@/app/server/auth";
import { streamChatService } from "@/app/server/streams";

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

@WebSocketGateway({
  namespace: "/streams",
  // Must match the client's `path` option and nginx's /api/ location block in staging/production —
  // see the SOCKET_PATH comment in app/page.tsx.
  path: "/api/socket.io/",
  cors: { origin: process.env.WEB_ORIGIN ?? "http://localhost:3000", credentials: true },
})
export class StreamsGateway implements OnGatewayConnection {
  @WebSocketServer()
  private server!: Server;

  public async handleConnection(client: Socket): Promise<void> {
    try {
      const cookies = parseCookies(client.handshake.headers.cookie);
      const token = cookies[AUTH_COOKIE_NAMES.session];
      if (!token) throw new AuthServiceError("SESSION_INVALID", "Session is required");
      const session = await authService.validateSession(token);
      await streamChatService.assertAccess(session.userId);
      client.data.userId = session.userId;
      const history = await streamChatService.listRecent(session.userId);
      client.emit("chat:history", history);
    } catch (error) {
      client.emit("chat:error", error instanceof AuthServiceError ? error.message : "Не удалось подключиться к чату");
      client.disconnect(true);
    }
  }

  /** Called by StreamLiveNotifier when a new broadcast starts — clears already-open chat panels immediately. */
  public broadcastChatReset(): void {
    this.server.emit("chat:history", []);
  }

  @SubscribeMessage("chat:send")
  public async handleSend(@ConnectedSocket() client: Socket, @MessageBody() payload: { body?: unknown; fileId?: unknown; replyToId?: unknown }): Promise<void> {
    const userId = client.data.userId as string | undefined;
    if (!userId) return;
    const body = typeof payload?.body === "string" ? payload.body : "";
    const fileId = typeof payload?.fileId === "string" ? payload.fileId : undefined;
    const replyToId = typeof payload?.replyToId === "string" ? payload.replyToId : undefined;
    try {
      const message = await streamChatService.postMessage(userId, body, fileId, replyToId);
      this.server.emit("chat:message", message);
    } catch (error) {
      client.emit("chat:error", error instanceof AuthServiceError ? error.message : "Не удалось отправить сообщение");
    }
  }

  @SubscribeMessage("chat:delete")
  public async handleDelete(@ConnectedSocket() client: Socket, @MessageBody() payload: { messageId?: unknown }): Promise<void> {
    const userId = client.data.userId as string | undefined;
    if (!userId) return;
    const messageId = typeof payload?.messageId === "string" ? payload.messageId : "";
    if (!messageId) return;
    try {
      const result = await streamChatService.deleteMessage(userId, messageId);
      this.server.emit("chat:delete", result);
    } catch (error) {
      client.emit("chat:error", error instanceof AuthServiceError ? error.message : "Не удалось удалить сообщение");
    }
  }

  @SubscribeMessage("chat:react")
  public async handleReact(@ConnectedSocket() client: Socket, @MessageBody() payload: { messageId?: unknown; emoji?: unknown }): Promise<void> {
    const userId = client.data.userId as string | undefined;
    if (!userId) return;
    const messageId = typeof payload?.messageId === "string" ? payload.messageId : "";
    const emoji = typeof payload?.emoji === "string" ? payload.emoji : "";
    if (!messageId || !emoji) return;
    try {
      const result = await streamChatService.toggleReaction(userId, messageId, emoji);
      this.server.emit("chat:reaction", result);
    } catch (error) {
      client.emit("chat:error", error instanceof AuthServiceError ? error.message : "Не удалось поставить реакцию");
    }
  }
}
