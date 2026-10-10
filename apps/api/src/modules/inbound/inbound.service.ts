import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, type HandlingUnit, type OperationTask } from '@prisma/client';
import { type CreateInboundOrderRequest, ErrorCode, type InboundOrderDetail, type QcRequest, type ReceiptDetail, type ReceiptLineRequest } from '@waretrack/shared-schemas';
import { uuidv7 } from 'uuidv7';
import { AuditService } from '../../platform/audit/audit.service';
import { requirePrincipal } from '../../platform/auth/decorators';
import { CodeGenerator } from '../../platform/codes/code-generator';
import { DomainError } from '../../platform/errors/domain-error';
import { PrismaService, type Tx, TxRunner } from '../../platform/prisma/prisma.service';
import { DashboardContributors } from '../dashboard/contributors';
import { InventoryEvents } from '../inventory/inventory-events.service';
import { LedgerService } from '../inventory/ledger.service';
import { PalletsService } from '../inventory/pallets.service';
import { MovementService } from '../operations/movement.service';
import { ExceptionsService } from '../operations/exceptions.service';
import { TasksService } from '../operations/tasks.service';
import { ShipmentsService } from '../shipments/shipments.service';
import { SitesService } from '../sites/sites.service';
import { VisitsService } from '../yard/visits.service';

const D = Prisma.Decimal;

