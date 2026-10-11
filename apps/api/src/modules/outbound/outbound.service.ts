import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, type OperationTask, type OrderLineStatus } from '@prisma/client';
import { type CreateOutboundOrderRequest, ErrorCode, type OutboundOrderDetail } from '@waretrack/shared-schemas';
import { uuidv7 } from 'uuidv7';
import { AuditService } from '../../platform/audit/audit.service';
import { CodeGenerator } from '../../platform/codes/code-generator';
import { DomainError } from '../../platform/errors/domain-error';
import { LocationLockPort } from '../../platform/locks/location-lock';
import { PrismaService, type Tx, TxRunner } from '../../platform/prisma/prisma.service';
import { InventoryEvents } from '../inventory/inventory-events.service';
import { LedgerService } from '../inventory/ledger.service';
import { PalletsService } from '../inventory/pallets.service';
import { ReservationService } from '../inventory/reservation.service';
import { MovementService } from '../operations/movement.service';
import { ExceptionsService } from '../operations/exceptions.service';
import { TasksService } from '../operations/tasks.service';
import { ShipmentsService } from '../shipments/shipments.service';
import { SitesService } from '../sites/sites.service';
import { OccupancyService } from '../yard/occupancy.service';
import { VisitsService } from '../yard/visits.service';

const Decimal = Prisma.Decimal;

interface PickPayload {
  reservationIds: string[];
  orderId: string;
  shipmentId: string;
  truckCode?: string;
  sourceCode?: string;
}

const matches = (scan: string, code: string, qr?: string) => scan.trim() === qr || scan.trim().toUpperCase() === code.toUpperCase();

/**
 * Outbound (UC-11 → UC-14): reserve → pick → staging → loading → dispatch.
 * Ghi giảm tồn DUY NHẤT tại dispatch (DEC-08, BR-22); pick/load chỉ là MOVE.
 */
