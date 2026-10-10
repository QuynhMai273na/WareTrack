import { Injectable } from '@nestjs/common';
import { Prisma, type Reservation } from '@prisma/client';
import { ErrorCode } from '@waretrack/shared-schemas';
import { DomainError } from '../../platform/errors/domain-error';
import type { Tx } from '../../platform/prisma/prisma.service';
import type { BalanceChange } from './ledger.service';
import { LedgerService } from './ledger.service';

const D = Prisma.Decimal;

export interface ReserveRequest {
  siteId: string;
  outboundOrderLineId: string;
  shipmentId?: string | null;
  skuId: string;
  lotId?: string | null;
  quantity: Prisma.Decimal | string | number;
  allOrNothing?: boolean;
}

export interface ReserveResult {
  reserved: Prisma.Decimal;
  shortage: Prisma.Decimal;
  reservations: Reservation[];
  changes: BalanceChange[];
}

/**
 * ReservationPort (mục 13.2 Inventory, UC-11): phân bổ tồn AVAILABLE theo FIFO/FEFO (DEC-09),
 * khóa balance FOR UPDATE theo thứ tự id (chống deadlock), không bao giờ vượt available (BR-02).
 */
@Injectable()
export class ReservationService {
  constructor(private readonly ledger: LedgerService) {}

  async reserve(tx: Tx, r: ReserveRequest): Promise<ReserveResult> {
    const sku = await tx.sku.findUniqueOrThrow({ where: { id: r.skuId } });
    const today = new Date(new Date().toISOString().slice(0, 10));
    const candidates = await tx.$queryRaw<{ id: string }[]>`
      SELECT b.id FROM inventory_balance b
      JOIN location l ON l.id = b.location_id
      LEFT JOIN lot ON lot.id = b.lot_id
      WHERE b.site_id = ${r.siteId}::uuid AND b.sku_id = ${r.skuId}::uuid AND b.stock_status = 'AVAILABLE'
        AND b.qty_on_hand > b.qty_reserved
        AND l.location_type IN ('STORAGE', 'STAGING') AND l.blocked_at IS NULL AND l.frozen_by_count_id IS NULL
        AND (${r.lotId ?? null}::uuid IS NULL OR b.lot_id = ${r.lotId ?? null}::uuid)
        AND (lot.expires_on IS NULL OR lot.expires_on >= ${today}::date)
      ORDER BY b.id
      FOR UPDATE OF b`;
    if (candidates.length === 0 && r.allOrNothing) throw DomainError.rule(ErrorCode.INSUFFICIENT_AVAILABLE_STOCK, `No available stock for ${sku.code}`);
    const balances = await tx.inventoryBalance.findMany({ where: { id: { in: candidates.map((c) => c.id) } } });
    const lots = new Map((await tx.lot.findMany({ where: { id: { in: balances.map((b) => b.lotId).filter((x): x is string => !!x) } } })).map((l) => [l.id, l]));
    // FEFO: hạn dùng sớm nhất trước; FIFO: nhận sớm nhất trước (DEC-09)
    balances.sort((a, b) => {
      if (sku.allocationStrategy === 'FEFO') {
        const ea = (a.lotId && lots.get(a.lotId)?.expiresOn?.getTime()) || Number.MAX_SAFE_INTEGER;
        const eb = (b.lotId && lots.get(b.lotId)?.expiresOn?.getTime()) || Number.MAX_SAFE_INTEGER;
        if (ea !== eb) return ea - eb;
      }
      return a.receivedAt.getTime() - b.receivedAt.getTime();
    });
    let remaining = new D(r.quantity);
    const totalAvailable = balances.reduce((s, b) => s.plus(new D(b.qtyOnHand).minus(b.qtyReserved)), new D(0));
    if (r.allOrNothing && totalAvailable.lt(remaining)) {
      throw DomainError.rule(ErrorCode.INSUFFICIENT_AVAILABLE_STOCK, `Only ${totalAvailable.toFixed(3)} ${sku.baseUom} of ${sku.code} available`, { available: totalAvailable.toFixed(3) });
    }
    const reservations: Reservation[] = [];
    const changes: BalanceChange[] = [];
    for (const b of balances) {
      if (remaining.lte(0)) break;
      const free = new D(b.qtyOnHand).minus(b.qtyReserved);
      const take = Prisma.Decimal.min(free, remaining);
      if (take.lte(0)) continue;
      const updated = await tx.inventoryBalance.update({ where: { id: b.id }, data: { qtyReserved: { increment: take }, version: { increment: 1 } } });
      changes.push(this.ledger.change(updated));
      reservations.push(
        await tx.reservation.create({ data: { siteId: r.siteId, balanceId: b.id, outboundOrderLineId: r.outboundOrderLineId, shipmentId: r.shipmentId ?? null, quantity: take } }),
      );
      remaining = remaining.minus(take);
    }
    const requested = new D(r.quantity);
    return { reserved: requested.minus(Prisma.Decimal.max(remaining, 0)), shortage: Prisma.Decimal.max(remaining, 0), reservations, changes };
  }

  /** Giải phóng reservation ACTIVE/PICKED — trả lại phần reserved cho balance. */
  async release(tx: Tx, reservationIds: string[]): Promise<BalanceChange[]> {
    const changes: BalanceChange[] = [];
    const rows = await tx.reservation.findMany({ where: { id: { in: reservationIds }, status: { in: ['ACTIVE', 'PICKED'] } }, orderBy: { balanceId: 'asc' } });
    for (const res of rows) {
      await tx.$queryRaw`SELECT id FROM inventory_balance WHERE id = ${res.balanceId}::uuid FOR UPDATE`;
      const updated = await tx.inventoryBalance.update({ where: { id: res.balanceId }, data: { qtyReserved: { decrement: res.quantity }, version: { increment: 1 } } });
      changes.push(this.ledger.change(updated));
      await tx.reservation.update({ where: { id: res.id }, data: { status: 'RELEASED', version: { increment: 1 } } });
    }
    return changes;
  }

  async markPicked(tx: Tx, reservationId: string) {
    await tx.reservation.update({ where: { id: reservationId }, data: { status: 'PICKED', version: { increment: 1 } } });
  }

  /** Dispatch: ISSUE giảm on-hand và reserved đúng một lần, reservation → CONSUMED (BR-22). */
  async consume(tx: Tx, reservation: Reservation, commandId: string, referenceId: string) {
    const bal = await tx.inventoryBalance.findUniqueOrThrow({ where: { id: reservation.balanceId } });
    const r = await this.ledger.post(tx, {
      siteId: reservation.siteId,
      txType: 'ISSUE',
      idempotencyKey: `${commandId}:issue:${reservation.id}`,
      skuId: bal.skuId,
      lotId: bal.lotId,
      handlingUnitId: bal.handlingUnitId,
      fromLocationId: bal.locationId,
      fromStatus: 'AVAILABLE',
      quantity: reservation.quantity,
      consumeReserved: true,
      referenceType: 'SHIPMENT',
      referenceId,
    });
    if (!r.replayed) await tx.reservation.update({ where: { id: reservation.id }, data: { status: 'CONSUMED', version: { increment: 1 } } });
    return r;
  }
}
