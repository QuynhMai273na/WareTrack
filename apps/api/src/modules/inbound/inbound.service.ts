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

const Decimal = Prisma.Decimal;

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
          lines: { create: body.lines.map((line) => ({ siteId, skuId: line.skuId, expectedQty: new Decimal(line.expectedQty), expectedHuCount: line.expectedHuCount ?? null, expectedLotNumber: line.expectedLotNumber ?? null })) },
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
        expectedHuCount: body.lines.reduce((sum, line) => sum + (line.expectedHuCount ?? 0), 0),
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
    return Promise.all(rows.map((order) => this.getOrder(siteId, order.id)));
  }

  async getOrder(siteId: string, id: string): Promise<InboundOrderDetail> {
    const order = await this.prisma.inboundOrder.findFirst({ where: { id, siteId }, include: { lines: true } });
    if (!order) throw DomainError.notFound('Inbound order');
    const [supplier, shipment, skus, receipt] = await Promise.all([
      order.supplierId ? this.prisma.partner.findUnique({ where: { id: order.supplierId } }) : null,
      order.shipmentId ? this.prisma.shipment.findUnique({ where: { id: order.shipmentId } }) : null,
      this.prisma.sku.findMany({ where: { id: { in: order.lines.map((line) => line.skuId) } } }),
      this.prisma.receipt.findFirst({ where: { inboundOrderId: order.id }, orderBy: { startedAt: 'desc' } }),
    ]);
    const ms = new Map(skus.map((sku) => [sku.id, sku]));
    return {
      id: order.id,
      code: order.code,
      status: order.status,
      supplier: supplier ? { id: supplier.id, name: supplier.name } : null,
      expectedOn: order.expectedOn?.toISOString().slice(0, 10) ?? null,
      shipment: shipment ? { id: shipment.id, code: shipment.code, status: shipment.status, visitId: shipment.truckVisitId } : null,
      lines: order.lines.map((line) => {
        const sku = ms.get(line.skuId)!;
        return {
          id: line.id,
          sku: { id: sku.id, code: sku.code, name: sku.name, lotTracked: sku.lotTracked, qcRequired: sku.qcRequired },
          expectedQty: new Decimal(line.expectedQty).toFixed(3),
          expectedHuCount: line.expectedHuCount,
          expectedLotNumber: line.expectedLotNumber,
          receivedQty: new Decimal(line.receivedQty).toFixed(3),
        };
      }),
      receipt: receipt ? { id: receipt.id, code: receipt.code, status: receipt.status } : null,
      version: order.version,
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
      const receipt = await tx.receipt.findFirst({ where: { id: receiptId, siteId } });
      if (!receipt) throw DomainError.notFound('Receipt');
      if (receipt.status !== 'IN_PROGRESS') throw DomainError.invalidTransition('Receipt', receipt.status, 'IN_PROGRESS');
      const existing = await tx.receiptLine.findUnique({ where: { idempotencyKey: `rl:${idemKey}` } });
      if (existing) return;
      const sku = await tx.sku.findUnique({ where: { id: body.skuId } });
      if (!sku) throw DomainError.notFound('SKU');
      const orderLine = await tx.inboundOrderLine.findFirst({ where: { inboundOrderId: receipt.inboundOrderId, skuId: sku.id } });
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
      const hu = await this.pallets.create(tx, siteId, { code: body.huCode, locationId: receipt.dockLocationId, source: 'CONFIRMED_SCAN' });
      const posted = await this.ledger.post(tx, {
        siteId,
        txType: 'RECEIPT',
        idempotencyKey: `receipt-line:${idemKey}`,
        skuId: sku.id,
        lotId,
        handlingUnitId: hu.id,
        toLocationId: receipt.dockLocationId,
        toStatus: status,
        quantity: body.quantity,
        referenceType: 'RECEIPT_LINE',
        referenceId: receipt.id,
      });
      await tx.receiptLine.create({
        data: { receiptId: receipt.id, siteId, inboundOrderLineId: orderLine.id, skuId: sku.id, lotId, handlingUnitId: hu.id, quantity: new Decimal(body.quantity), stockStatus: status, idempotencyKey: `rl:${idemKey}`, inventoryTxId: posted.tx.id },
      });
      await tx.inboundOrderLine.update({ where: { id: orderLine.id }, data: { receivedQty: { increment: new Decimal(body.quantity) } } });
      await this.movements.record(tx, { siteId, subjectType: 'HANDLING_UNIT', subjectId: hu.id, fromLocationId: null, toLocationId: receipt.dockLocationId, positionSource: 'CONFIRMED_SCAN', reason: 'Received' });
      if (body.condition === 'DAMAGED') {
        await this.exceptions.raise(tx, { siteId, caseType: 'RECEIPT_DISCREPANCY', subjectType: 'HANDLING_UNIT', subjectId: hu.id, description: `Damaged on arrival: ${hu.code} ${sku.code} × ${body.quantity}` });
      }
      await this.audit.record(tx, { siteId, action: 'RECEIPT_LINE_SCANNED', entityType: 'Receipt', entityId: receipt.id, diff: { after: { hu: hu.code, sku: sku.code, qty: body.quantity, status } } });
      await this.events.inventoryUpdated(tx, siteId, posted.changes, [posted.tx.id]);
      await this.events.palletMoved(tx, siteId, hu.id, null, receipt.dockLocationId);
      await this.shipments.emit(tx, receipt.shipmentId);
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
      const receipt = await tx.receipt.findFirst({ where: { id: receiptId, siteId } });
      if (!receipt) throw DomainError.notFound('Receipt');
      if (receipt.status !== 'IN_PROGRESS') throw DomainError.invalidTransition('Receipt', receipt.status, 'COMPLETED');
      const order = await tx.inboundOrder.findUniqueOrThrow({ where: { id: receipt.inboundOrderId }, include: { lines: true } });
      const settings = await this.sites.settings(siteId, tx);
      const shortLines = order.lines.filter((line) => new Decimal(line.receivedQty).lt(line.expectedQty));
      if (shortLines.length > 0 && (!closeShortReason || !principal.permissions.has('inbound.discrepancy.approve'))) {
        throw DomainError.rule(ErrorCode.DISCREPANCY_APPROVAL_REQUIRED, 'Short receipt — a supervisor must close it with a reason (UC-08 A1)', {
          short: shortLines.map((line) => ({ lineId: line.id, expected: new Decimal(line.expectedQty).toFixed(3), received: new Decimal(line.receivedQty).toFixed(3) })),
        });
      }
      for (const line of order.lines) {
        const delta = new Decimal(line.receivedQty).minus(line.expectedQty);
        if (delta.isZero()) continue;
        const over = delta.gt(0);
        const tolerance = new Decimal(line.expectedQty).times(settings.overReceiptTolerancePct).div(100);
        const needsApproval = over && delta.gt(tolerance); // BR-36, DEC-15
        const exc = await this.exceptions.raise(tx, {
          siteId,
          caseType: 'RECEIPT_DISCREPANCY',
          severity: over ? 'MEDIUM' : 'LOW',
          subjectType: 'RECEIPT',
          subjectId: receipt.id,
          description: `${over ? 'Over' : 'Short'} receipt ${delta.toFixed(3)} on ${order.code}${!over && closeShortReason ? ` — ${closeShortReason}` : ''}`,
        });
        await tx.receiptDiscrepancy.create({
          data: { receiptId: receipt.id, siteId, discrepancyType: over ? 'OVER' : 'SHORT', skuId: line.skuId, qtyDelta: delta, status: needsApproval ? 'PENDING_APPROVAL' : 'APPROVED', note: over ? null : closeShortReason, exceptionCaseId: exc.id },
        });
      }
      const pending = await tx.receiptDiscrepancy.count({ where: { receiptId: receipt.id, status: { in: ['OPEN', 'PENDING_APPROVAL'] } } });
      await tx.receipt.update({ where: { id: receipt.id }, data: { status: shortLines.length ? 'PARTIALLY_RECEIVED' : 'COMPLETED', completedAt: new Date(), version: { increment: 1 } } });
      const shipment = await this.shipments.load(tx, siteId, receipt.shipmentId);
      await this.shipments.transition(tx, shipment, 'RECEIVED');
      if (pending === 0) await this.shipments.transition(tx, await this.shipments.load(tx, siteId, receipt.shipmentId), 'CLOSED');
      await tx.inboundOrder.update({ where: { id: order.id }, data: { status: pending === 0 ? 'CLOSED' : 'RECEIVED', version: { increment: 1 } } });
      if (shipment.truckVisitId) await this.visits.markHandlingComplete(tx, siteId, shipment.truckVisitId);

      // Sinh put-away cho pallet AVAILABLE; pallet QC_HOLD chờ QC (hàng đợi QC = pallet QC_HOLD)
      const lines = await tx.receiptLine.findMany({ where: { receiptId: receipt.id, voided: false } });
      for (const line of lines) if (line.stockStatus === 'AVAILABLE') await this.createPutaway(tx, siteId, line.handlingUnitId, receipt.code);
      await this.audit.record(tx, { siteId, action: 'RECEIPT_COMPLETED', entityType: 'Receipt', entityId: receipt.id, reason: closeShortReason ?? null });
    });
    return this.getReceipt(siteId, receiptId);
  }

  async decideDiscrepancy(siteId: string, receiptId: string, discId: string, approve: boolean, note?: string): Promise<ReceiptDetail> {
    await this.tx.run(async (tx) => {
      const discrepancy = await tx.receiptDiscrepancy.findFirst({ where: { id: discId, receiptId, siteId } });
      if (!discrepancy) throw DomainError.notFound('Discrepancy');
      if (discrepancy.status !== 'PENDING_APPROVAL') throw DomainError.invalidTransition('ReceiptDiscrepancy', discrepancy.status, approve ? 'APPROVED' : 'REJECTED');
      await tx.receiptDiscrepancy.update({ where: { id: discrepancy.id }, data: { status: approve ? 'APPROVED' : 'REJECTED', note: note ?? discrepancy.note } });
      await this.audit.record(tx, { siteId, action: approve ? 'OVER_RECEIPT_APPROVED' : 'OVER_RECEIPT_REJECTED', entityType: 'ReceiptDiscrepancy', entityId: discrepancy.id, reason: note ?? null });
      const pending = await tx.receiptDiscrepancy.count({ where: { receiptId, status: { in: ['OPEN', 'PENDING_APPROVAL'] } } });
      if (pending === 0) {
        const receipt = await tx.receipt.findUniqueOrThrow({ where: { id: receiptId } });
        const shipment = await this.shipments.load(tx, siteId, receipt.shipmentId);
        if (shipment.status === 'RECEIVED') await this.shipments.transition(tx, shipment, 'CLOSED');
        await tx.inboundOrder.update({ where: { id: receipt.inboundOrderId }, data: { status: 'CLOSED', version: { increment: 1 } } });
      }
    });
    return this.getReceipt(siteId, receiptId);
  }

  async getReceipt(siteId: string, id: string): Promise<ReceiptDetail> {
    const receipt = await this.prisma.receipt.findFirst({ where: { id, siteId }, include: { lines: { orderBy: { createdAt: 'asc' } } } });
    if (!receipt) throw DomainError.notFound('Receipt');
    const [dock, skus, lots, hus, discs, shipment] = await Promise.all([
      this.prisma.location.findUniqueOrThrow({ where: { id: receipt.dockLocationId } }),
      this.prisma.sku.findMany({ where: { id: { in: receipt.lines.map((line) => line.skuId) } } }),
      this.prisma.lot.findMany({ where: { id: { in: receipt.lines.map((line) => line.lotId).filter((lotId): lotId is string => !!lotId) } } }),
      this.prisma.handlingUnit.findMany({ where: { id: { in: receipt.lines.map((line) => line.handlingUnitId) } } }),
      this.prisma.receiptDiscrepancy.findMany({ where: { receiptId: receipt.id } }),
      this.prisma.shipment.findUniqueOrThrow({ where: { id: receipt.shipmentId } }),
    ]);
    const ms = new Map(skus.map((sku) => [sku.id, sku])), ml = new Map(lots.map((lot) => [lot.id, lot.lotNumber])), mh = new Map(hus.map((handlingUnit) => [handlingUnit.id, handlingUnit.code]));
    const dSkus = new Map((await this.prisma.sku.findMany({ where: { id: { in: discs.map((discrepancy) => discrepancy.skuId).filter((skuId): skuId is string => !!skuId) } } })).map((sku) => [sku.id, sku.code]));
    const received = receipt.lines.filter((line) => !line.voided).length;
    return {
      id: receipt.id,
      code: receipt.code,
      status: receipt.status,
      inboundOrderId: receipt.inboundOrderId,
      shipmentId: receipt.shipmentId,
      dock: { id: dock.id, code: dock.code },
      lines: receipt.lines.map((line) => ({
        id: line.id,
        sku: { code: ms.get(line.skuId)?.code ?? '', name: ms.get(line.skuId)?.name ?? '' },
        lotNumber: line.lotId ? (ml.get(line.lotId) ?? null) : null,
        handlingUnit: { id: line.handlingUnitId, code: mh.get(line.handlingUnitId) ?? '' },
        quantity: new Decimal(line.quantity).toFixed(3),
        stockStatus: line.stockStatus,
        voided: line.voided,
        createdAt: line.createdAt.toISOString(),
      })),
      progress: { receivedHu: received, expectedHu: Math.max(shipment.expectedHuCount, received) },
      discrepancies: discs.map((discrepancy) => ({ id: discrepancy.id, type: discrepancy.discrepancyType, sku: discrepancy.skuId ? (dSkus.get(discrepancy.skuId) ?? null) : null, qtyDelta: new Decimal(discrepancy.qtyDelta).toFixed(3), status: discrepancy.status, note: discrepancy.note })),
      version: receipt.version,
    };
  }

  // ───────────── QC (UC-09) ─────────────

  async qcQueue(siteId: string) {
    const balances = await this.prisma.inventoryBalance.findMany({ where: { siteId, stockStatus: 'QC_HOLD', qtyOnHand: { gt: 0 }, handlingUnitId: { not: null } } });
    const hus = await this.prisma.handlingUnit.findMany({ where: { id: { in: balances.map((balance) => balance.handlingUnitId!) } } });
    const skus = new Map((await this.prisma.sku.findMany({ where: { id: { in: balances.map((balance) => balance.skuId) } } })).map((sku) => [sku.id, sku]));
    const locs = new Map((await this.prisma.location.findMany({ where: { id: { in: balances.map((balance) => balance.locationId) } } })).map((location) => [location.id, location.code]));
    return balances.map((balance) => ({
      balanceId: balance.id,
      handlingUnit: { id: balance.handlingUnitId!, code: hus.find((handlingUnit) => handlingUnit.id === balance.handlingUnitId)?.code ?? '' },
      sku: { code: skus.get(balance.skuId)?.code ?? '', name: skus.get(balance.skuId)?.name ?? '' },
      location: locs.get(balance.locationId) ?? '',
      quantity: new Decimal(balance.qtyOnHand).toFixed(3),
      receivedAt: balance.receivedAt.toISOString(),
    }));
  }

  /** PASS → AVAILABLE + put-away; FAIL → QUARANTINE/DAMAGED + chuyển khu cách ly; PARTIAL tách số lượng. */
  async recordQc(siteId: string, body: QcRequest) {
    return this.tx.run(async (tx) => {
      const hu = await tx.handlingUnit.findFirst({ where: { id: body.handlingUnitId, siteId } });
      if (!hu) throw DomainError.notFound('Pallet');
      const balances = await tx.inventoryBalance.findMany({ where: { handlingUnitId: hu.id, stockStatus: 'QC_HOLD', qtyOnHand: { gt: 0 } } });
      if (balances.length === 0) throw DomainError.invalidTransition('Stock', 'NOT_QC_HOLD', 'QC');
      const total = balances.reduce((sum, balance) => sum.plus(balance.qtyOnHand), new Decimal(0));
      const failed = body.result === 'PASS' ? new Decimal(0) : body.result === 'FAIL' ? total : new Decimal(body.qtyFailed ?? 0);
      if (failed.gt(total) || (body.result === 'PARTIAL' && (failed.lte(0) || failed.gte(total)))) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, 'Failed quantity must be between 0 and the pallet quantity');
      const failStatus = body.failStatus ?? 'QUARANTINE';
      const changes = [];
      const txIds: bigint[] = [];
      let remainingFail = failed;
      for (const [balanceIndex, balance] of balances.entries()) {
        const qty = new Decimal(balance.qtyOnHand);
        const failHere = Prisma.Decimal.min(qty, remainingFail);
        remainingFail = remainingFail.minus(failHere);
        const passHere = qty.minus(failHere);
        for (const [part, to] of [
          [passHere, 'AVAILABLE'],
          [failHere, failStatus],
        ] as const) {
          if (part.lte(0)) continue;
          const ledgerResult = await this.ledger.post(tx, {
            siteId,
            txType: 'STATUS_CHANGE',
            idempotencyKey: `qc:${hu.id}:${balance.id}:${to}:${balanceIndex}`,
            skuId: balance.skuId,
            lotId: balance.lotId,
            handlingUnitId: hu.id,
            fromLocationId: balance.locationId,
            fromStatus: 'QC_HOLD',
            toStatus: to,
            quantity: part,
            referenceType: 'QC_INSPECTION',
            referenceId: hu.id,
            receivedAt: balance.receivedAt,
          });
          changes.push(...ledgerResult.changes);
          txIds.push(ledgerResult.tx.id);
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
      const occ = await tx.locationOccupancy.groupBy({ by: ['locationId'], where: { siteId, releasedAt: null, locationId: { in: racks.map((rack) => rack.id) } }, _sum: { unitsUsed: true } });
      const used = new Map(occ.map((occupancy) => [occupancy.locationId, Number(occupancy._sum.unitsUsed ?? 0)]));
      const sameSku = bal ? new Set((await tx.inventoryBalance.findMany({ where: { siteId, skuId: bal.skuId, qtyOnHand: { gt: 0 }, locationId: { in: racks.map((rack) => rack.id) } } })).map((balance) => balance.locationId)) : new Set<string>();
      const free = racks.filter((rack) => (used.get(rack.id) ?? 0) < Number(rack.capacityUnits));
      target = (free.find((rack) => sameSku.has(rack.id)) ?? free[0])?.id ?? null;
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
