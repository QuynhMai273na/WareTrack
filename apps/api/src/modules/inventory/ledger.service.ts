import { Injectable } from '@nestjs/common';
import { Prisma, type InventoryBalance, type InventoryTransaction, type InventoryTxType, type StockStatus } from '@prisma/client';
import { ErrorCode } from '@waretrack/shared-schemas';
import { uuidv7 } from 'uuidv7';
import { currentContext } from '../../platform/context/request-context';
import { DomainError } from '../../platform/errors/domain-error';
import type { Tx } from '../../platform/prisma/prisma.service';

const D = Prisma.Decimal;
type Dec = Prisma.Decimal;

export interface LedgerLine {
  siteId: string;
  txType: InventoryTxType;
  /** Khóa tất định của lệnh nghiệp vụ, ví dụ `${commandId}:${lineNo}` (BR-20). */
  idempotencyKey: string;
  skuId: string;
  lotId?: string | null;
  handlingUnitId?: string | null;
  serialUnitId?: string | null;
  fromLocationId?: string | null;
  toLocationId?: string | null;
  fromStatus?: StockStatus | null;
  toStatus?: StockStatus | null;
  quantity: Prisma.Decimal | number | string;
  referenceType: string;
  referenceId: string;
  reversesTxId?: bigint | null;
  /** MOVE cả balance kèm phần đã reserve: chuyển qtyReserved và re-point reservation sang balance đích. */
  carryReserved?: Prisma.Decimal | number | string;
  /** MOVE sang pallet khác (pick lẻ ra pallet xuất mới); mặc định cùng pallet. */
  toHandlingUnitId?: string | null;
  /** Chỉ re-point các reservation này (pick lẻ) thay vì mọi reservation của balance nguồn. */
  repointReservationIds?: string[];
  /** ISSUE tiêu thụ hàng đã reserve: giảm qtyReserved cùng lúc (Reservation.consume đã ghi trạng thái). */
  consumeReserved?: boolean;
  receivedAt?: Date;
}

export interface BalanceChange {
  balanceId: string;
  skuId: string;
  locationId: string;
  lotId: string | null;
  handlingUnitId: string | null;
  stockStatus: StockStatus;
  qtyOnHand: string;
  qtyReserved: string;
  balanceVersion: number;
}

export interface LedgerResult {
  tx: InventoryTransaction;
  replayed: boolean;
  changes: BalanceChange[];
}

interface Delta {
  locationId: string;
  status: StockStatus;
  onHand: Dec;
  reserved: Dec;
  /** Pallet của balance; undefined = pallet của dòng ledger. */
  huId?: string | null;
}

const fmt = (d: Dec) => d.toFixed(3);

/**
 * Sổ cái tồn kho (FR-06.05, BR-02, BR-20): mọi thay đổi số lượng đi qua đây, trong transaction của caller.
 * - idempotencyKey trùng → trả giao dịch cũ, không đổi balance;
 * - balance được khóa FOR UPDATE; kiểm tra không âm & không vượt available trước khi ghi (check constraint là chốt cuối).
 */
