import { Injectable } from '@nestjs/common';
import { currentContext } from '../context/request-context';
import type { Tx } from '../prisma/prisma.service';

export interface AuditEntry {
  siteId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  diff?: { before?: Record<string, unknown>; after?: Record<string, unknown> };
  reason?: string | null;
  actorType?: 'USER' | 'DEVICE' | 'SYSTEM';
  actorId?: string | null;
}

const SECRET_KEYS = /password|token|hash|secret|apikey/i;

function scrub(obj?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!obj) return undefined;
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([k]) => !SECRET_KEYS.test(k))
      .map(([k, v]) => [k, v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? v.toString() : v]),
  );
}

/** Audit log append-only, luôn ghi trong transaction của lệnh (FR-14.01, mục 13.2 Audit). */
@Injectable()
export class AuditService {
  async record(tx: Tx, entry: AuditEntry): Promise<void> {
    const ctx = currentContext();
    const principal = ctx?.principal;
    await tx.auditLog.create({
      data: {
        siteId: entry.siteId,
        actorType: entry.actorType ?? (principal ? 'USER' : 'SYSTEM'),
        actorId: entry.actorId ?? principal?.userId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        diff: entry.diff ? ({ before: scrub(entry.diff.before), after: scrub(entry.diff.after) } as object) : undefined,
        reason: entry.reason ?? null,
        correlationId: ctx?.correlationId ?? null,
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent ?? null,
      },
    });
  }
}
