import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Tx } from '../prisma/prisma.service';

/**
 * Concurrency anchor của location (mục 13.2 Sites & Layout): mọi thay đổi occupancy/block
 * phải khóa row location trước. Luôn khóa theo thứ tự id tăng dần để tránh deadlock (mục 8.5).
 */
@Injectable()
export class LocationLockPort {
  async lockForUpdate(tx: Tx, locationIds: string[]): Promise<void> {
    const ids = [...new Set(locationIds)].sort();
    if (ids.length === 0) return;
    await tx.$queryRaw`SELECT id FROM location WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
  }
}
