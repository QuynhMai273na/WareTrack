import { Global, Injectable, Module } from '@nestjs/common';
import type { MovementSubject, PositionSource } from '@prisma/client';
import { currentContext } from '../../platform/context/request-context';
import type { Tx } from '../../platform/prisma/prisma.service';

export interface MovementInput {
  siteId: string;
  subjectType: MovementSubject;
  subjectId: string;
  fromLocationId: string | null;
  toLocationId: string | null;
  positionSource: PositionSource;
  reason: string;
  taskId?: string | null;
  confidence?: number | null;
  occurredAt?: Date;
}

/**
 * MovementPort (mục 13.2 Operations): lịch sử di chuyển append-only — nguồn, đích, chủ thể, thời điểm,
 * lý do, bằng chứng (BR-04). Chỉ được gọi bởi module sở hữu đối tượng, trong transaction của lệnh.
 */
@Injectable()
export class MovementService {
  async record(tx: Tx, movement: MovementInput) {
    return tx.movementRecord.create({
      data: {
        siteId: movement.siteId,
        subjectType: movement.subjectType,
        subjectId: movement.subjectId,
        fromLocationId: movement.fromLocationId,
        toLocationId: movement.toLocationId,
        positionSource: movement.positionSource,
        confidence: movement.confidence ?? null,
        reason: movement.reason,
        actorId: currentContext()?.principal?.userId ?? null,
        taskId: movement.taskId ?? null,
        occurredAt: movement.occurredAt ?? new Date(),
      },
    });
  }
}

@Global()
@Module({ providers: [MovementService], exports: [MovementService] })
export class MovementModule {}