@Injectable()
export class OutboundService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TxRunner,
    private readonly audit: AuditService,
    private readonly codes: CodeGenerator,
    private readonly ledger: LedgerService,
    private readonly pallets: PalletsService,
    private readonly reservations: ReservationService,
    private readonly events: InventoryEvents,
    private readonly movements: MovementService,
    private readonly tasks: TasksService,
    private readonly exceptions: ExceptionsService,
    private readonly shipments: ShipmentsService,
    private readonly visits: VisitsService,
    private readonly sites: SitesService,
    private readonly occupancy: OccupancyService,
    private readonly locks: LocationLockPort,
  ) {}

  onModuleInit() {
    this.tasks.registerHandler('PICK', {
      // Được đặt vào làn staging khác của cùng khu (UC-12 A1) — chỉ chấp nhận vị trí STAGING
      allowAlternativeDestination: true,
      complete: async (tx, task, ctx) => {
        if (ctx.destinationLocationId !== task.toLocationId) {
          const dest = await tx.location.findUniqueOrThrow({ where: { id: ctx.destinationLocationId } });
          if (dest.locationType !== 'STAGING') throw DomainError.rule(ErrorCode.LOCATION_MISMATCH, `Picked pallets must go to a staging lane (scanned ${dest.code})`);
        }
        await this.completePick(tx, task, ctx.destinationLocationId, ctx.source);
      },
      cancel: async (tx, task) => {
        const pickPayload = task.payload as unknown as PickPayload;
        const changes = await this.reservations.release(tx, pickPayload.reservationIds);
        await this.events.inventoryUpdated(tx, task.siteId, changes, []);
      },
    });
    this.tasks.registerHandler('RETURN_TO_STOCK', {
      allowAlternativeDestination: true,
      complete: async (tx, task, ctx) => {
        await this.pallets.move(tx, { siteId: task.siteId, huId: task.subjectId, toLocationId: ctx.destinationLocationId, reason: 'Return to stock', source: ctx.source, commandId: task.id, taskId: task.id, lifecycle: 'IN_STOCK', internal: true });
      },
    });
  }

  // ───────────── Orders ─────────────

  async createOrder(siteId: string, body: CreateOutboundOrderRequest): Promise<OutboundOrderDetail> {
    const id = await this.tx.run(async (tx) => {
      const visit = body.truckVisitId ? await tx.truckVisit.findFirst({ where: { id: body.truckVisitId, siteId }, include: { truck: true } }) : null;
      if (body.truckVisitId && !visit) throw DomainError.notFound('Visit');
      // Staging còn trống nhiều nhất (sức chứa kiểm lại khi hoàn tất pick — BR-19)
      const stagingLocs = await tx.location.findMany({ where: { siteId, locationType: 'STAGING', deletedAt: null, blockedAt: null, zone: { zoneType: 'STAGING' } }, orderBy: { code: 'asc' } });
      const used = await tx.locationOccupancy.groupBy({ by: ['locationId'], where: { releasedAt: null, locationId: { in: stagingLocs.map((location) => location.id) } }, _sum: { unitsUsed: true } });
      const usedBy = new Map(used.map((usage) => [usage.locationId, Number(usage._sum.unitsUsed ?? 0)]));
      const staging = stagingLocs.sort((left, right) => Number(right.capacityUnits) - (usedBy.get(right.id) ?? 0) - (Number(left.capacityUnits) - (usedBy.get(left.id) ?? 0)))[0] ?? null;
      const shipment = await this.shipments.create(tx, {
        siteId,
        direction: 'OUTBOUND',
        status: 'DRAFT',
        partnerId: body.customerId ?? null,
        carrierId: visit?.truck.carrierId ?? null,
        truckVisitId: visit?.id ?? null,
        stagingLocationId: staging?.id ?? null,
        destinationText: body.destinationText ?? null,
        plannedDispatchAt: body.plannedDispatchAt ? new Date(body.plannedDispatchAt) : null,
        promisedAt: body.requestedDeliveryAt ? new Date(body.requestedDeliveryAt) : null,
      });
      const order = await tx.outboundOrder.create({
        data: {
          siteId,
          code: await this.codes.prefixed(tx, 'OUT', 5),
          customerId: body.customerId ?? null,
          requestedDeliveryAt: body.requestedDeliveryAt ? new Date(body.requestedDeliveryAt) : null,
          shipmentId: shipment.id,
          lines: { create: body.lines.map((line) => ({ siteId, skuId: line.skuId, lotId: line.lotId ?? null, orderedQty: new Decimal(line.orderedQty) })) },
        },
      });
      await this.audit.record(tx, { siteId, action: 'OUTBOUND_ORDER_CREATED', entityType: 'OutboundOrder', entityId: order.id, diff: { after: { code: order.code, lines: body.lines.length } } });
      return order.id;
    });
    return this.getOrder(siteId, id);
  }

  async confirm(siteId: string, orderId: string, expectedVersion: number, autoAllocate: boolean) {
    await this.tx.run(async (tx) => {
      const order = await this.loadOrder(tx, siteId, orderId);
      if (order.status !== 'DRAFT') throw DomainError.invalidTransition('OutboundOrder', order.status, 'CONFIRMED');
      const res = await tx.outboundOrder.updateMany({ where: { id: order.id, version: expectedVersion }, data: { status: 'CONFIRMED', version: { increment: 1 } } });
      if (res.count === 0) throw DomainError.concurrent();
      await this.shipments.transition(tx, await this.shipments.load(tx, siteId, order.shipmentId!), 'CONFIRMED');
      await this.audit.record(tx, { siteId, action: 'OUTBOUND_ORDER_CONFIRMED', entityType: 'OutboundOrder', entityId: order.id });
    });
    if (autoAllocate) await this.allocate(siteId, orderId, false);
    return this.getOrder(siteId, orderId);
  }

  /** UC-11: reserve theo FIFO/FEFO, rồi sinh task pick theo từng pallet. */
  async allocate(siteId: string, orderId: string, allOrNothing: boolean) {
    await this.tx.run(async (tx) => {
      const order = await this.loadOrder(tx, siteId, orderId);
      if (!['CONFIRMED', 'ALLOCATING', 'PICKING'].includes(order.status)) throw DomainError.invalidTransition('OutboundOrder', order.status, 'ALLOCATING');
      const shipment = await this.shipments.load(tx, siteId, order.shipmentId!);
      const visit = shipment.truckVisitId ? await tx.truckVisit.findUnique({ where: { id: shipment.truckVisitId }, include: { truck: true } }) : null;
      const newReservations = [];
      const allChanges = [];
      for (const line of order.lines) {
        const remaining = new Decimal(line.orderedQty).minus(line.allocatedQty);
        if (remaining.lte(0)) continue;
        const reserveResult = await this.reservations.reserve(tx, { siteId, outboundOrderLineId: line.id, shipmentId: shipment.id, skuId: line.skuId, lotId: line.lotId, quantity: remaining, allOrNothing });
        const allocated = new Decimal(line.allocatedQty).plus(reserveResult.reserved);
        await tx.outboundOrderLine.update({ where: { id: line.id }, data: { allocatedQty: allocated, status: allocated.gte(line.orderedQty) ? 'ALLOCATED' : allocated.gt(0) ? 'PARTIALLY_ALLOCATED' : 'OPEN' } });
        newReservations.push(...reserveResult.reservations);
        allChanges.push(...reserveResult.changes);
      }
      // Gom reservation theo pallet → một task PICK mỗi pallet
      const byHu = new Map<string, string[]>();
      for (const res of newReservations) {
        const bal = await tx.inventoryBalance.findUniqueOrThrow({ where: { id: res.balanceId } });
        const key = bal.handlingUnitId ?? `loose:${bal.id}`;
        byHu.set(key, [...(byHu.get(key) ?? []), res.id]);
      }
      for (const [huKey, reservationIds] of byHu) {
        if (huKey.startsWith('loose:')) continue; // hàng lẻ không pallet: ngoài phạm vi demo
        const hu = await tx.handlingUnit.findUniqueOrThrow({ where: { id: huKey } });
        await this.tasks.create(tx, {
          siteId,
          taskType: 'PICK',
          subjectType: 'HANDLING_UNIT',
          subjectId: hu.id,
          fromLocationId: hu.locationId,
          toLocationId: shipment.stagingLocationId,
          sourceType: 'OUTBOUND_ORDER',
          sourceId: order.id,
          priority: 2,
          payload: { reservationIds, orderId: order.id, shipmentId: shipment.id, truckCode: visit?.truck.code, sourceCode: order.code } satisfies PickPayload,
        });
      }
      const pickCount = await tx.operationTask.count({ where: { sourceType: 'OUTBOUND_ORDER', sourceId: order.id, taskType: 'PICK', status: { notIn: ['CANCELLED', 'FAILED'] } } });
      await tx.shipment.update({ where: { id: shipment.id }, data: { expectedHuCount: pickCount } });
      await tx.outboundOrder.update({ where: { id: order.id }, data: { status: byHu.size > 0 || order.status === 'PICKING' ? 'PICKING' : 'ALLOCATING', version: { increment: 1 } } });
      if (byHu.size > 0 && shipment.status === 'CONFIRMED') await this.shipments.transition(tx, shipment, 'PICKING');
      else await this.shipments.emit(tx, shipment.id);
      await this.audit.record(tx, { siteId, action: 'STOCK_RESERVED', entityType: 'OutboundOrder', entityId: order.id, diff: { after: { reservations: newReservations.length, picks: byHu.size } } });
      await this.events.inventoryUpdated(tx, siteId, allChanges, []);
    });
    return this.getOrder(siteId, orderId);
  }

  /**
   * Handler PICK (UC-12): cả pallet → di chuyển nguyên pallet; pick lẻ → tạo pallet xuất mới ở staging,
   * MOVE phần đã reserve kèm reservation. Reservation → PICKED; chưa giảm on-hand (BR-23).
   */
  private async completePick(tx: Tx, task: OperationTask, destinationId: string, source: 'CONFIRMED_SCAN' | 'CONFIRMED_MANUAL' | 'SENSOR_OBSERVED' | 'INFERRED') {
    const pickPayload = task.payload as unknown as PickPayload;
    const reservations = await tx.reservation.findMany({ where: { id: { in: pickPayload.reservationIds }, status: 'ACTIVE' } });
    if (reservations.length === 0) throw DomainError.rule(ErrorCode.PICK_MISMATCH, 'Nothing left to pick for this task');
    const hu = await tx.handlingUnit.findUniqueOrThrow({ where: { id: task.subjectId } });
    const huBalances = await tx.inventoryBalance.findMany({ where: { handlingUnitId: hu.id, qtyOnHand: { gt: 0 } } });
    const huTotal = huBalances.reduce((sum, balance) => sum.plus(balance.qtyOnHand), new Decimal(0));
    const reservedTotal = reservations.reduce((sum, reservation) => sum.plus(reservation.quantity), new Decimal(0));
    let pickedHuId = hu.id;
    if (reservedTotal.gte(huTotal) && huBalances.length === reservations.length) {
      await this.pallets.move(tx, { siteId: task.siteId, huId: hu.id, toLocationId: destinationId, reason: `Pick ${pickPayload.sourceCode ?? ''}`.trim(), source, commandId: task.id, taskId: task.id, lifecycle: 'STAGED', internal: true });
    } else {
      // Pick lẻ: pallet xuất mới
      await this.locks.lockForUpdate(tx, [destinationId, ...(hu.locationId ? [hu.locationId] : [])]);
      const outHu = await this.pallets.create(tx, task.siteId, { locationId: destinationId, source });
      pickedHuId = outHu.id;
      await this.occupancy.occupyDirect(tx, { siteId: task.siteId, locationId: destinationId, occupantType: 'HANDLING_UNIT', occupantId: outHu.id }, source);
      const changes = [];
      const txIds: bigint[] = [];
      for (const res of reservations) {
        const bal = await tx.inventoryBalance.findUniqueOrThrow({ where: { id: res.balanceId } });
        const ledgerResult = await this.ledger.post(tx, {
          siteId: task.siteId,
          txType: 'MOVE',
          idempotencyKey: `${task.id}:pick:${res.id}`,
          skuId: bal.skuId,
          lotId: bal.lotId,
          handlingUnitId: hu.id,
          toHandlingUnitId: outHu.id,
          fromLocationId: bal.locationId,
          toLocationId: destinationId,
          fromStatus: 'AVAILABLE',
          quantity: res.quantity,
          carryReserved: res.quantity,
          repointReservationIds: [res.id],
          referenceType: 'TASK',
          referenceId: task.id,
          receivedAt: bal.receivedAt,
        });
        changes.push(...ledgerResult.changes);
        txIds.push(ledgerResult.tx.id);
      }
      await tx.handlingUnit.update({ where: { id: outHu.id }, data: { lifecycle: 'STAGED', version: { increment: 1 } } });
      await this.movements.record(tx, { siteId: task.siteId, subjectType: 'HANDLING_UNIT', subjectId: outHu.id, fromLocationId: hu.locationId, toLocationId: destinationId, positionSource: source, reason: `Picked from ${hu.code}`, taskId: task.id });
      await this.events.inventoryUpdated(tx, task.siteId, changes, txIds);
      await this.events.palletMoved(tx, task.siteId, outHu.id, hu.locationId, destinationId);
      await this.events.palletMoved(tx, task.siteId, hu.id, hu.locationId, hu.locationId);
    }
    for (const res of reservations) {
      await this.reservations.markPicked(tx, res.id);
      await tx.outboundOrderLine.update({ where: { id: res.outboundOrderLineId }, data: { pickedQty: { increment: res.quantity } } });
    }
    await this.refreshLineStatuses(tx, pickPayload.orderId);
    await this.shipments.addItem(tx, pickPayload.shipmentId, task.siteId, pickedHuId);
    // Mọi pick của shipment xong → STAGED (milestone "Picked")
    const openPicks = await tx.operationTask.count({ where: { sourceType: 'OUTBOUND_ORDER', sourceId: pickPayload.orderId, taskType: 'PICK', status: { in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED'] }, id: { not: task.id } } });
    const shipment = await this.shipments.load(tx, task.siteId, pickPayload.shipmentId);
    if (openPicks === 0 && shipment.status === 'PICKING') await this.shipments.transition(tx, shipment, 'STAGED');
    else await this.shipments.emit(tx, shipment.id);
  }

  /** UC-12 E1: báo thiếu — giải phóng phần thiếu, exception SHORT_PICK; phần lấy được vẫn đưa về staging. */
  async shortPick(siteId: string, taskId: string, pickedQty: string, reason: string) {
    await this.tx.run(async (tx) => {
      const task = await tx.operationTask.findFirst({ where: { id: taskId, siteId } });
      if (!task || task.taskType !== 'PICK') throw DomainError.notFound('Pick task');
      if (task.status !== 'IN_PROGRESS') throw DomainError.invalidTransition('OperationTask', task.status, 'COMPLETED');
      const pickPayload = task.payload as unknown as PickPayload;
      const reservations = await tx.reservation.findMany({ where: { id: { in: pickPayload.reservationIds }, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
      let keep = new Decimal(pickedQty);
      const total = reservations.reduce((sum, reservation) => sum.plus(reservation.quantity), new Decimal(0));
      if (keep.gte(total) || keep.lt(0)) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, `Picked quantity must be less than ${total.toFixed(3)}`);
      const changes = [];
      for (const res of reservations) {
        const take = Prisma.Decimal.min(keep, res.quantity);
        const shortage = new Decimal(res.quantity).minus(take);
        keep = keep.minus(take);
        if (shortage.lte(0)) continue;
        const bal = await tx.inventoryBalance.update({ where: { id: res.balanceId }, data: { qtyReserved: { decrement: shortage }, version: { increment: 1 } } });
        changes.push(this.ledger.change(bal));
        if (take.lte(0)) await tx.reservation.update({ where: { id: res.id }, data: { status: 'RELEASED', version: { increment: 1 } } });
        else await tx.reservation.update({ where: { id: res.id }, data: { quantity: take, version: { increment: 1 } } });
        await tx.outboundOrderLine.update({ where: { id: res.outboundOrderLineId }, data: { allocatedQty: { decrement: shortage } } });
      }
      await this.exceptions.raise(tx, { siteId, caseType: 'SHORT_PICK', subjectType: 'HANDLING_UNIT', subjectId: task.subjectId, description: `Short pick on ${task.code}: picked ${pickedQty} of ${total.toFixed(3)} — ${reason}` });
      await this.events.inventoryUpdated(tx, siteId, changes, []);
      await this.refreshLineStatuses(tx, pickPayload.orderId);
      if (new Decimal(pickedQty).gt(0) && task.toLocationId) await this.tasks.completeInTx(tx, task, { destinationLocationId: task.toLocationId, source: 'CONFIRMED_MANUAL' });
      else await this.tasks.cancelInTx(tx, task, `Short pick: ${reason}`);
    });
  }

  // ───────────── Loading & dispatch ─────────────

  /** UC-13 bước 1: bắt đầu xếp — visit AT_DOCK → HANDLING, shipment STAGED → LOADING. */
  async startLoading(siteId: string, shipmentId: string, expectedVersion: number) {
    await this.tx.run(async (tx) => {
      const shipment = await this.shipments.load(tx, siteId, shipmentId);
      if (shipment.version !== expectedVersion) throw DomainError.concurrent();
      const visit = await this.requireDockedVisit(tx, shipment.truckVisitId);
      await this.visits.markHandlingStarted(tx, siteId, visit.id);
      await this.shipments.transition(tx, shipment, 'LOADING');
    });
    return this.shipments.detail(siteId, shipmentId);
  }

  /** UC-13 bước 2–4: quét HU + QR dock; idempotent theo HU (không đếm 2 lần — UC-13-AC2). */
  async loadScan(siteId: string, shipmentId: string, huScan: string, dockScan: string) {
    await this.tx.run(async (tx) => {
      const shipment = await this.shipments.load(tx, siteId, shipmentId);
      if (shipment.status !== 'LOADING') throw DomainError.invalidTransition('Shipment', shipment.status, 'LOADING');
      const visit = await this.requireDockedVisit(tx, shipment.truckVisitId);
      const dock = await tx.location.findUniqueOrThrow({ where: { id: visit.dockLocationId! } });
      if (!matches(dockScan, dock.code, dock.qrValue)) throw DomainError.rule(ErrorCode.DOCK_MISMATCH, `Scanned ${dockScan}, truck is at ${dock.code}`);
      const hu = await tx.handlingUnit.findFirst({ where: { siteId, code: { equals: huScan.trim(), mode: 'insensitive' } } });
      const item = hu ? await tx.shipmentItem.findFirst({ where: { shipmentId, handlingUnitId: hu.id } }) : null;
      if (!hu || !item) throw DomainError.rule(ErrorCode.HU_NOT_IN_SHIPMENT, `${huScan} is not part of ${shipment.code}`);
      if (item.loadedAt) return;
      await this.pallets.move(tx, { siteId, huId: hu.id, toLocationId: dock.id, reason: `Loaded on ${shipment.code}`, source: 'CONFIRMED_SCAN', commandId: `${shipmentId}:load:${hu.id}`, lifecycle: 'LOADED', internal: true });
      await tx.shipmentItem.update({ where: { id: item.id }, data: { loadedAt: new Date(), unloadedAt: null } });
      await this.audit.record(tx, { siteId, action: 'HU_LOADED', entityType: 'Shipment', entityId: shipment.id, diff: { after: { hu: hu.code } } });
      await this.shipments.emit(tx, shipment.id);
    });
    return this.shipments.detail(siteId, shipmentId);
  }

  async unloadScan(siteId: string, shipmentId: string, huScan: string, reason: string) {
    await this.tx.run(async (tx) => {
      const shipment = await this.shipments.load(tx, siteId, shipmentId);
      if (shipment.status !== 'LOADING' || !shipment.stagingLocationId) throw DomainError.invalidTransition('Shipment', shipment.status, 'LOADING');
      const hu = await tx.handlingUnit.findFirst({ where: { siteId, code: { equals: huScan.trim(), mode: 'insensitive' } } });
      const item = hu ? await tx.shipmentItem.findFirst({ where: { shipmentId, handlingUnitId: hu.id } }) : null;
      if (!hu || !item?.loadedAt) throw DomainError.rule(ErrorCode.HU_NOT_IN_SHIPMENT, `${huScan} is not loaded on ${shipment.code}`);
      await this.pallets.move(tx, { siteId, huId: hu.id, toLocationId: shipment.stagingLocationId, reason: `Unloaded: ${reason}`, source: 'CONFIRMED_SCAN', commandId: uuidv7(), lifecycle: 'STAGED', internal: true });
      await tx.shipmentItem.update({ where: { id: item.id }, data: { loadedAt: null, unloadedAt: new Date() } });
      await this.audit.record(tx, { siteId, action: 'HU_UNLOADED', entityType: 'Shipment', entityId: shipment.id, reason });
      await this.shipments.emit(tx, shipment.id);
    });
    return this.shipments.detail(siteId, shipmentId);
  }

  /** UC-14: xác nhận xuất — ISSUE tiêu thụ reservation đúng một lần, giải phóng dock, xe READY_TO_LEAVE. */
  async dispatch(siteId: string, shipmentId: string, sealNumber: string | undefined, expectedVersion: number) {
    await this.tx.run(async (tx) => {
      const shipment = await this.shipments.load(tx, siteId, shipmentId);
      if (shipment.status !== 'LOADING') throw DomainError.invalidTransition('Shipment', shipment.status, 'DISPATCHED');
      if (shipment.version !== expectedVersion) throw DomainError.concurrent();
      const items = await tx.shipmentItem.findMany({ where: { shipmentId } });
      const settings = await this.sites.settings(siteId, tx);
      const notLoaded = items.filter((shipmentItem) => !shipmentItem.loadedAt);
      if (items.length === 0 || (notLoaded.length > 0 && !settings.allowPartialDispatch)) {
        throw DomainError.rule(ErrorCode.SHIPMENT_NOT_FULLY_LOADED, `${notLoaded.length} pallet(s) not loaded yet (DEC-18)`, { notLoaded: notLoaded.length });
      }
      const loadedHuIds = items.filter((shipmentItem) => shipmentItem.loadedAt).map((shipmentItem) => shipmentItem.handlingUnitId!);
      const reservations = await tx.reservation.findMany({ where: { shipmentId, status: 'PICKED', balance: { handlingUnitId: { in: loadedHuIds } } }, orderBy: { id: 'asc' } });
      const changes = [];
      const txIds: bigint[] = [];
      for (const res of reservations) {
        const consumeResult = await this.reservations.consume(tx, res, `dispatch:${shipmentId}`, shipmentId);
        changes.push(...consumeResult.changes);
        txIds.push(consumeResult.tx.id);
        await tx.outboundOrderLine.update({ where: { id: res.outboundOrderLineId }, data: { shippedQty: { increment: res.quantity } } });
      }
      for (const huId of loadedHuIds) await this.pallets.setLifecycle(tx, siteId, huId, 'DISPATCHED', { clearLocation: true });
      const orders = await tx.outboundOrder.findMany({ where: { shipmentId }, include: { lines: true } });
      for (const order of orders) {
        const lines = await tx.outboundOrderLine.findMany({ where: { outboundOrderId: order.id } });
        const full = lines.every((line) => new Decimal(line.shippedQty).gte(line.orderedQty));
        await tx.outboundOrder.update({ where: { id: order.id }, data: { status: full ? 'SHIPPED' : 'PARTIALLY_SHIPPED', version: { increment: 1 } } });
        for (const line of lines) await tx.outboundOrderLine.update({ where: { id: line.id }, data: { status: new Decimal(line.shippedQty).gte(line.orderedQty) ? 'SHIPPED' : line.status } });
      }
      await this.shipments.transition(tx, shipment, 'DISPATCHED', { dispatchedAt: new Date(), sealNumber: sealNumber ?? null });
      if (shipment.truckVisitId) await this.visits.markHandlingComplete(tx, siteId, shipment.truckVisitId);
      await this.audit.record(tx, { siteId, action: 'SHIPMENT_DISPATCHED', entityType: 'Shipment', entityId: shipment.id, diff: { after: { pallets: loadedHuIds.length, issued: reservations.length } } });
      await this.events.inventoryUpdated(tx, siteId, changes, txIds);
    });
    return this.shipments.detail(siteId, shipmentId);
  }

  /** Hủy đơn trước dispatch: giải phóng reservation, hủy task, pallet đã pick quay về kho (FR-08.08). */
  async cancel(siteId: string, orderId: string, reason: string) {
    await this.tx.run(async (tx) => {
      const order = await this.loadOrder(tx, siteId, orderId);
      if (['SHIPPED', 'PARTIALLY_SHIPPED', 'CANCELLED'].includes(order.status)) throw DomainError.invalidTransition('OutboundOrder', order.status, 'CANCELLED');
      const shipment = await this.shipments.load(tx, siteId, order.shipmentId!);
      if (['LOADING', 'DISPATCHED', 'DELIVERED'].includes(shipment.status)) throw DomainError.invalidTransition('Shipment', shipment.status, 'CANCELLED');
      await this.tasks.cancelBySource(tx, 'OUTBOUND_ORDER', order.id, reason);
      const picked = await tx.reservation.findMany({ where: { outboundOrderLineId: { in: order.lines.map((line) => line.id) }, status: { in: ['ACTIVE', 'PICKED'] } } });
      const stagedHus = new Set<string>();
      for (const reservation of picked) if (reservation.status === 'PICKED') stagedHus.add((await tx.inventoryBalance.findUniqueOrThrow({ where: { id: reservation.balanceId } })).handlingUnitId!);
      const changes = await this.reservations.release(tx, picked.map((reservation) => reservation.id));
      for (const huId of stagedHus) {
        const hu = await tx.handlingUnit.findUniqueOrThrow({ where: { id: huId } });
        await this.tasks.create(tx, { siteId, taskType: 'RETURN_TO_STOCK', subjectType: 'HANDLING_UNIT', subjectId: hu.id, fromLocationId: hu.locationId, toLocationId: null, sourceType: 'OUTBOUND_ORDER', sourceId: order.id, payload: { sourceCode: order.code } });
      }
      await tx.outboundOrderLine.updateMany({ where: { outboundOrderId: order.id }, data: { status: 'CANCELLED' } });
      await tx.outboundOrder.update({ where: { id: order.id }, data: { status: 'CANCELLED', version: { increment: 1 } } });
      await this.shipments.transition(tx, shipment, 'CANCELLED');
      await this.audit.record(tx, { siteId, action: 'OUTBOUND_ORDER_CANCELLED', entityType: 'OutboundOrder', entityId: order.id, reason });
      await this.events.inventoryUpdated(tx, siteId, changes, []);
    });
    return this.getOrder(siteId, orderId);
  }

  // ───────────── Queries & helpers ─────────────

  async listOrders(siteId: string) {
    const rows = await this.prisma.outboundOrder.findMany({ where: { siteId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return Promise.all(rows.map((order) => this.getOrder(siteId, order.id)));
  }

  async getOrder(siteId: string, id: string): Promise<OutboundOrderDetail> {
    const order = await this.prisma.outboundOrder.findFirst({ where: { id, siteId }, include: { lines: true } });
    if (!order) throw DomainError.notFound('Outbound order');
    const [customer, shipment, skus] = await Promise.all([
      order.customerId ? this.prisma.partner.findUnique({ where: { id: order.customerId } }) : null,
      order.shipmentId ? this.prisma.shipment.findUnique({ where: { id: order.shipmentId } }) : null,
      this.prisma.sku.findMany({ where: { id: { in: order.lines.map((line) => line.skuId) } } }),
    ]);
    const ms = new Map(skus.map((sku) => [sku.id, sku]));
    const formatQty = (quantity: Prisma.Decimal) => new Decimal(quantity).toFixed(3);
    return {
      id: order.id,
      code: order.code,
      status: order.status,
      customer: customer ? { id: customer.id, name: customer.name } : null,
      requestedDeliveryAt: order.requestedDeliveryAt?.toISOString() ?? null,
      shipment: shipment ? { id: shipment.id, code: shipment.code, status: shipment.status, visitId: shipment.truckVisitId } : null,
      lines: order.lines.map((line) => ({
        id: line.id,
        sku: { id: line.skuId, code: ms.get(line.skuId)?.code ?? '', name: ms.get(line.skuId)?.name ?? '' },
        orderedQty: formatQty(line.orderedQty),
        allocatedQty: formatQty(line.allocatedQty),
        pickedQty: formatQty(line.pickedQty),
        shippedQty: formatQty(line.shippedQty),
        status: line.status,
      })),
      version: order.version,
    };
  }

  private async loadOrder(tx: Tx, siteId: string, id: string) {
    const order = await tx.outboundOrder.findFirst({ where: { id, siteId }, include: { lines: true } });
    if (!order || !order.shipmentId) throw DomainError.notFound('Outbound order');
    return order;
  }

  private async requireDockedVisit(tx: Tx, visitId: string | null) {
    if (!visitId) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, 'Assign a truck visit to this shipment first');
    const visit = await tx.truckVisit.findUniqueOrThrow({ where: { id: visitId } });
    if (!['AT_DOCK', 'HANDLING'].includes(visit.status) || !visit.dockLocationId) throw DomainError.invalidTransition('TruckVisit', visit.status, 'HANDLING');
    return visit;
  }

  private async refreshLineStatuses(tx: Tx, orderId: string) {
    const lines = await tx.outboundOrderLine.findMany({ where: { outboundOrderId: orderId } });
    for (const line of lines) {
      const status: OrderLineStatus = new Decimal(line.pickedQty).gte(line.orderedQty)
        ? 'PICKED'
        : new Decimal(line.pickedQty).gt(0)
          ? 'PARTIALLY_PICKED'
          : new Decimal(line.allocatedQty).gte(line.orderedQty)
            ? 'ALLOCATED'
            : new Decimal(line.allocatedQty).gt(0)
              ? 'PARTIALLY_ALLOCATED'
              : 'OPEN';
      if (status !== line.status) await tx.outboundOrderLine.update({ where: { id: line.id }, data: { status } });
    }
  }
}
