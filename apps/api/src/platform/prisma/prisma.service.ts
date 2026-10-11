import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { DomainError } from '../errors/domain-error';
import { isRetryableDbError } from '../errors/db-error-map';

export type Tx = Prisma.TransactionClient;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

export interface TxOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  maxRetries?: number;
  /** Lệnh lô lớn (nhập tồn đầu kỳ) cần transaction dài hơn mặc định 10 giây. */
  timeoutMs?: number;
}

/**
 * Chạy một use case trong đúng một transaction (mục 13.1): aggregate + ledger + audit + outbox.
 * Tự retry khi gặp serialization failure / deadlock (tối đa 3 lần, backoff).
 */
@Injectable()
export class TxRunner {
  constructor(private readonly prisma: PrismaService) {}

  async run<T>(fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    const maxRetries = opts.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(fn, {
          isolationLevel: opts.isolationLevel ?? Prisma.TransactionIsolationLevel.ReadCommitted,
          timeout: opts.timeoutMs ?? 10_000,
          maxWait: 5_000,
        });
      } catch (err) {
        if (err instanceof DomainError || attempt >= maxRetries || !isRetryableDbError(err)) throw err;
        await new Promise((r) => setTimeout(r, 20 * 2 ** attempt + Math.random() * 20));
      }
    }
  }
}

/**
 * Cập nhật có điều kiện theo version (optimistic concurrency, mục 9 / 14.11).
 * 0 dòng bị ảnh hưởng → 409 CONCURRENT_MODIFICATION.
 */
export async function updateWithVersion(
  delegate: { updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }> },
  where: Record<string, unknown>,
  expectedVersion: number,
  data: Record<string, unknown>,
): Promise<void> {
  const res = await delegate.updateMany({
    where: { ...where, version: expectedVersion },
    data: { ...data, version: { increment: 1 } },
  });
  if (res.count === 0) throw DomainError.concurrent();
}
