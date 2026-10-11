import { Injectable } from '@nestjs/common';
import type { Tx } from '../prisma/prisma.service';

/** Sinh mã nghiệp vụ dễ đọc, tăng dần theo phạm vi, an toàn đồng thời (DEC-07). */
@Injectable()
export class CodeGenerator {
  async next(tx: Tx, scope: string): Promise<number> {
    const [{ value }] = await tx.$queryRaw<{ value: bigint }[]>`
      INSERT INTO code_counter (scope, value) VALUES (${scope}, 1)
      ON CONFLICT (scope) DO UPDATE SET value = code_counter.value + 1
      RETURNING value`;
    return Number(value);
  }

  /** VIS-yyMMdd-NNNN theo ngày UTC. */
  async visitCode(tx: Tx, at = new Date()): Promise<string> {
    const ymd = at.toISOString().slice(2, 10).replace(/-/g, '');
    const sequence = await this.next(tx, `VIS-${ymd}`);
    return `VIS-${ymd}-${String(sequence).padStart(4, '0')}`;
  }

  async prefixed(tx: Tx, prefix: string, width = 4): Promise<string> {
    const sequence = await this.next(tx, prefix);
    return `${prefix}-${String(sequence).padStart(width, '0')}`;
  }
}
