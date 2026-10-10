import { Injectable } from '@nestjs/common';
import type { RealtimeEventType } from '@waretrack/shared-schemas';
import { uuidv7 } from 'uuidv7';
import { currentContext } from '../context/request-context';
import type { Tx } from '../prisma/prisma.service';

export interface OutboxInput {
  siteId: string;
  type: RealtimeEventType;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  /** Trạng thái sau thay đổi, đủ để client patch cache (state-carrying — mục 17.2). */
  data: Record<string, unknown>;
  version?: number;
}

/**
 * Ghi event vào outbox TRONG transaction nghiệp vụ. Relay chỉ phát sau commit (BR-29).
 */
@Injectable()
export class OutboxService {
  async publish(tx: Tx, input: OutboxInput): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        eventId: uuidv7(),
        siteId: input.siteId,
        eventType: input.type,
        eventVersion: input.version ?? 1,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        aggregateVersion: input.aggregateVersion,
        payload: input.data as object,
        correlationId: currentContext()?.correlationId ?? null,
      },
    });
  }
}
