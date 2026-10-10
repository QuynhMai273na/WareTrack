import { Logger, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { ErrorCode, SOCKET_NAMESPACE, SOCKET_PATH, type SiteJoinAck } from '@waretrack/shared-schemas';
import type { Namespace, Socket } from 'socket.io';
import { webOrigins } from '../../platform/config/env';
import { PublishedEventBus, UserChannel } from '../../platform/outbox/event-bus';
import { PrismaService } from '../../platform/prisma/prisma.service';
import type { AccessTokenPayload } from '../identity/access.guard';
import { AccessService } from '../identity/access.service';

const MAX_SOCKETS_PER_USER = 5;

interface SocketData {
  userId: string;
  siteId: string | null;
  expiryTimer?: NodeJS.Timeout;
}

/**
 * Socket.IO gateway (mục 17.1): xác thực JWT ở handshake, room site:{id} / user:{id},
 * kiểm quyền mỗi lần site:join, ngắt room khi quyền bị thu hồi. Server → client cho event nghiệp vụ.
 */
@WebSocketGateway({ namespace: SOCKET_NAMESPACE, path: SOCKET_PATH, cors: { origin: webOrigins(), credentials: true } })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnModuleInit {
  private readonly logger = new Logger(RealtimeGateway.name);
  @WebSocketServer() server!: Namespace;

  constructor(
    private readonly jwt: JwtService,
    private readonly access: AccessService,
    private readonly bus: PublishedEventBus,
    private readonly prisma: PrismaService,
    private readonly users: UserChannel,
  ) {}

  onModuleInit() {
    this.bus.subscribe((event) => {
      this.server?.to(`site:${event.siteId}`).emit('event', event);
    });
    this.access.onUserAccessChanged((userId) => void this.recheckUser(userId));
    this.users.bind((userId, event, payload) => this.server?.to(`user:${userId}`).emit(event, payload));
  }

  afterInit(server: Namespace) {
    server.use(async (socket, next) => {
      try {
        const token = (socket.handshake.auth as { token?: string })?.token;
        if (!token) return next(Object.assign(new Error('unauthenticated'), { data: { code: ErrorCode.UNAUTHENTICATED } }));
        const payload = await this.jwt.verifyAsync<AccessTokenPayload & { exp: number }>(token);
        const access = await this.access.getUserAccess(payload.sub);
        if (!access || access.status !== 'ACTIVE' || access.permissionVersion !== payload.pv) {
          return next(Object.assign(new Error('unauthenticated'), { data: { code: ErrorCode.UNAUTHENTICATED } }));
        }
        const existing = await server.in(`user:${payload.sub}`).fetchSockets();
        if (existing.length >= MAX_SOCKETS_PER_USER) {
          return next(Object.assign(new Error('too many connections'), { data: { code: ErrorCode.RATE_LIMITED } }));
        }
        const data = socket.data as SocketData;
        data.userId = payload.sub;
        data.siteId = null;
        // Hết hạn token → báo client refresh rồi reconnect (mục 17.1)
        const ms = payload.exp * 1000 - Date.now();
        data.expiryTimer = setTimeout(() => {
          socket.emit('session:expired', {});
          socket.disconnect(true);
        }, Math.max(ms, 0));
        next();
      } catch {
        next(Object.assign(new Error('unauthenticated'), { data: { code: ErrorCode.UNAUTHENTICATED } }));
      }
    });
  }

  handleConnection(socket: Socket) {
    const data = socket.data as SocketData;
    void socket.join(`user:${data.userId}`);
    socket.on('disconnect', () => data.expiryTimer && clearTimeout(data.expiryTimer));
  }

  /** Một socket chỉ ở một room site; join site mới tự rời site cũ (mục 17.1). */
  @SubscribeMessage('site:join')
  async join(@ConnectedSocket() socket: Socket, @MessageBody() body: { siteId?: string }): Promise<SiteJoinAck> {
    const data = socket.data as SocketData;
    const siteId = body?.siteId;
    if (!siteId) return { ok: false, code: ErrorCode.VALIDATION_ERROR };
    const access = await this.access.getUserAccess(data.userId);
    if (!access || !(await this.access.canAccessSite(access, siteId)) || !(await this.access.permissionsAt(access, siteId)).has('dashboard.read')) {
      return { ok: false, code: ErrorCode.FORBIDDEN };
    }
    if (data.siteId && data.siteId !== siteId) await socket.leave(`site:${data.siteId}`);
    data.siteId = siteId;
    await socket.join(`site:${siteId}`);
    const cursor = await this.prisma.siteEventCursor.findUnique({ where: { siteId } });
    return { ok: true, latestSeq: Number(cursor?.lastSeq ?? 0) };
  }

  @SubscribeMessage('site:leave')
  async leave(@ConnectedSocket() socket: Socket) {
    const data = socket.data as SocketData;
    if (data.siteId) await socket.leave(`site:${data.siteId}`);
    data.siteId = null;
    return { ok: true };
  }

  /** Quyền thay đổi: socket không còn quyền rời room site; user bị disable thì ngắt kết nối. */
  private async recheckUser(userId: string) {
    if (!this.server) return;
    const sockets = await this.server.in(`user:${userId}`).fetchSockets();
    const access = await this.access.getUserAccess(userId);
    for (const s of sockets) {
      const data = s.data as SocketData;
      if (!access || access.status !== 'ACTIVE') {
        s.disconnect(true);
        continue;
      }
      if (data.siteId && !(await this.access.canAccessSite(access, data.siteId))) {
        s.leave(`site:${data.siteId}`);
        s.emit('site:revoked', { siteId: data.siteId });
        data.siteId = null;
      }
    }
    this.logger.log(`Rechecked ${sockets.length} socket(s) for user ${userId}`);
  }
}
