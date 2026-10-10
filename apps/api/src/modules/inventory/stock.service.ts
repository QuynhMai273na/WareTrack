import { Injectable } from '@nestjs/common';
import { Prisma, type InventoryTxType } from '@prisma/client';
import { type CreateAdjustmentRequest, type DecisionRequest, ErrorCode, type StatusChangeRequest } from '@waretrack/shared-schemas';
import { uuidv7 } from 'uuidv7';
import { AuditService } from '../../platform/audit/audit.service';
import { requirePrincipal } from '../../platform/auth/decorators';
import { CodeGenerator } from '../../platform/codes/code-generator';
import { DomainError } from '../../platform/errors/domain-error';
import { type Tx, TxRunner } from '../../platform/prisma/prisma.service';
import { SitesService } from '../sites/sites.service';
import { InventoryEvents } from './inventory-events.service';
import { LedgerService } from './ledger.service';

const D = Prisma.Decimal;

const REVERSIBLE: Partial<Record<InventoryTxType, InventoryTxType>> = {
  RECEIPT: 'RECEIPT_REVERSAL',
  ISSUE: 'ISSUE_REVERSAL',
  ADJUSTMENT_IN: 'ADJUSTMENT_OUT',
  ADJUSTMENT_OUT: 'ADJUSTMENT_IN',
};

/** Đổi trạng thái hàng, điều chỉnh có phê duyệt, đảo giao dịch (UC-17, FR-06.08, FR-16.03). */
@Injectable()
export class StockService {
  constructor(
    private readonly tx: TxRunner,
    private readonly ledger: LedgerService,
    private readonly events: InventoryEvents,
    private readonly audit: AuditService,
    private readonly sites: SitesService,
    private readonly codes: CodeGenerator,
  ) {}

  /** Đổi stock status (QUARANTINE/DAMAGED/AVAILABLE) — phần reserved phải được release trước (mục 9.6). */
  async changeStatus(siteId: string, body: StatusChangeRequest) {
    const principal = requirePrincipal();
    return this.tx.run(async (tx) => {
      const bal = await tx.inventoryBalance.findFirst({ where: { id: body.balanceId, siteId } });
      if (!bal) throw DomainError.notFound('Balance');
      if (bal.stockStatus === 'QUARANTINE' && body.toStatus === 'AVAILABLE' && !principal.permissions.has('inventory.status.release')) {
        throw DomainError.forbidden('Releasing quarantine requires Site Manager (inventory.status.release)');
      }
      const free = new D(bal.qtyOnHand).minus(bal.qtyReserved);
      if (bal.stockStatus === 'AVAILABLE' && new D(body.quantity).gt(free)) {
        throw DomainError.rule(ErrorCode.STOCK_RESERVED, `Only ${free.toFixed(3)} is unreserved — release reservations first`);
      }
      await this.sites.assertNotFrozen(tx, bal.locationId);
      const r = await this.ledger.post(tx, {
        siteId,
        txType: 'STATUS_CHANGE',
        idempotencyKey: `status:${uuidv7()}`,
        skuId: bal.skuId,
        lotId: bal.lotId,
        handlingUnitId: bal.handlingUnitId,
        fromLocationId: bal.locationId,
        fromStatus: bal.stockStatus,
        toStatus: body.toStatus,
        quantity: body.quantity,
        referenceType: 'STATUS_CHANGE',
        referenceId: bal.id,
        receivedAt: bal.receivedAt,
      });
      await this.audit.record(tx, { siteId, action: 'STOCK_STATUS_CHANGED', entityType: 'InventoryBalance', entityId: bal.id, diff: { before: { status: bal.stockStatus }, after: { status: body.toStatus, qty: body.quantity } }, reason: body.reason });
      await this.events.inventoryUpdated(tx, siteId, r.changes, [r.tx.id]);
      if (bal.handlingUnitId) await this.events.palletMoved(tx, siteId, bal.handlingUnitId, bal.locationId, bal.locationId);
      return r.changes;
    });
  }

