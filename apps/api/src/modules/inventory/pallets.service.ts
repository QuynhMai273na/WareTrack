import { Injectable } from '@nestjs/common';
import type { HandlingUnit, HuLifecycle, LocationType, PositionSource } from '@prisma/client';
import { ErrorCode, type MovePalletRequest } from '@waretrack/shared-schemas';
import { uuidv7 } from 'uuidv7';
import { AuditService } from '../../platform/audit/audit.service';
import { CodeGenerator } from '../../platform/codes/code-generator';
import { DomainError } from '../../platform/errors/domain-error';
import { LocationLockPort } from '../../platform/locks/location-lock';
import { type Tx, TxRunner } from '../../platform/prisma/prisma.service';
import { MovementService } from '../operations/movement.service';
import { SitesService } from '../sites/sites.service';
import { OccupancyService } from '../yard/occupancy.service';
import { InventoryEvents } from './inventory-events.service';
import { LedgerService, type BalanceChange } from './ledger.service';

/** Location có quản lý sức chứa theo pallet (occupancy nhiều đơn vị). Dock/gate không tính HU vào occupancy. */
const CAPACITY_TYPES: LocationType[] = ['STORAGE', 'STAGING', 'QUARANTINE'];

export interface MoveHuOptions {
  siteId: string;
  huId: string;
  toLocationId: string;
  reason: string;
  source: PositionSource;
  commandId: string;
  taskId?: string | null;
  lifecycle?: HuLifecycle;
  overrideCapacity?: boolean;
  expectedVersion?: number;
  /** Lệnh nội bộ (pick/load) được phép di chuyển HU đang ở lifecycle PICKED/STAGED/LOADED. */
  internal?: boolean;
}

/** Handling unit (pallet) — vị trí, sức chứa, lịch sử (FR-06.04, UC-10, UC-15). */
@Injectable()
export class PalletsService {
  constructor(
    private readonly tx: TxRunner,
    private readonly ledger: LedgerService,
    private readonly occupancy: OccupancyService,
    private readonly locks: LocationLockPort,
    private readonly sites: SitesService,
    private readonly movements: MovementService,
    private readonly events: InventoryEvents,
    private readonly audit: AuditService,
    private readonly codes: CodeGenerator,
  ) {}

  async create(tx: Tx, siteId: string, opts: { code?: string; sscc?: string | null; locationId?: string | null; source?: PositionSource } = {}): Promise<HandlingUnit> {
    const code = opts.code ?? (await this.codes.prefixed(tx, 'PAL'));
    return tx.handlingUnit.create({
      data: {
        siteId,
        code,
        sscc: opts.sscc ?? null,
        lifecycle: 'RECEIVING',
        locationId: opts.locationId ?? null,
        positionSource: opts.locationId ? (opts.source ?? 'CONFIRMED_SCAN') : null,
        positionConfirmedAt: opts.locationId ? new Date() : null,
      },
    });
  }

  /** Lệnh điều chuyển pallet từ API (#115) — thực hiện ngay với bằng chứng quét đích nếu có. */
  async moveFromApi(siteId: string, huId: string, body: MovePalletRequest, canOverride: boolean) {
    if (body.overrideCapacity && !canOverride) throw DomainError.forbidden('Capacity override requires inventory.capacity.override (BR-19)');
    return this.tx.run(async (tx) => {
      const dest = await this.sites.requireLocation(tx, siteId, body.toLocationId);
      if (body.scanDestination && body.scanDestination !== dest.qrValue && body.scanDestination.toUpperCase() !== dest.code.toUpperCase()) {
        throw DomainError.rule(ErrorCode.DOCK_MISMATCH, `Scanned ${body.scanDestination} does not match ${dest.code}`);
      }
      return this.move(tx, {
        siteId,
        huId,
        toLocationId: body.toLocationId,
        reason: body.reason,
        source: body.scanDestination ? 'CONFIRMED_SCAN' : 'CONFIRMED_MANUAL',
        commandId: uuidv7(),
        overrideCapacity: body.overrideCapacity,
        expectedVersion: body.expectedVersion,
      });
    });
  }

  /**
   * Di chuyển cả pallet trong transaction của caller (BR-04, BR-12, BR-19):
   * khóa location → kiểm tra freeze + sức chứa → MOVE từng balance (reservation đi theo) → occupancy → movement → event.
   */
  async move(tx: Tx, options: MoveHuOptions): Promise<{ hu: HandlingUnit; changes: BalanceChange[] }> {
    const hu = await tx.handlingUnit.findFirst({ where: { id: options.huId, siteId: options.siteId } });
    if (!hu) throw DomainError.notFound('Pallet');
    if (options.expectedVersion !== undefined && hu.version !== options.expectedVersion) throw DomainError.concurrent();
    if (!options.internal && !['IN_STOCK', 'RECEIVING'].includes(hu.lifecycle)) {
      throw DomainError.rule(ErrorCode.HU_NOT_MOVABLE, `Pallet ${hu.code} is ${hu.lifecycle} — move it through its shipment flow`);
    }
    if (hu.locationId === options.toLocationId) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, 'Pallet is already at this location');
    await this.locks.lockForUpdate(tx, [options.toLocationId, ...(hu.locationId ? [hu.locationId] : [])]);
    const dest = await this.sites.requireLocation(tx, options.siteId, options.toLocationId);
    await this.sites.assertNotFrozen(tx, dest.id);
    if (hu.locationId) await this.sites.assertNotFrozen(tx, hu.locationId);

