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

const D = Prisma.Decimal;

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
        const p = task.payload as unknown as PickPayload;
        const changes = await this.reservations.release(tx, p.reservationIds);
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
      const used = await tx.locationOccupancy.groupBy({ by: ['locationId'], where: { releasedAt: null, locationId: { in: stagingLocs.map((l) => l.id) } }, _sum: { unitsUsed: true } });
      const usedBy = new Map(used.map((u) => [u.locationId, Number(u._sum.unitsUsed ?? 0)]));
      const staging = stagingLocs.sort((a, b) => Number(b.capacityUnits) - (usedBy.get(b.id) ?? 0) - (Number(a.capacityUnits) - (usedBy.get(a.id) ?? 0)))[0] ?? null;
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
          lines: { create: body.lines.map((l) => ({ siteId, skuId: l.skuId, lotId: l.lotId ?? null, orderedQty: new D(l.orderedQty) })) },
        },
      });
      await this.audit.record(tx, { siteId, action: 'OUTBOUND_ORDER_CREATED', entityType: 'OutboundOrder', entityId: order.id, diff: { after: { code: order.code, lines: body.lines.length } } });
      return order.id;
    });
    return this.getOrder(siteId, id);
  }

  async confirm(siteId: string, orderId: string, expectedVersion: number, autoAllocate: boolean) {
    await this.tx.run(async (tx) => {
      const o = await this.loadOrder(tx, siteId, orderId);
      if (o.status !== 'DRAFT') throw DomainError.invalidTransition('OutboundOrder', o.status, 'CONFIRMED');
      const res = await tx.outboundOrder.updateMany({ where: { id: o.id, version: expectedVersion }, data: { status: 'CONFIRMED', version: { increment: 1 } } });
      if (res.count === 0) throw DomainError.concurrent();
      await this.shipments.transition(tx, await this.shipments.load(tx, siteId, o.shipmentId!), 'CONFIRMED');
      await this.audit.record(tx, { siteId, action: 'OUTBOUND_ORDER_CONFIRMED', entityType: 'OutboundOrder', entityId: o.id });
    });
    if (autoAllocate) await this.allocate(siteId, orderId, false);
    return this.getOrder(siteId, orderId);
  }

  /** UC-11: reserve theo FIFO/FEFO, rồi sinh task pick theo từng pallet. */
  async allocate(siteId: string, orderId: string, allOrNothing: boolean) {
    await this.tx.run(async (tx) => {
      const o = await this.loadOrder(tx, siteId, orderId);
      if (!['CONFIRMED', 'ALLOCATING', 'PICKING'].includes(o.status)) throw DomainError.invalidTransition('OutboundOrder', o.status, 'ALLOCATING');
      const shipment = await this.shipments.load(tx, siteId, o.shipmentId!);
      const visit = shipment.truckVisitId ? await tx.truckVisit.findUnique({ where: { id: shipment.truckVisitId }, include: { truck: true } }) : null;
      const newReservations = [];
      const allChanges = [];
      for (const line of o.lines) {
        const remaining = new D(line.orderedQty).minus(line.allocatedQty);
        if (remaining.lte(0)) continue;
        const r = await this.reservations.reserve(tx, { siteId, outboundOrderLineId: line.id, shipmentId: shipment.id, skuId: line.skuId, lotId: line.lotId, quantity: remaining, allOrNothing });
        const allocated = new D(line.allocatedQty).plus(r.reserved);
        await tx.outboundOrderLine.update({ where: { id: line.id }, data: { allocatedQty: allocated, status: allocated.gte(line.orderedQty) ? 'ALLOCATED' : allocated.gt(0) ? 'PARTIALLY_ALLOCATED' : 'OPEN' } });
        newReservations.push(...r.reservations);
        allChanges.push(...r.changes);
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
          sourceId: o.id,
          priority: 2,
          payload: { reservationIds, orderId: o.id, shipmentId: shipment.id, truckCode: visit?.truck.code, sourceCode: o.code } satisfies PickPayload,
        });
      }
      const pickCount = await tx.operationTask.count({ where: { sourceType: 'OUTBOUND_ORDER', sourceId: o.id, taskType: 'PICK', status: { notIn: ['CANCELLED', 'FAILED'] } } });
      await tx.shipment.update({ where: { id: shipment.id }, data: { expectedHuCount: pickCount } });
      await tx.outboundOrder.update({ where: { id: o.id }, data: { status: byHu.size > 0 || o.status === 'PICKING' ? 'PICKING' : 'ALLOCATING', version: { increment: 1 } } });
      if (byHu.size > 0 && shipment.status === 'CONFIRMED') await this.shipments.transition(tx, shipment, 'PICKING');
      else await this.shipments.emit(tx, shipment.id);
      await this.audit.record(tx, { siteId, action: 'STOCK_RESERVED', entityType: 'OutboundOrder', entityId: o.id, diff: { after: { reservations: newReservations.length, picks: byHu.size } } });
      await this.events.inventoryUpdated(tx, siteId, allChanges, []);
    });
    return this.getOrder(siteId, orderId);
  }

  /**
   * Handler PICK (UC-12): cả pallet → di chuyển nguyên pallet; pick lẻ → tạo pallet xuất mới ở staging,
   * MOVE phần đã reserve kèm reservation. Reservation → PICKED; chưa giảm on-hand (BR-23).
   */
  private async completePick(tx: Tx, task: OperationTask, destinationId: string, source: 'CONFIRMED_SCAN' | 'CONFIRMED_MANUAL' | 'SENSOR_OBSERVED' | 'INFERRED') {
    const p = task.payload as unknown as PickPayload;
    const reservations = await tx.reservation.findMany({ where: { id: { in: p.reservationIds }, status: 'ACTIVE' } });
    if (reservations.length === 0) throw DomainError.rule(ErrorCode.PICK_MISMATCH, 'Nothing left to pick for this task');
    const hu = await tx.handlingUnit.findUniqueOrThrow({ where: { id: task.subjectId } });
    const huBalances = await tx.inventoryBalance.findMany({ where: { handlingUnitId: hu.id, qtyOnHand: { gt: 0 } } });
    const huTotal = huBalances.reduce((s, b) => s.plus(b.qtyOnHand), new D(0));
    const reservedTotal = reservations.reduce((s, r) => s.plus(r.quantity), new D(0));
    let pickedHuId = hu.id;
    if (reservedTotal.gte(huTotal) && huBalances.length === reservations.length) {
      await this.pallets.move(tx, { siteId: task.siteId, huId: hu.id, toLocationId: destinationId, reason: `Pick ${p.sourceCode ?? ''}`.trim(), source, commandId: task.id, taskId: task.id, lifecycle: 'STAGED', internal: true });
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
        const r = await this.ledger.post(tx, {
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
        changes.push(...r.changes);
        txIds.push(r.tx.id);
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
    await this.refreshLineStatuses(tx, p.orderId);
    await this.shipments.addItem(tx, p.shipmentId, task.siteId, pickedHuId);
    // Mọi pick của shipment xong → STAGED (milestone "Picked")
    const openPicks = await tx.operationTask.count({ where: { sourceType: 'OUTBOUND_ORDER', sourceId: p.orderId, taskType: 'PICK', status: { in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED'] }, id: { not: task.id } } });
    const shipment = await this.shipments.load(tx, task.siteId, p.shipmentId);
    if (openPicks === 0 && shipment.status === 'PICKING') await this.shipments.transition(tx, shipment, 'STAGED');
    else await this.shipments.emit(tx, shipment.id);
  }

  /** UC-12 E1: báo thiếu — giải phóng phần thiếu, exception SHORT_PICK; phần lấy được vẫn đưa về staging. */
  async shortPick(siteId: string, taskId: string, pickedQty: string, reason: string) {
    await this.tx.run(async (tx) => {
      const task = await tx.operationTask.findFirst({ where: { id: taskId, siteId } });
      if (!task || task.taskType !== 'PICK') throw DomainError.notFound('Pick task');
      if (task.status !== 'IN_PROGRESS') throw DomainError.invalidTransition('OperationTask', task.status, 'COMPLETED');
      const p = task.payload as unknown as PickPayload;
      const reservations = await tx.reservation.findMany({ where: { id: { in: p.reservationIds }, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
      let keep = new D(pickedQty);
      const total = reservations.reduce((s, r) => s.plus(r.quantity), new D(0));
      if (keep.gte(total) || keep.lt(0)) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, `Picked quantity must be less than ${total.toFixed(3)}`);
      const changes = [];
      for (const res of reservations) {
        const take = Prisma.Decimal.min(keep, res.quantity);
        const shortage = new D(res.quantity).minus(take);
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
      await this.refreshLineStatuses(tx, p.orderId);
      if (new D(pickedQty).gt(0) && task.toLocationId) await this.tasks.completeInTx(tx, task, { destinationLocationId: task.toLocationId, source: 'CONFIRMED_MANUAL' });
      else await this.tasks.cancelInTx(tx, task, `Short pick: ${reason}`);
    });
  }

  // ───────────── Loading & dispatch ─────────────

  /** UC-13 bước 1: bắt đầu xếp — visit AT_DOCK → HANDLING, shipment STAGED → LOADING. */
  async startLoading(siteId: string, shipmentId: string, expectedVersion: number) {
    await this.tx.run(async (tx) => {
      const s = await this.shipments.load(tx, siteId, shipmentId);
      if (s.version !== expectedVersion) throw DomainError.concurrent();
      const visit = await this.requireDockedVisit(tx, s.truckVisitId);
      await this.visits.markHandlingStarted(tx, siteId, visit.id);
      await this.shipments.transition(tx, s, 'LOADING');
    });
    return this.shipments.detail(siteId, shipmentId);
  }

  /** UC-13 bước 2–4: quét HU + QR dock; idempotent theo HU (không đếm 2 lần — UC-13-AC2). */
  async loadScan(siteId: string, shipmentId: string, huScan: string, dockScan: string) {
    await this.tx.run(async (tx) => {
      const s = await this.shipments.load(tx, siteId, shipmentId);
      if (s.status !== 'LOADING') throw DomainError.invalidTransition('Shipment', s.status, 'LOADING');
      const visit = await this.requireDockedVisit(tx, s.truckVisitId);
      const dock = await tx.location.findUniqueOrThrow({ where: { id: visit.dockLocationId! } });
      if (!matches(dockScan, dock.code, dock.qrValue)) throw DomainError.rule(ErrorCode.DOCK_MISMATCH, `Scanned ${dockScan}, truck is at ${dock.code}`);
      const hu = await tx.handlingUnit.findFirst({ where: { siteId, code: { equals: huScan.trim(), mode: 'insensitive' } } });
      const item = hu ? await tx.shipmentItem.findFirst({ where: { shipmentId, handlingUnitId: hu.id } }) : null;
      if (!hu || !item) throw DomainError.rule(ErrorCode.HU_NOT_IN_SHIPMENT, `${huScan} is not part of ${s.code}`);
      if (item.loadedAt) return;
      await this.pallets.move(tx, { siteId, huId: hu.id, toLocationId: dock.id, reason: `Loaded on ${s.code}`, source: 'CONFIRMED_SCAN', commandId: `${shipmentId}:load:${hu.id}`, lifecycle: 'LOADED', internal: true });
      await tx.shipmentItem.update({ where: { id: item.id }, data: { loadedAt: new Date(), unloadedAt: null } });
      await this.audit.record(tx, { siteId, action: 'HU_LOADED', entityType: 'Shipment', entityId: s.id, diff: { after: { hu: hu.code } } });
      await this.shipments.emit(tx, s.id);
    });
    return this.shipments.detail(siteId, shipmentId);
  }

  async unloadScan(siteId: string, shipmentId: string, huScan: string, reason: string) {
    await this.tx.run(async (tx) => {
      const s = await this.shipments.load(tx, siteId, shipmentId);
      if (s.status !== 'LOADING' || !s.stagingLocationId) throw DomainError.invalidTransition('Shipment', s.status, 'LOADING');
      const hu = await tx.handlingUnit.findFirst({ where: { siteId, code: { equals: huScan.trim(), mode: 'insensitive' } } });
      const item = hu ? await tx.shipmentItem.findFirst({ where: { shipmentId, handlingUnitId: hu.id } }) : null;
      if (!hu || !item?.loadedAt) throw DomainError.rule(ErrorCode.HU_NOT_IN_SHIPMENT, `${huScan} is not loaded on ${s.code}`);
      await this.pallets.move(tx, { siteId, huId: hu.id, toLocationId: s.stagingLocationId, reason: `Unloaded: ${reason}`, source: 'CONFIRMED_SCAN', commandId: uuidv7(), lifecycle: 'STAGED', internal: true });
      await tx.shipmentItem.update({ where: { id: item.id }, data: { loadedAt: null, unloadedAt: new Date() } });
      await this.audit.record(tx, { siteId, action: 'HU_UNLOADED', entityType: 'Shipment', entityId: s.id, reason });
      await this.shipments.emit(tx, s.id);
    });
    return this.shipments.detail(siteId, shipmentId);
  }

  /** UC-14: xác nhận xuất — ISSUE tiêu thụ reservation đúng một lần, giải phóng dock, xe READY_TO_LEAVE. */
  async dispatch(siteId: string, shipmentId: string, sealNumber: string | undefined, expectedVersion: number) {
    await this.tx.run(async (tx) => {
      const s = await this.shipments.load(tx, siteId, shipmentId);
      if (s.status !== 'LOADING') throw DomainError.invalidTransition('Shipment', s.status, 'DISPATCHED');
      if (s.version !== expectedVersion) throw DomainError.concurrent();
      const items = await tx.shipmentItem.findMany({ where: { shipmentId } });
      const settings = await this.sites.settings(siteId, tx);
      const notLoaded = items.filter((i) => !i.loadedAt);
      if (items.length === 0 || (notLoaded.length > 0 && !settings.allowPartialDispatch)) {
        throw DomainError.rule(ErrorCode.SHIPMENT_NOT_FULLY_LOADED, `${notLoaded.length} pallet(s) not loaded yet (DEC-18)`, { notLoaded: notLoaded.length });
      }
      const loadedHuIds = items.filter((i) => i.loadedAt).map((i) => i.handlingUnitId!);
      const reservations = await tx.reservation.findMany({ where: { shipmentId, status: 'PICKED', balance: { handlingUnitId: { in: loadedHuIds } } }, orderBy: { id: 'asc' } });
      const changes = [];
      const txIds: bigint[] = [];
      for (const res of reservations) {
        const r = await this.reservations.consume(tx, res, `dispatch:${shipmentId}`, shipmentId);
        changes.push(...r.changes);
        txIds.push(r.tx.id);
        await tx.outboundOrderLine.update({ where: { id: res.outboundOrderLineId }, data: { shippedQty: { increment: res.quantity } } });
      }
      for (const huId of loadedHuIds) await this.pallets.setLifecycle(tx, siteId, huId, 'DISPATCHED', { clearLocation: true });
      const orders = await tx.outboundOrder.findMany({ where: { shipmentId }, include: { lines: true } });
      for (const o of orders) {
        const lines = await tx.outboundOrderLine.findMany({ where: { outboundOrderId: o.id } });
        const full = lines.every((l) => new D(l.shippedQty).gte(l.orderedQty));
        await tx.outboundOrder.update({ where: { id: o.id }, data: { status: full ? 'SHIPPED' : 'PARTIALLY_SHIPPED', version: { increment: 1 } } });
        for (const l of lines) await tx.outboundOrderLine.update({ where: { id: l.id }, data: { status: new D(l.shippedQty).gte(l.orderedQty) ? 'SHIPPED' : l.status } });
      }
      await this.shipments.transition(tx, s, 'DISPATCHED', { dispatchedAt: new Date(), sealNumber: sealNumber ?? null });
      if (s.truckVisitId) await this.visits.markHandlingComplete(tx, siteId, s.truckVisitId);
      await this.audit.record(tx, { siteId, action: 'SHIPMENT_DISPATCHED', entityType: 'Shipment', entityId: s.id, diff: { after: { pallets: loadedHuIds.length, issued: reservations.length } } });
      await this.events.inventoryUpdated(tx, siteId, changes, txIds);
    });
    return this.shipments.detail(siteId, shipmentId);
  }

  /** Hủy đơn trước dispatch: giải phóng reservation, hủy task, pallet đã pick quay về kho (FR-08.08). */
  async cancel(siteId: string, orderId: string, reason: string) {
    await this.tx.run(async (tx) => {
      const o = await this.loadOrder(tx, siteId, orderId);
      if (['SHIPPED', 'PARTIALLY_SHIPPED', 'CANCELLED'].includes(o.status)) throw DomainError.invalidTransition('OutboundOrder', o.status, 'CANCELLED');
      const s = await this.shipments.load(tx, siteId, o.shipmentId!);
      if (['LOADING', 'DISPATCHED', 'DELIVERED'].includes(s.status)) throw DomainError.invalidTransition('Shipment', s.status, 'CANCELLED');
      await this.tasks.cancelBySource(tx, 'OUTBOUND_ORDER', o.id, reason);
      const picked = await tx.reservation.findMany({ where: { outboundOrderLineId: { in: o.lines.map((l) => l.id) }, status: { in: ['ACTIVE', 'PICKED'] } } });
      const stagedHus = new Set<string>();
      for (const r of picked) if (r.status === 'PICKED') stagedHus.add((await tx.inventoryBalance.findUniqueOrThrow({ where: { id: r.balanceId } })).handlingUnitId!);
      const changes = await this.reservations.release(tx, picked.map((r) => r.id));
      for (const huId of stagedHus) {
        const hu = await tx.handlingUnit.findUniqueOrThrow({ where: { id: huId } });
        await this.tasks.create(tx, { siteId, taskType: 'RETURN_TO_STOCK', subjectType: 'HANDLING_UNIT', subjectId: hu.id, fromLocationId: hu.locationId, toLocationId: null, sourceType: 'OUTBOUND_ORDER', sourceId: o.id, payload: { sourceCode: o.code } });
      }
      await tx.outboundOrderLine.updateMany({ where: { outboundOrderId: o.id }, data: { status: 'CANCELLED' } });
      await tx.outboundOrder.update({ where: { id: o.id }, data: { status: 'CANCELLED', version: { increment: 1 } } });
      await this.shipments.transition(tx, s, 'CANCELLED');
      await this.audit.record(tx, { siteId, action: 'OUTBOUND_ORDER_CANCELLED', entityType: 'OutboundOrder', entityId: o.id, reason });
      await this.events.inventoryUpdated(tx, siteId, changes, []);
    });
    return this.getOrder(siteId, orderId);
  }

  // ───────────── Queries & helpers ─────────────

  async listOrders(siteId: string) {
    const rows = await this.prisma.outboundOrder.findMany({ where: { siteId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return Promise.all(rows.map((r) => this.getOrder(siteId, r.id)));
  }

  async getOrder(siteId: string, id: string): Promise<OutboundOrderDetail> {
    const o = await this.prisma.outboundOrder.findFirst({ where: { id, siteId }, include: { lines: true } });
    if (!o) throw DomainError.notFound('Outbound order');
    const [customer, shipment, skus] = await Promise.all([
      o.customerId ? this.prisma.partner.findUnique({ where: { id: o.customerId } }) : null,
      o.shipmentId ? this.prisma.shipment.findUnique({ where: { id: o.shipmentId } }) : null,
      this.prisma.sku.findMany({ where: { id: { in: o.lines.map((l) => l.skuId) } } }),
    ]);
    const ms = new Map(skus.map((s) => [s.id, s]));
    const f = (v: Prisma.Decimal) => new D(v).toFixed(3);
    return {
      id: o.id,
      code: o.code,
      status: o.status,
      customer: customer ? { id: customer.id, name: customer.name } : null,
      requestedDeliveryAt: o.requestedDeliveryAt?.toISOString() ?? null,
      shipment: shipment ? { id: shipment.id, code: shipment.code, status: shipment.status, visitId: shipment.truckVisitId } : null,
      lines: o.lines.map((l) => ({
        id: l.id,
        sku: { id: l.skuId, code: ms.get(l.skuId)?.code ?? '', name: ms.get(l.skuId)?.name ?? '' },
        orderedQty: f(l.orderedQty),
        allocatedQty: f(l.allocatedQty),
        pickedQty: f(l.pickedQty),
        shippedQty: f(l.shippedQty),
        status: l.status,
      })),
      version: o.version,
    };
  }

  private async loadOrder(tx: Tx, siteId: string, id: string) {
    const o = await tx.outboundOrder.findFirst({ where: { id, siteId }, include: { lines: true } });
    if (!o || !o.shipmentId) throw DomainError.notFound('Outbound order');
    return o;
  }

  private async requireDockedVisit(tx: Tx, visitId: string | null) {
    if (!visitId) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, 'Assign a truck visit to this shipment first');
    const v = await tx.truckVisit.findUniqueOrThrow({ where: { id: visitId } });
    if (!['AT_DOCK', 'HANDLING'].includes(v.status) || !v.dockLocationId) throw DomainError.invalidTransition('TruckVisit', v.status, 'HANDLING');
    return v;
  }

  private async refreshLineStatuses(tx: Tx, orderId: string) {
    const lines = await tx.outboundOrderLine.findMany({ where: { outboundOrderId: orderId } });
    for (const l of lines) {
      const status: OrderLineStatus = new D(l.pickedQty).gte(l.orderedQty)
        ? 'PICKED'
        : new D(l.pickedQty).gt(0)
          ? 'PARTIALLY_PICKED'
          : new D(l.allocatedQty).gte(l.orderedQty)
            ? 'ALLOCATED'
            : new D(l.allocatedQty).gt(0)
              ? 'PARTIALLY_ALLOCATED'
              : 'OPEN';
      if (status !== l.status) await tx.outboundOrderLine.update({ where: { id: l.id }, data: { status } });
    }
  }
}