@Injectable()
export class LedgerService {
  async post(tx: Tx, line: LedgerLine): Promise<LedgerResult> {
    const existing = await tx.inventoryTransaction.findUnique({ where: { idempotencyKey: line.idempotencyKey } });
    if (existing) return { tx: existing, replayed: true, changes: [] };

    const qty = new D(line.quantity);
    if (qty.lte(0)) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, 'Quantity must be positive');
    const sku = await tx.sku.findUnique({ where: { id: line.skuId } });
    if (!sku) throw DomainError.notFound('SKU');
    if (sku.lotTracked && !line.lotId) throw DomainError.rule(ErrorCode.LOT_REQUIRED, `SKU ${sku.code} requires a lot (BR-25)`);
    if (qty.decimalPlaces() > sku.uomDecimals) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, `SKU ${sku.code} allows ${sku.uomDecimals} decimal places`);

    const carry = new D(line.carryReserved ?? 0);
    const deltas = this.deltas(line, qty, carry);
    const changes: BalanceChange[] = [];
    let sourceBalanceId: string | null = null;
    let destBalanceId: string | null = null;

    // Giảm trước, tăng sau — để lỗi thiếu hàng xuất hiện trước khi tạo balance mới
    for (const d of deltas.sort((a, b) => a.onHand.comparedTo(b.onHand))) {
      const bal = await this.lockBalance(tx, line, d, line.receivedAt);
      const onHand = new D(bal.qtyOnHand).plus(d.onHand);
      const reserved = new D(bal.qtyReserved).plus(d.reserved);
      if (d.onHand.lt(0)) {
        const available = new D(bal.qtyOnHand).minus(bal.qtyReserved);
        const needFree = d.onHand.neg().minus(d.reserved.neg());
        if (onHand.lt(0)) throw DomainError.rule(ErrorCode.NEGATIVE_STOCK, `Not enough stock (${fmt(new D(bal.qtyOnHand))} on hand)`, { onHand: fmt(new D(bal.qtyOnHand)) });
        if (needFree.gt(available)) {
          throw DomainError.rule(ErrorCode.INSUFFICIENT_AVAILABLE_STOCK, `Only ${fmt(available)} available — the rest is reserved`, { available: fmt(available), reserved: fmt(new D(bal.qtyReserved)) });
        }
        sourceBalanceId = bal.id;
      } else {
        destBalanceId = bal.id;
      }
      if (reserved.lt(0) || reserved.gt(onHand)) throw DomainError.rule(ErrorCode.STOCK_RESERVED, 'Reserved quantity would exceed on-hand');
      const updated = await tx.inventoryBalance.update({
        where: { id: bal.id },
        data: { qtyOnHand: onHand, qtyReserved: reserved, version: { increment: 1 } },
      });
      changes.push(this.change(updated));
    }

    // Reservation đi theo hàng khi chuyển cả balance (UC-15-AC2)
    if (carry.gt(0) && sourceBalanceId && destBalanceId) {
      await tx.reservation.updateMany({
        where: { balanceId: sourceBalanceId, status: { in: ['ACTIVE', 'PICKED'] }, ...(line.repointReservationIds ? { id: { in: line.repointReservationIds } } : {}) },
        data: { balanceId: destBalanceId },
      });
    }

    const created = await tx.inventoryTransaction.create({
      data: {
        siteId: line.siteId,
        txType: line.txType,
        idempotencyKey: line.idempotencyKey,
        skuId: line.skuId,
        lotId: line.lotId ?? null,
        handlingUnitId: line.handlingUnitId ?? null,
        serialUnitId: line.serialUnitId ?? null,
        fromLocationId: line.fromLocationId ?? null,
        toLocationId: line.toLocationId ?? null,
        fromStatus: line.fromStatus ?? null,
        toStatus: line.toStatus ?? null,
        quantity: qty,
        referenceType: line.referenceType,
        referenceId: line.referenceId,
        reversesTxId: line.reversesTxId ?? null,
        actorId: currentContext()?.principal?.userId ?? null,
      },
    });
    return { tx: created, replayed: false, changes };
  }

  private deltas(line: LedgerLine, qty: Dec, carry: Dec): Delta[] {
    const zero = new D(0);
    const need = (v: string | null | undefined, name: string) => {
      if (!v) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, `${name} is required for ${line.txType}`);
      return v;
    };
    switch (line.txType) {
      case 'RECEIPT':
      case 'ADJUSTMENT_IN':
      case 'ISSUE_REVERSAL':
        return [{ locationId: need(line.toLocationId, 'toLocationId'), status: line.toStatus ?? 'AVAILABLE', onHand: qty, reserved: zero }];
      case 'ISSUE':
      case 'ADJUSTMENT_OUT':
      case 'RECEIPT_REVERSAL':
        return [
          {
            locationId: need(line.fromLocationId, 'fromLocationId'),
            status: line.fromStatus ?? 'AVAILABLE',
            onHand: qty.neg(),
            reserved: line.consumeReserved ? qty.neg() : zero,
          },
        ];
      case 'MOVE': {
        const status = line.fromStatus ?? 'AVAILABLE';
        if (line.fromLocationId === line.toLocationId && (line.toHandlingUnitId === undefined || line.toHandlingUnitId === line.handlingUnitId)) {
          throw DomainError.rule(ErrorCode.VALIDATION_ERROR, 'Source and destination must differ');
        }
        const toHu = line.toHandlingUnitId !== undefined ? line.toHandlingUnitId : (line.handlingUnitId ?? null);
        return [
          { locationId: need(line.fromLocationId, 'fromLocationId'), status, onHand: qty.neg(), reserved: carry.neg() },
          { locationId: need(line.toLocationId, 'toLocationId'), status, onHand: qty, reserved: carry, huId: toHu },
        ];
      }
      case 'STATUS_CHANGE': {
        const loc = need(line.fromLocationId ?? line.toLocationId, 'location');
        const from = line.fromStatus ?? 'AVAILABLE';
        const to = line.toStatus ?? 'AVAILABLE';
        if (from === to) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, 'Status must change');
        return [
          { locationId: loc, status: from, onHand: qty.neg(), reserved: zero },
          { locationId: loc, status: to, onHand: qty, reserved: zero },
        ];
      }
    }
  }

  /** Lấy (hoặc tạo) balance theo khóa và khóa FOR UPDATE — NULL-safe cho lot/HU. */
  private async lockBalance(tx: Tx, line: LedgerLine, d: Delta, receivedAt?: Date): Promise<InventoryBalance> {
    const lotId = line.lotId ?? null;
    const huId = d.huId !== undefined ? d.huId : (line.handlingUnitId ?? null);
    if (d.onHand.gt(0)) {
      await tx.$executeRaw`
        INSERT INTO inventory_balance (id, site_id, location_id, sku_id, lot_id, handling_unit_id, stock_status, qty_on_hand, qty_reserved, received_at, version, updated_at)
        VALUES (${uuidv7()}::uuid, ${line.siteId}::uuid, ${d.locationId}::uuid, ${line.skuId}::uuid, ${lotId}::uuid, ${huId}::uuid,
                ${d.status}::"StockStatus", 0, 0, ${receivedAt ?? new Date()}, 0, now())
        ON CONFLICT (site_id, location_id, sku_id, lot_id, handling_unit_id, stock_status) WHERE qty_on_hand >= 0 DO NOTHING`;
    }
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM inventory_balance
      WHERE site_id = ${line.siteId}::uuid AND location_id = ${d.locationId}::uuid AND sku_id = ${line.skuId}::uuid
        AND lot_id IS NOT DISTINCT FROM ${lotId}::uuid AND handling_unit_id IS NOT DISTINCT FROM ${huId}::uuid
        AND stock_status = ${d.status}::"StockStatus"
      FOR UPDATE`;
    if (rows.length === 0) throw DomainError.rule(ErrorCode.NEGATIVE_STOCK, 'No stock at the source for this SKU / lot / pallet / status');
    return tx.inventoryBalance.findUniqueOrThrow({ where: { id: rows[0].id } });
  }

  change(b: InventoryBalance): BalanceChange {
    return {
      balanceId: b.id,
      skuId: b.skuId,
      locationId: b.locationId,
      lotId: b.lotId,
      handlingUnitId: b.handlingUnitId,
      stockStatus: b.stockStatus,
      qtyOnHand: new D(b.qtyOnHand).toFixed(3),
      qtyReserved: new D(b.qtyReserved).toFixed(3),
      balanceVersion: b.version,
    };
  }
}