    // Sức chứa: occupancy nhiều đơn vị cho storage/staging; override cần quyền và lý do (BR-19)
    const current = await this.occupancy.activeByOccupant('HANDLING_UNIT', hu.id, tx);
    for (const occ of current) await this.occupancy.release(tx, occ.id);
    if (CAPACITY_TYPES.includes(dest.locationType)) {
      try {
        await this.occupancy.occupyDirect(tx, { siteId: options.siteId, locationId: dest.id, occupantType: 'HANDLING_UNIT', occupantId: hu.id }, options.source);
      } catch (err) {
        if (!(err instanceof DomainError) || err.code !== ErrorCode.LOCATION_CAPACITY_EXCEEDED || !options.overrideCapacity) throw err;
        await tx.locationOccupancy.create({
          data: { siteId: options.siteId, locationId: dest.id, occupantType: 'HANDLING_UNIT', occupantId: hu.id, kind: 'OCCUPIED', singleOccupancy: false, occupiedAt: new Date(), positionSource: options.source },
        });
        await this.audit.record(tx, { siteId: options.siteId, action: 'CAPACITY_OVERRIDDEN', entityType: 'Location', entityId: dest.id, reason: options.reason });
      }
    }

    const changes: BalanceChange[] = [];
    const txIds: bigint[] = [];
    if (hu.locationId) {
      const balances = await tx.inventoryBalance.findMany({ where: { handlingUnitId: hu.id, locationId: hu.locationId, qtyOnHand: { gt: 0 } }, orderBy: { id: 'asc' } });
      for (const [balanceIndex, balance] of balances.entries()) {
        const ledgerResult = await this.ledger.post(tx, {
          siteId: options.siteId,
          txType: 'MOVE',
          idempotencyKey: `${options.commandId}:move:${balanceIndex}`,
          skuId: balance.skuId,
          lotId: balance.lotId,
          handlingUnitId: hu.id,
          fromLocationId: hu.locationId,
          toLocationId: dest.id,
          fromStatus: balance.stockStatus,
          quantity: balance.qtyOnHand,
          carryReserved: balance.qtyReserved,
          referenceType: options.taskId ? 'TASK' : 'MOVE_ORDER',
          referenceId: options.taskId ?? options.commandId,
          receivedAt: balance.receivedAt,
        });
        changes.push(...ledgerResult.changes);
        txIds.push(ledgerResult.tx.id);
      }
    }
    const lifecycle = options.lifecycle ?? (dest.locationType === 'STORAGE' && hu.lifecycle === 'RECEIVING' ? 'IN_STOCK' : hu.lifecycle);
    const updated = await tx.handlingUnit.update({
      where: { id: hu.id },
      data: { locationId: dest.id, positionSource: options.source, positionConfirmedAt: new Date(), lifecycle, version: { increment: 1 } },
    });
    await this.movements.record(tx, {
      siteId: options.siteId,
      subjectType: 'HANDLING_UNIT',
      subjectId: hu.id,
      fromLocationId: hu.locationId,
      toLocationId: dest.id,
      positionSource: options.source,
      reason: options.reason,
      taskId: options.taskId,
    });
    await this.audit.record(tx, {
      siteId: options.siteId,
      action: 'INVENTORY_MOVED',
      entityType: 'HandlingUnit',
      entityId: hu.id,
      diff: { before: { locationId: hu.locationId, lifecycle: hu.lifecycle }, after: { locationId: dest.id, lifecycle } },
      reason: options.reason,
    });
    await this.events.inventoryUpdated(tx, options.siteId, changes, txIds);
    await this.events.palletMoved(tx, options.siteId, hu.id, hu.locationId, dest.id);
    return { hu: updated, changes };
  }

  /** Đổi lifecycle (pick/stage/load/dispatch) — gọi bởi Outbound trong transaction của nó. */
  async setLifecycle(tx: Tx, siteId: string, huId: string, lifecycle: HuLifecycle, opts: { clearLocation?: boolean } = {}) {
    const hu = await tx.handlingUnit.update({
      where: { id: huId },
      data: { lifecycle, version: { increment: 1 }, ...(opts.clearLocation ? { locationId: null, positionSource: null } : {}) },
    });
    if (opts.clearLocation) {
      for (const occ of await this.occupancy.activeByOccupant('HANDLING_UNIT', huId, tx)) await this.occupancy.release(tx, occ.id);
    }
    await this.events.palletMoved(tx, siteId, huId, hu.locationId, hu.locationId);
    return hu;
  }
}
