import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { OutboxEvent } from '@prisma/client';
import type { RealtimeEnvelope, RealtimeEventType } from '@waretrack/shared-schemas';
import { Client } from 'pg';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { PublishedEventBus } from './event-bus';

const RELAY_LOCK_KEY = 7_420_001;
const BATCH = 200;

/**
 * Outbox relay (mục 17.5): LISTEN outbox_new + poll 1s dự phòng; leader qua advisory lock;
 * gán siteSeq liên tục theo site trong một transaction, phát theo thứ tự siteSeq rồi đánh dấu publishedAt.
 * At-least-once: event đã có siteSeq nhưng chưa publishedAt được phát lại khi khởi động.
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private listener: Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private pending = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: PublishedEventBus,
  ) {}

  async onModuleInit() {
    if (env().NODE_ENV === 'test' && process.env.OUTBOX_RELAY_DISABLED === 'true') return;
    await this.startListener();
    this.timer = setInterval(() => void this.drain(), 1000);
    void this.drain();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.listener?.end().catch(() => undefined);
  }

  private async startListener() {
    try {
      const client = new Client({ connectionString: env().DATABASE_URL.replace(/\?schema=\w+$/, '') });
      client.on('notification', () => void this.drain());
      client.on('error', (err) => {
        this.logger.warn(`LISTEN connection error: ${err.message} — falling back to polling`);
        this.listener = null;
      });
      await client.connect();
      await client.query('LISTEN outbox_new');
      this.listener = client;
    } catch (err) {
      this.logger.warn(`Cannot LISTEN (${(err as Error).message}); polling only`);
    }
  }

  /** Single-flight: nếu đang drain thì đánh dấu pending để chạy thêm một vòng. */
  async drain(): Promise<void> {
    if (this.stopped) return;
    if (this.draining) {
      this.pending = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.pending = false;
        const assigned = await this.assignSequences();
        const emitted = await this.emitAssigned();
        if (assigned === BATCH || emitted === BATCH) this.pending = true;
      } while (this.pending && !this.stopped);
    } catch (err) {
      this.logger.error(`Relay drain failed: ${(err as Error).message}`);
    } finally {
      this.draining = false;
    }
  }

  private async assignSequences(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${RELAY_LOCK_KEY}) AS locked`;
      if (!locked) return 0;
      const rows = await tx.$queryRaw<{ id: bigint; site_id: string }[]>`
        SELECT id, site_id FROM outbox_event
        WHERE published_at IS NULL AND site_seq IS NULL
        ORDER BY id
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return 0;
      const bySite = new Map<string, bigint[]>();
      for (const row of rows) {
        const list = bySite.get(row.site_id) ?? [];
        list.push(row.id);
        bySite.set(row.site_id, list);
      }
      for (const [siteId, ids] of bySite) {
        const [{ last_seq }] = await tx.$queryRaw<{ last_seq: bigint }[]>`
          INSERT INTO site_event_cursor (site_id, last_seq) VALUES (${siteId}::uuid, ${ids.length})
          ON CONFLICT (site_id) DO UPDATE SET last_seq = site_event_cursor.last_seq + ${ids.length}
          RETURNING last_seq`;
        let seq = last_seq - BigInt(ids.length);
        for (const id of ids) {
          seq += 1n;
          await tx.outboxEvent.update({ where: { id }, data: { siteSeq: seq } });
        }
      }
      return rows.length;
    });
  }

  private async emitAssigned(): Promise<number> {
    const rows = await this.prisma.outboxEvent.findMany({
      where: { publishedAt: null, siteSeq: { not: null } },
      orderBy: [{ siteId: 'asc' }, { siteSeq: 'asc' }],
      take: BATCH,
    });
    for (const row of rows) {
      await this.bus.dispatch(toEnvelope(row));
      await this.prisma.outboxEvent.update({ where: { id: row.id }, data: { publishedAt: new Date() } });
    }
    return rows.length;
  }
}

export function toEnvelope(row: OutboxEvent): RealtimeEnvelope {
  return {
    eventId: row.eventId,
    type: row.eventType as RealtimeEventType,
    v: row.eventVersion,
    siteId: row.siteId,
    siteSeq: Number(row.siteSeq ?? 0),
    occurredAt: row.createdAt.toISOString(),
    publishedAt: (row.publishedAt ?? new Date()).toISOString(),
    aggregate: { type: row.aggregateType, id: row.aggregateId, version: row.aggregateVersion },
    correlationId: row.correlationId,
    data: row.payload as Record<string, unknown>,
  };
}