/** Inbound: đơn nhập, nhận hàng theo từng lần quét, sai lệch, QC, put-away (UC-08, UC-09, UC-10). */
@Injectable()
export class InboundService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TxRunner,
    private readonly audit: AuditService,
    private readonly codes: CodeGenerator,
    private readonly ledger: LedgerService,
    private readonly pallets: PalletsService,
    private readonly events: InventoryEvents,
    private readonly movements: MovementService,
    private readonly tasks: TasksService,
    private readonly exceptions: ExceptionsService,
    private readonly shipments: ShipmentsService,
    private readonly visits: VisitsService,
    private readonly sites: SitesService,
    private readonly contributors: DashboardContributors,
  ) {}

  onModuleInit() {
    // Put-away: được phép đặt vào vị trí khác gợi ý nếu hợp lệ (UC-10 A1)
    this.tasks.registerHandler('PUTAWAY', {
      allowAlternativeDestination: true,
      complete: async (tx, task, ctx) => {
        await this.pallets.move(tx, {
          siteId: task.siteId,
          huId: task.subjectId,
          toLocationId: ctx.destinationLocationId,
          reason: 'Put-away',
          source: ctx.source,
          commandId: task.id,
          taskId: task.id,
          lifecycle: 'IN_STOCK',
          internal: true,
        });
      },
    });
    // K-08 Put-away completed hôm nay (pallets)
    this.contributors.addKpis(async (siteId, { todayStart, now }) => [
      {
        key: 'PUTAWAY_COMPLETED',
        value: await this.prisma.operationTask.count({ where: { siteId, taskType: 'PUTAWAY', status: 'COMPLETED', completedAt: { gte: todayStart } } }),
        unit: 'pallets',
        deltaPeriod: 'today',
        asOf: now.toISOString(),
      },
    ]);
  }

  // ───────────── Orders ─────────────

  async createOrder(siteId: string, body: CreateInboundOrderRequest): Promise<InboundOrderDetail> {
    const id = await this.tx.run(async (tx) => {
      let visit = null;
      if (body.truckVisitId) {
        visit = await tx.truckVisit.findFirst({ where: { id: body.truckVisitId, siteId }, include: { truck: true } });
        if (!visit) throw DomainError.notFound('Visit');
      }
      const order = await tx.inboundOrder.create({
        data: {
          siteId,
          code: await this.codes.prefixed(tx, 'IN', 5),
          supplierId: body.supplierId ?? null,
          status: 'CONFIRMED',
          expectedOn: body.expectedOn ? new Date(body.expectedOn) : null,
          lines: { create: body.lines.map((l) => ({ siteId, skuId: l.skuId, expectedQty: new D(l.expectedQty), expectedHuCount: l.expectedHuCount ?? null, expectedLotNumber: l.expectedLotNumber ?? null })) },
        },
      });
      const arrived = visit && !['SCHEDULED'].includes(visit.status);
      const shipment = await this.shipments.create(tx, {
        siteId,
        direction: 'INBOUND',
        status: 'EXPECTED',
        partnerId: body.supplierId ?? null,
        carrierId: visit?.truck.carrierId ?? null,
        truckVisitId: visit?.id ?? null,
        etaAt: body.etaAt ? new Date(body.etaAt) : (visit?.etaAt ?? visit?.appointmentStart ?? null),
        expectedHuCount: body.lines.reduce((s, l) => s + (l.expectedHuCount ?? 0), 0),
      });
      if (arrived) await this.shipments.transition(tx, shipment, 'ARRIVED', { arrivedAt: visit!.arrivedAt ?? new Date() });
      await tx.inboundOrder.update({ where: { id: order.id }, data: { shipmentId: shipment.id } });
      await this.audit.record(tx, { siteId, action: 'INBOUND_ORDER_CREATED', entityType: 'InboundOrder', entityId: order.id, diff: { after: { code: order.code, lines: body.lines.length } } });
      return order.id;
    });
    return this.getOrder(siteId, id);
  }

  async listOrders(siteId: string): Promise<InboundOrderDetail[]> {
    const rows = await this.prisma.inboundOrder.findMany({ where: { siteId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return Promise.all(rows.map((r) => this.getOrder(siteId, r.id)));
  }

  async getOrder(siteId: string, id: string): Promise<InboundOrderDetail> {
    const o = await this.prisma.inboundOrder.findFirst({ where: { id, siteId }, include: { lines: true } });
    if (!o) throw DomainError.notFound('Inbound order');
    const [supplier, shipment, skus, receipt] = await Promise.all([
      o.supplierId ? this.prisma.partner.findUnique({ where: { id: o.supplierId } }) : null,
      o.shipmentId ? this.prisma.shipment.findUnique({ where: { id: o.shipmentId } }) : null,
      this.prisma.sku.findMany({ where: { id: { in: o.lines.map((l) => l.skuId) } } }),
      this.prisma.receipt.findFirst({ where: { inboundOrderId: o.id }, orderBy: { startedAt: 'desc' } }),
    ]);
    const ms = new Map(skus.map((s) => [s.id, s]));
    return {
      id: o.id,
      code: o.code,
      status: o.status,
      supplier: supplier ? { id: supplier.id, name: supplier.name } : null,
      expectedOn: o.expectedOn?.toISOString().slice(0, 10) ?? null,
      shipment: shipment ? { id: shipment.id, code: shipment.code, status: shipment.status, visitId: shipment.truckVisitId } : null,
      lines: o.lines.map((l) => {
        const s = ms.get(l.skuId)!;
        return {
          id: l.id,
          sku: { id: s.id, code: s.code, name: s.name, lotTracked: s.lotTracked, qcRequired: s.qcRequired },
          expectedQty: new D(l.expectedQty).toFixed(3),
          expectedHuCount: l.expectedHuCount,
          expectedLotNumber: l.expectedLotNumber,
          receivedQty: new D(l.receivedQty).toFixed(3),
        };
      }),
      receipt: receipt ? { id: receipt.id, code: receipt.code, status: receipt.status } : null,
      version: o.version,
    };
  }

  // ───────────── Receipts ─────────────

  /** UC-08 bước 1: bắt đầu nhận — visit AT_DOCK → HANDLING, shipment → UNLOADING. */
  async startReceipt(siteId: string, inboundOrderId: string): Promise<ReceiptDetail> {
    const id = await this.tx.run(async (tx) => {
      const order = await tx.inboundOrder.findFirst({ where: { id: inboundOrderId, siteId } });
      if (!order || !order.shipmentId) throw DomainError.notFound('Inbound order');
      if (!['CONFIRMED', 'RECEIVING'].includes(order.status)) throw DomainError.invalidTransition('InboundOrder', order.status, 'RECEIVING');
      const open = await tx.receipt.findFirst({ where: { inboundOrderId, status: 'IN_PROGRESS' } });
      if (open) return open.id;
      let shipment = await this.shipments.load(tx, siteId, order.shipmentId);
      if (!shipment.truckVisitId) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, 'Assign the inbound shipment to a truck visit first');
      const visit = await tx.truckVisit.findUniqueOrThrow({ where: { id: shipment.truckVisitId } });
      if (!['AT_DOCK', 'HANDLING'].includes(visit.status) || !visit.dockLocationId) {
        throw DomainError.invalidTransition('TruckVisit', visit.status, 'HANDLING');
      }
      if (shipment.status === 'EXPECTED') {
        await this.shipments.transition(tx, shipment, 'ARRIVED', { arrivedAt: visit.arrivedAt ?? new Date() });
        shipment = await this.shipments.load(tx, siteId, shipment.id);
      }
      await this.shipments.transition(tx, shipment, 'UNLOADING');
      await this.visits.markHandlingStarted(tx, siteId, visit.id);
      const receipt = await tx.receipt.create({
        data: { siteId, code: await this.codes.prefixed(tx, 'RCV', 5), inboundOrderId, shipmentId: shipment.id, dockLocationId: visit.dockLocationId },
      });
      await tx.inboundOrder.update({ where: { id: order.id }, data: { status: 'RECEIVING', version: { increment: 1 } } });
      await this.audit.record(tx, { siteId, action: 'RECEIPT_STARTED', entityType: 'Receipt', entityId: receipt.id });
      return receipt.id;
    });
    return this.getReceipt(siteId, id);
  }

  /** UC-08 bước 2–4: một lần quét = một pallet nhận vào dock (ledger RECEIPT). */
  async scanLine(siteId: string, receiptId: string, body: ReceiptLineRequest, idemKey: string): Promise<ReceiptDetail> {
    await this.tx.run(async (tx) => {
      const r = await tx.receipt.findFirst({ where: { id: receiptId, siteId } });
      if (!r) throw DomainError.notFound('Receipt');
      if (r.status !== 'IN_PROGRESS') throw DomainError.invalidTransition('Receipt', r.status, 'IN_PROGRESS');
      const existing = await tx.receiptLine.findUnique({ where: { idempotencyKey: `rl:${idemKey}` } });
      if (existing) return;
      const sku = await tx.sku.findUnique({ where: { id: body.skuId } });
      if (!sku) throw DomainError.notFound('SKU');
      const orderLine = await tx.inboundOrderLine.findFirst({ where: { inboundOrderId: r.inboundOrderId, skuId: sku.id } });
      if (!orderLine) throw DomainError.rule(ErrorCode.SKU_NOT_IN_ORDER, `${sku.code} is not on this inbound order (UC-08 E1)`);
      let lotId: string | null = null;
      if (sku.lotTracked) {
        if (!body.lotNumber) throw DomainError.rule(ErrorCode.LOT_REQUIRED, `${sku.code} requires a lot number (BR-25)`);
        const lot = await tx.lot.upsert({
          where: { skuId_lotNumber: { skuId: sku.id, lotNumber: body.lotNumber } },
          create: { skuId: sku.id, lotNumber: body.lotNumber, expiresOn: body.expiresOn ? new Date(body.expiresOn) : null },
          update: {},
        });
        if (sku.expiryTracked && !lot.expiresOn) throw DomainError.rule(ErrorCode.LOT_REQUIRED, `${sku.code} requires an expiry date`);
        if (lot.expiresOn && lot.expiresOn < new Date(new Date().toISOString().slice(0, 10))) throw DomainError.rule(ErrorCode.EXPIRED_LOT, `Lot ${lot.lotNumber} is expired (BR-25)`);
        lotId = lot.id;
      }
      if (body.huCode && (await tx.handlingUnit.findUnique({ where: { code: body.huCode } }))) {
        throw DomainError.conflict(ErrorCode.CODE_ALREADY_EXISTS, `Pallet ${body.huCode} already exists`);
      }
      const status = body.condition === 'DAMAGED' ? 'DAMAGED' : sku.qcRequired ? 'QC_HOLD' : 'AVAILABLE';
      const hu = await this.pallets.create(tx, siteId, { code: body.huCode, locationId: r.dockLocationId, source: 'CONFIRMED_SCAN' });
      const posted = await this.ledger.post(tx, {
        siteId,
        txType: 'RECEIPT',
        idempotencyKey: `receipt-line:${idemKey}`,
        skuId: sku.id,
        lotId,
        handlingUnitId: hu.id,
        toLocationId: r.dockLocationId,
        toStatus: status,
        quantity: body.quantity,
        referenceType: 'RECEIPT_LINE',
        referenceId: r.id,
      });
      await tx.receiptLine.create({
        data: { receiptId: r.id, siteId, inboundOrderLineId: orderLine.id, skuId: sku.id, lotId, handlingUnitId: hu.id, quantity: new D(body.quantity), stockStatus: status, idempotencyKey: `rl:${idemKey}`, inventoryTxId: posted.tx.id },
      });
      await tx.inboundOrderLine.update({ where: { id: orderLine.id }, data: { receivedQty: { increment: new D(body.quantity) } } });
      await this.movements.record(tx, { siteId, subjectType: 'HANDLING_UNIT', subjectId: hu.id, fromLocationId: null, toLocationId: r.dockLocationId, positionSource: 'CONFIRMED_SCAN', reason: 'Received' });
      if (body.condition === 'DAMAGED') {
        await this.exceptions.raise(tx, { siteId, caseType: 'RECEIPT_DISCREPANCY', subjectType: 'HANDLING_UNIT', subjectId: hu.id, description: `Damaged on arrival: ${hu.code} ${sku.code} × ${body.quantity}` });
      }
      await this.audit.record(tx, { siteId, action: 'RECEIPT_LINE_SCANNED', entityType: 'Receipt', entityId: r.id, diff: { after: { hu: hu.code, sku: sku.code, qty: body.quantity, status } } });
      await this.events.inventoryUpdated(tx, siteId, posted.changes, [posted.tx.id]);
      await this.events.palletMoved(tx, siteId, hu.id, null, r.dockLocationId);
      await this.shipments.emit(tx, r.shipmentId);
    });
    return this.getReceipt(siteId, receiptId);
  }

  /** Hủy dòng quét nhầm bằng giao dịch bù (BR-07), không xóa dòng. */
  async voidLine(siteId: string, receiptId: string, lineId: string, reason: string): Promise<ReceiptDetail> {
    await this.tx.run(async (tx) => {
      const line = await tx.receiptLine.findFirst({ where: { id: lineId, receiptId, siteId }, include: { receipt: true } });
      if (!line) throw DomainError.notFound('Receipt line');
      if (line.voided || line.receipt.status !== 'IN_PROGRESS') throw DomainError.invalidTransition('ReceiptLine', 'RECORDED', 'VOIDED');
      const hu = await tx.handlingUnit.findUniqueOrThrow({ where: { id: line.handlingUnitId } });
      if (hu.locationId !== line.receipt.dockLocationId) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, 'Pallet has already left the dock');
      const posted = await this.ledger.post(tx, {
        siteId,
        txType: 'RECEIPT_REVERSAL',
        idempotencyKey: `receipt-void:${line.id}`,
        skuId: line.skuId,
        lotId: line.lotId,
        handlingUnitId: hu.id,
        fromLocationId: line.receipt.dockLocationId,
        fromStatus: line.stockStatus,
        quantity: line.quantity,
        referenceType: 'RECEIPT_LINE',
        referenceId: line.id,
        reversesTxId: line.inventoryTxId,
      });
      await tx.receiptLine.update({ where: { id: line.id }, data: { voided: true, voidReason: reason } });
      if (line.inboundOrderLineId) await tx.inboundOrderLine.update({ where: { id: line.inboundOrderLineId }, data: { receivedQty: { decrement: line.quantity } } });
      await this.pallets.setLifecycle(tx, siteId, hu.id, 'EMPTY', { clearLocation: true });
      await this.audit.record(tx, { siteId, action: 'RECEIPT_LINE_VOIDED', entityType: 'Receipt', entityId: receiptId, reason });
      await this.events.inventoryUpdated(tx, siteId, posted.changes, [posted.tx.id]);
      await this.shipments.emit(tx, line.receipt.shipmentId);
    });
    return this.getReceipt(siteId, receiptId);
  }

  /**
   * UC-08 bước 5–6: hoàn tất — sai lệch thành discrepancy + exception (không tự điều chỉnh — AC-04);
   * nhận thiếu cần quyền duyệt + lý do; sinh put-away cho hàng AVAILABLE; xe READY_TO_LEAVE.
   */
  async completeReceipt(siteId: string, receiptId: string, closeShortReason?: string): Promise<ReceiptDetail> {
    const principal = requirePrincipal();
    await this.tx.run(async (tx) => {
      const r = await tx.receipt.findFirst({ where: { id: receiptId, siteId } });
      if (!r) throw DomainError.notFound('Receipt');
      if (r.status !== 'IN_PROGRESS') throw DomainError.invalidTransition('Receipt', r.status, 'COMPLETED');
      const order = await tx.inboundOrder.findUniqueOrThrow({ where: { id: r.inboundOrderId }, include: { lines: true } });
      const settings = await this.sites.settings(siteId, tx);
      const shortLines = order.lines.filter((l) => new D(l.receivedQty).lt(l.expectedQty));
      if (shortLines.length > 0 && (!closeShortReason || !principal.permissions.has('inbound.discrepancy.approve'))) {
        throw DomainError.rule(ErrorCode.DISCREPANCY_APPROVAL_REQUIRED, 'Short receipt — a supervisor must close it with a reason (UC-08 A1)', {
          short: shortLines.map((l) => ({ lineId: l.id, expected: new D(l.expectedQty).toFixed(3), received: new D(l.receivedQty).toFixed(3) })),
        });
      }
      for (const l of order.lines) {
        const delta = new D(l.receivedQty).minus(l.expectedQty);
        if (delta.isZero()) continue;
        const over = delta.gt(0);
        const tolerance = new D(l.expectedQty).times(settings.overReceiptTolerancePct).div(100);
        const needsApproval = over && delta.gt(tolerance); // BR-36, DEC-15
        const exc = await this.exceptions.raise(tx, {
          siteId,
          caseType: 'RECEIPT_DISCREPANCY',
          severity: over ? 'MEDIUM' : 'LOW',
          subjectType: 'RECEIPT',
          subjectId: r.id,
          description: `${over ? 'Over' : 'Short'} receipt ${delta.toFixed(3)} on ${order.code}${!over && closeShortReason ? ` — ${closeShortReason}` : ''}`,
        });
        await tx.receiptDiscrepancy.create({
          data: { receiptId: r.id, siteId, discrepancyType: over ? 'OVER' : 'SHORT', skuId: l.skuId, qtyDelta: delta, status: needsApproval ? 'PENDING_APPROVAL' : 'APPROVED', note: over ? null : closeShortReason, exceptionCaseId: exc.id },
        });
      }
      const pending = await tx.receiptDiscrepancy.count({ where: { receiptId: r.id, status: { in: ['OPEN', 'PENDING_APPROVAL'] } } });
      await tx.receipt.update({ where: { id: r.id }, data: { status: shortLines.length ? 'PARTIALLY_RECEIVED' : 'COMPLETED', completedAt: new Date(), version: { increment: 1 } } });
      const shipment = await this.shipments.load(tx, siteId, r.shipmentId);
      await this.shipments.transition(tx, shipment, 'RECEIVED');
      if (pending === 0) await this.shipments.transition(tx, await this.shipments.load(tx, siteId, r.shipmentId), 'CLOSED');
      await tx.inboundOrder.update({ where: { id: order.id }, data: { status: pending === 0 ? 'CLOSED' : 'RECEIVED', version: { increment: 1 } } });
      if (shipment.truckVisitId) await this.visits.markHandlingComplete(tx, siteId, shipment.truckVisitId);

      // Sinh put-away cho pallet AVAILABLE; pallet QC_HOLD chờ QC (hàng đợi QC = pallet QC_HOLD)
      const lines = await tx.receiptLine.findMany({ where: { receiptId: r.id, voided: false } });
      for (const line of lines) if (line.stockStatus === 'AVAILABLE') await this.createPutaway(tx, siteId, line.handlingUnitId, r.code);
      await this.audit.record(tx, { siteId, action: 'RECEIPT_COMPLETED', entityType: 'Receipt', entityId: r.id, reason: closeShortReason ?? null });
    });
    return this.getReceipt(siteId, receiptId);
  }

  async decideDiscrepancy(siteId: string, receiptId: string, discId: string, approve: boolean, note?: string): Promise<ReceiptDetail> {
    await this.tx.run(async (tx) => {
      const d = await tx.receiptDiscrepancy.findFirst({ where: { id: discId, receiptId, siteId } });
      if (!d) throw DomainError.notFound('Discrepancy');
      if (d.status !== 'PENDING_APPROVAL') throw DomainError.invalidTransition('ReceiptDiscrepancy', d.status, approve ? 'APPROVED' : 'REJECTED');
      await tx.receiptDiscrepancy.update({ where: { id: d.id }, data: { status: approve ? 'APPROVED' : 'REJECTED', note: note ?? d.note } });
      await this.audit.record(tx, { siteId, action: approve ? 'OVER_RECEIPT_APPROVED' : 'OVER_RECEIPT_REJECTED', entityType: 'ReceiptDiscrepancy', entityId: d.id, reason: note ?? null });
      const pending = await tx.receiptDiscrepancy.count({ where: { receiptId, status: { in: ['OPEN', 'PENDING_APPROVAL'] } } });
      if (pending === 0) {
        const r = await tx.receipt.findUniqueOrThrow({ where: { id: receiptId } });
        const s = await this.shipments.load(tx, siteId, r.shipmentId);
        if (s.status === 'RECEIVED') await this.shipments.transition(tx, s, 'CLOSED');
        await tx.inboundOrder.update({ where: { id: r.inboundOrderId }, data: { status: 'CLOSED', version: { increment: 1 } } });
      }
    });
    return this.getReceipt(siteId, receiptId);
  }

  async getReceipt(siteId: string, id: string): Promise<ReceiptDetail> {
    const r = await this.prisma.receipt.findFirst({ where: { id, siteId }, include: { lines: { orderBy: { createdAt: 'asc' } } } });
    if (!r) throw DomainError.notFound('Receipt');
    const [dock, skus, lots, hus, discs, shipment] = await Promise.all([
      this.prisma.location.findUniqueOrThrow({ where: { id: r.dockLocationId } }),
      this.prisma.sku.findMany({ where: { id: { in: r.lines.map((l) => l.skuId) } } }),
      this.prisma.lot.findMany({ where: { id: { in: r.lines.map((l) => l.lotId).filter((x): x is string => !!x) } } }),
      this.prisma.handlingUnit.findMany({ where: { id: { in: r.lines.map((l) => l.handlingUnitId) } } }),
      this.prisma.receiptDiscrepancy.findMany({ where: { receiptId: r.id } }),
      this.prisma.shipment.findUniqueOrThrow({ where: { id: r.shipmentId } }),
    ]);
    const ms = new Map(skus.map((s) => [s.id, s])), ml = new Map(lots.map((l) => [l.id, l.lotNumber])), mh = new Map(hus.map((h) => [h.id, h.code]));
    const dSkus = new Map((await this.prisma.sku.findMany({ where: { id: { in: discs.map((d) => d.skuId).filter((x): x is string => !!x) } } })).map((s) => [s.id, s.code]));
    const received = r.lines.filter((l) => !l.voided).length;
    return {
      id: r.id,
      code: r.code,
      status: r.status,
      inboundOrderId: r.inboundOrderId,
      shipmentId: r.shipmentId,
      dock: { id: dock.id, code: dock.code },
      lines: r.lines.map((l) => ({
        id: l.id,
        sku: { code: ms.get(l.skuId)?.code ?? '', name: ms.get(l.skuId)?.name ?? '' },
        lotNumber: l.lotId ? (ml.get(l.lotId) ?? null) : null,
        handlingUnit: { id: l.handlingUnitId, code: mh.get(l.handlingUnitId) ?? '' },
        quantity: new D(l.quantity).toFixed(3),
        stockStatus: l.stockStatus,
        voided: l.voided,
        createdAt: l.createdAt.toISOString(),
      })),
      progress: { receivedHu: received, expectedHu: Math.max(shipment.expectedHuCount, received) },
      discrepancies: discs.map((d) => ({ id: d.id, type: d.discrepancyType, sku: d.skuId ? (dSkus.get(d.skuId) ?? null) : null, qtyDelta: new D(d.qtyDelta).toFixed(3), status: d.status, note: d.note })),
      version: r.version,
    };
  }

  // ───────────── QC (UC-09) ─────────────

  async qcQueue(siteId: string) {
    const balances = await this.prisma.inventoryBalance.findMany({ where: { siteId, stockStatus: 'QC_HOLD', qtyOnHand: { gt: 0 }, handlingUnitId: { not: null } } });
    const hus = await this.prisma.handlingUnit.findMany({ where: { id: { in: balances.map((b) => b.handlingUnitId!) } } });
    const skus = new Map((await this.prisma.sku.findMany({ where: { id: { in: balances.map((b) => b.skuId) } } })).map((s) => [s.id, s]));
    const locs = new Map((await this.prisma.location.findMany({ where: { id: { in: balances.map((b) => b.locationId) } } })).map((l) => [l.id, l.code]));
    return balances.map((b) => ({
      balanceId: b.id,
      handlingUnit: { id: b.handlingUnitId!, code: hus.find((h) => h.id === b.handlingUnitId)?.code ?? '' },
      sku: { code: skus.get(b.skuId)?.code ?? '', name: skus.get(b.skuId)?.name ?? '' },
      location: locs.get(b.locationId) ?? '',
      quantity: new D(b.qtyOnHand).toFixed(3),
      receivedAt: b.receivedAt.toISOString(),
    }));
  }

  /** PASS → AVAILABLE + put-away; FAIL → QUARANTINE/DAMAGED + chuyển khu cách ly; PARTIAL tách số lượng. */
  async recordQc(siteId: string, body: QcRequest) {
    return this.tx.run(async (tx) => {
      const hu = await tx.handlingUnit.findFirst({ where: { id: body.handlingUnitId, siteId } });
      if (!hu) throw DomainError.notFound('Pallet');
      const balances = await tx.inventoryBalance.findMany({ where: { handlingUnitId: hu.id, stockStatus: 'QC_HOLD', qtyOnHand: { gt: 0 } } });
      if (balances.length === 0) throw DomainError.invalidTransition('Stock', 'NOT_QC_HOLD', 'QC');
      const total = balances.reduce((s, b) => s.plus(b.qtyOnHand), new D(0));
      const failed = body.result === 'PASS' ? new D(0) : body.result === 'FAIL' ? total : new D(body.qtyFailed ?? 0);
      if (failed.gt(total) || (body.result === 'PARTIAL' && (failed.lte(0) || failed.gte(total)))) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, 'Failed quantity must be between 0 and the pallet quantity');
      const failStatus = body.failStatus ?? 'QUARANTINE';
      const changes = [];
      const txIds: bigint[] = [];
      let remainingFail = failed;
      for (const [i, b] of balances.entries()) {
        const qty = new D(b.qtyOnHand);
        const failHere = Prisma.Decimal.min(qty, remainingFail);
        remainingFail = remainingFail.minus(failHere);
        const passHere = qty.minus(failHere);
        for (const [part, to] of [
          [passHere, 'AVAILABLE'],
          [failHere, failStatus],
        ] as const) {
          if (part.lte(0)) continue;
          const r = await this.ledger.post(tx, {
            siteId,
            txType: 'STATUS_CHANGE',
            idempotencyKey: `qc:${hu.id}:${b.id}:${to}:${i}`,
            skuId: b.skuId,
            lotId: b.lotId,
            handlingUnitId: hu.id,
            fromLocationId: b.locationId,
            fromStatus: 'QC_HOLD',
            toStatus: to,
            quantity: part,
            referenceType: 'QC_INSPECTION',
            referenceId: hu.id,
            receivedAt: b.receivedAt,
          });
          changes.push(...r.changes);
          txIds.push(r.tx.id);
        }
      }
      const qc = await tx.qcInspection.create({
        data: { siteId, handlingUnitId: hu.id, result: body.result, qtyPassed: total.minus(failed), qtyFailed: failed, failStatus: failed.gt(0) ? failStatus : null, note: body.note ?? null, inspectorId: requirePrincipal().userId },
      });
      await this.audit.record(tx, { siteId, action: `QC_${body.result === 'PASS' ? 'PASSED' : body.result === 'FAIL' ? 'FAILED' : 'PARTIAL'}`, entityType: 'HandlingUnit', entityId: hu.id, reason: body.note ?? null });
      await this.events.inventoryUpdated(tx, siteId, changes, txIds);
      await this.events.palletMoved(tx, siteId, hu.id, hu.locationId, hu.locationId);
      if (body.result === 'PASS') await this.createPutaway(tx, siteId, hu.id, 'QC');
      if (body.result === 'FAIL') {
        const quarantine = await tx.location.findFirst({ where: { siteId, locationType: 'QUARANTINE', deletedAt: null, blockedAt: null } });
        if (quarantine) await this.createPutaway(tx, siteId, hu.id, 'QC', quarantine.id);
      }
      return { id: qc.id, result: qc.result, qtyPassed: total.minus(failed).toFixed(3), qtyFailed: failed.toFixed(3) };
    });
  }

  /** Gợi ý vị trí: rack còn chỗ, ưu tiên cùng SKU (mục 5.7 FR-07.06); sức chứa kiểm lại khi hoàn tất. */
  private async createPutaway(tx: Tx, siteId: string, huId: string, sourceCode: string, toLocationId?: string): Promise<OperationTask> {
    const hu: HandlingUnit = await tx.handlingUnit.findUniqueOrThrow({ where: { id: huId } });
    let target = toLocationId ?? null;
    if (!target) {
      const bal = await tx.inventoryBalance.findFirst({ where: { handlingUnitId: huId, qtyOnHand: { gt: 0 } } });
      const racks = await tx.location.findMany({ where: { siteId, locationType: 'STORAGE', deletedAt: null, isActive: true, blockedAt: null, frozenByCountId: null }, orderBy: { code: 'asc' } });
      const occ = await tx.locationOccupancy.groupBy({ by: ['locationId'], where: { siteId, releasedAt: null, locationId: { in: racks.map((r) => r.id) } }, _sum: { unitsUsed: true } });
      const used = new Map(occ.map((o) => [o.locationId, Number(o._sum.unitsUsed ?? 0)]));
      const sameSku = bal ? new Set((await tx.inventoryBalance.findMany({ where: { siteId, skuId: bal.skuId, qtyOnHand: { gt: 0 }, locationId: { in: racks.map((r) => r.id) } } })).map((b) => b.locationId)) : new Set<string>();
      const free = racks.filter((r) => (used.get(r.id) ?? 0) < Number(r.capacityUnits));
      target = (free.find((r) => sameSku.has(r.id)) ?? free[0])?.id ?? null;
    }
    return this.tasks.create(tx, {
      siteId,
      taskType: 'PUTAWAY',
      subjectType: 'HANDLING_UNIT',
      subjectId: hu.id,
      fromLocationId: hu.locationId,
      toLocationId: target,
      sourceType: 'RECEIPT',
      sourceId: hu.id,
      priority: 3,
      payload: { sourceCode, commandId: uuidv7() },
    });
  }
}
