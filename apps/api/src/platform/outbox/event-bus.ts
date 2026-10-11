import { Injectable, Logger } from '@nestjs/common';
import type { RealtimeEnvelope } from '@waretrack/shared-schemas';

export type PublishedEventHandler = (event: RealtimeEnvelope) => void | Promise<void>;

/**
 * Bus in-process cho event ĐÃ commit (do outbox relay phát).
 * Realtime gateway, notifications, KPI cache đăng ký ở đây — không bao giờ ghi ngược vào domain (mục 12.4).
 */
@Injectable()
export class PublishedEventBus {
  private readonly logger = new Logger(PublishedEventBus.name);
  private readonly handlers: PublishedEventHandler[] = [];

  subscribe(handler: PublishedEventHandler) {
    this.handlers.push(handler);
  }

  async dispatch(event: RealtimeEnvelope) {
    for (const handler of this.handlers) {
      try {
        await handler(event);
      } catch (err) {
        this.logger.error(`Handler failed for ${event.type}: ${(err as Error).message}`);
      }
    }
  }
}

export type UserMessageSender = (userId: string, event: string, payload: unknown) => void;

/** Kênh gửi riêng tới room user:{id} — gateway đăng ký sender, module khác chỉ gửi (không phụ thuộc Socket.IO). */
@Injectable()
export class UserChannel {
  private sender: UserMessageSender | null = null;

  bind(sender: UserMessageSender) {
    this.sender = sender;
  }

  send(userId: string, event: string, payload: unknown) {
    this.sender?.(userId, event, payload);
  }
}