  /** UC-17 bước 1–2: đề nghị điều chỉnh; xác định cấp duyệt theo ngưỡng DEC-14. */
  async requestAdjustment(siteId: string, body: CreateAdjustmentRequest, stockCountLineId?: string, txArg?: Tx) {
    const run = async (tx: Tx) => {
      const bal = await tx.inventoryBalance.findFirst({ where: { id: body.balanceId, siteId } });
      if (!bal) throw DomainError.notFound('Balance');
      const settings = await this.sites.settings(siteId, tx);
      const delta = new D(body.qtyDelta);
      const onHand = new D(bal.qtyOnHand);
      const pct = onHand.gt(0) ? delta.abs().div(onHand).times(100) : new D(100);
      const requiresManager = delta.abs().gt(settings.adjustApprovalThreshold.maxUnits) || pct.gt(settings.adjustApprovalThreshold.maxPct);
      const adj = await tx.stockAdjustment.create({
        data: {
          siteId,
          code: await this.codes.prefixed(tx, 'ADJ', 5),
          balanceId: bal.id,
          stockCountLineId: stockCountLineId ?? null,
          qtyDelta: delta,
          reasonCode: body.reasonCode,
          note: body.note ?? null,
          requiresManager,
          requestedById: requirePrincipal().userId,
        },
      });
      await this.audit.record(tx, { siteId, action: 'ADJUSTMENT_REQUESTED', entityType: 'StockAdjustment', entityId: adj.id, diff: { after: { qtyDelta: body.qtyDelta, requiresManager } }, reason: body.note ?? body.reasonCode });
      return adj;
    };
    return txArg ? run(txArg) : this.tx.run(run);
  }

  /** UC-17 bước 3–4: duyệt (maker-checker) và ghi ADJUSTMENT_IN/OUT. */
  async approveAdjustment(siteId: string, adjustmentId: string, body: DecisionRequest) {
    const principal = requirePrincipal();
    return this.tx.run(async (tx) => {
      const adj = await tx.stockAdjustment.findFirst({ where: { id: adjustmentId, siteId } });
      if (!adj) throw DomainError.notFound('Adjustment');
      if (adj.status !== 'PENDING_APPROVAL') throw DomainError.invalidTransition('StockAdjustment', adj.status, 'APPLIED');
      if (adj.version !== body.expectedVersion) throw DomainError.concurrent();
      if (adj.requestedById === principal.userId) throw new DomainError(403, ErrorCode.MAKER_CHECKER_VIOLATION, 'The requester cannot approve their own adjustment (BR-26)');
      if (adj.requiresManager && !principal.roles.includes('SITE_MANAGER')) {
        throw DomainError.forbidden('This adjustment exceeds the threshold and needs a Site Manager (DEC-14)');
      }
      const bal = await tx.inventoryBalance.findUniqueOrThrow({ where: { id: adj.balanceId } });
      const delta = new D(adj.qtyDelta);
      if (delta.lt(0)) {
        const after = new D(bal.qtyOnHand).plus(delta);
        if (after.lt(0)) throw DomainError.rule(ErrorCode.NEGATIVE_STOCK, 'Adjustment would make stock negative');
        if (after.lt(bal.qtyReserved)) throw DomainError.rule(ErrorCode.ADJUSTMENT_CONFLICTS_RESERVATION, 'Release reservations before reducing reserved stock (UC-17 E1)');
      }
      await this.sites.assertNotFrozen(tx, bal.locationId).catch((err) => {
        if (!adj.stockCountLineId) throw err; // điều chỉnh từ chính đợt kiểm kê được phép trên location đang freeze
      });
      const r = await this.ledger.post(tx, {
        siteId,
        txType: delta.gt(0) ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
        idempotencyKey: `adjustment:${adj.id}`,
        skuId: bal.skuId,
        lotId: bal.lotId,
        handlingUnitId: bal.handlingUnitId,
        fromLocationId: delta.lt(0) ? bal.locationId : null,
        toLocationId: delta.gt(0) ? bal.locationId : null,
        fromStatus: delta.lt(0) ? bal.stockStatus : null,
        toStatus: delta.gt(0) ? bal.stockStatus : null,
        quantity: delta.abs(),
        referenceType: 'STOCK_ADJUSTMENT',
        referenceId: adj.id,
        receivedAt: bal.receivedAt,
      });
      const res = await tx.stockAdjustment.updateMany({
        where: { id: adj.id, version: adj.version },
        data: { status: 'APPLIED', approvedById: principal.userId, decidedAt: new Date(), decisionNote: body.note ?? null, appliedTxId: r.tx.id, version: { increment: 1 } },
      });
      if (res.count === 0) throw DomainError.concurrent();
      await this.audit.record(tx, { siteId, action: 'ADJUSTMENT_APPROVED', entityType: 'StockAdjustment', entityId: adj.id, reason: body.note ?? null });
      await this.events.inventoryUpdated(tx, siteId, r.changes, [r.tx.id]);
      if (bal.handlingUnitId) await this.events.palletMoved(tx, siteId, bal.handlingUnitId, bal.locationId, bal.locationId);
      return adj.id;
    });
  }

  async rejectAdjustment(siteId: string, adjustmentId: string, body: DecisionRequest & { reason?: string }) {
    const principal = requirePrincipal();
    return this.tx.run(async (tx) => {
      const adj = await tx.stockAdjustment.findFirst({ where: { id: adjustmentId, siteId } });
      if (!adj) throw DomainError.notFound('Adjustment');
      if (adj.status !== 'PENDING_APPROVAL') throw DomainError.invalidTransition('StockAdjustment', adj.status, 'REJECTED');
      const res = await tx.stockAdjustment.updateMany({
        where: { id: adj.id, version: body.expectedVersion },
        data: { status: 'REJECTED', approvedById: principal.userId === adj.requestedById ? null : principal.userId, decidedAt: new Date(), decisionNote: body.note ?? null, version: { increment: 1 } },
      });
      if (res.count === 0) throw DomainError.concurrent();
      await this.audit.record(tx, { siteId, action: 'ADJUSTMENT_REJECTED', entityType: 'StockAdjustment', entityId: adj.id, reason: body.note ?? null });
      return adj.id;
    });
  }

  /** Đảo giao dịch bằng giao dịch bù — không sửa/xóa giao dịch gốc (BR-07). */
  async reverse(siteId: string, txId: bigint, reason: string) {
    return this.tx.run(async (tx) => {
      const orig = await tx.inventoryTransaction.findFirst({ where: { id: txId, siteId } });
      if (!orig) throw DomainError.notFound('Inventory transaction');
      const inverse = REVERSIBLE[orig.txType];
      if (!inverse || orig.reversesTxId) throw DomainError.rule(ErrorCode.NOT_REVERSIBLE, `${orig.txType} transactions cannot be reversed here`);
      if (await tx.inventoryTransaction.findFirst({ where: { reversesTxId: orig.id } })) throw DomainError.conflict(ErrorCode.ALREADY_REVERSED, 'This transaction was already reversed');
      const r = await this.ledger.post(tx, {
        siteId,
        txType: inverse,
        idempotencyKey: `reversal:${orig.id}`,
        skuId: orig.skuId,
        lotId: orig.lotId,
        handlingUnitId: orig.handlingUnitId,
        serialUnitId: orig.serialUnitId,
        fromLocationId: orig.toLocationId,
        toLocationId: orig.fromLocationId,
        fromStatus: orig.toStatus,
        toStatus: orig.fromStatus,
        quantity: orig.quantity,
        referenceType: 'REVERSAL',
        referenceId: String(orig.id),
        reversesTxId: orig.id,
      });
      await this.audit.record(tx, { siteId, action: 'INVENTORY_TX_REVERSED', entityType: 'InventoryTransaction', entityId: String(orig.id), reason: `HIGH_SEVERITY: ${reason}` });
      await this.events.inventoryUpdated(tx, siteId, r.changes, [r.tx.id]);
      return r.tx;
    });
  }
}
