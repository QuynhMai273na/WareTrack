import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Prisma, Shipment, ShipmentDirection, ShipmentStatus } from '@prisma/client';
import type { ShipmentDetail, ShipmentRow, SnapshotShipment, TrackingStep } from '@waretrack/shared-schemas';
import { AuditService } from '../../platform/audit/audit.service';
import { requirePrincipal } from '../../platform/auth/decorators';
import { CodeGenerator } from '../../platform/codes/code-generator';
import { DomainError } from '../../platform/errors/domain-error';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { PrismaService, type Tx, TxRunner } from '../../platform/prisma/prisma.service';
import { DashboardContributors } from '../dashboard/contributors';
import { VisitsService } from '../yard/visits.service';

/** Transition cho phép theo mục 9.5 — tập trạng thái tách theo chiều. */
const TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  DRAFT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PICKING', 'CANCELLED'],
  PICKING: ['STAGED', 'CANCELLED'],
  STAGED: ['LOADING', 'CANCELLED'],
  LOADING: ['STAGED', 'DISPATCHED'],
  DISPATCHED: ['LOADING', 'DELIVERED'],
  DELIVERED: [],
  EXPECTED: ['ARRIVED', 'CANCELLED'],
  ARRIVED: ['UNLOADING'],
  UNLOADING: ['RECEIVED'],
  RECEIVED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
};

const ACTIVE: ShipmentStatus[] = ['DRAFT', 'CONFIRMED', 'PICKING', 'STAGED', 'LOADING', 'DISPATCHED', 'EXPECTED', 'ARRIVED', 'UNLOADING', 'RECEIVED'];

export interface CreateShipment {
  siteId: string;
  direction: ShipmentDirection;
  status: ShipmentStatus;
  partnerId?: string | null;
  carrierId?: string | null;
  truckVisitId?: string | null;
  stagingLocationId?: string | null;
  destinationText?: string | null;
  plannedDispatchAt?: Date | null;
  promisedAt?: Date | null;
  etaAt?: Date | null;
  expectedHuCount?: number;
}

/** Shipment 2 chiều (DEC-11, FR-10): milestone thật, stepper không suy từ animation (BR-30). */
@Injectable()
export class ShipmentsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TxRunner,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly codes: CodeGenerator,
    private readonly visits: VisitsService,
    private readonly contributors: DashboardContributors,
  ) {}

  onModuleInit() {
    // Xe qua cổng → shipment nhập EXPECTED → ARRIVED (mục 8.8)
    this.visits.registerVerifiedHook(async (tx, visit) => {
      const inbound = await tx.shipment.findMany({ where: { truckVisitId: visit.id, direction: 'INBOUND', status: 'EXPECTED' } });
      for (const shipment of inbound) await this.transition(tx, shipment, 'ARRIVED', { arrivedAt: new Date() });
    });
    // BR-17: không cho xe ra khi shipment chưa xong
    this.visits.registerGateOutBlockers(async (tx, visit) => {
      const ships = await tx.shipment.findMany({ where: { truckVisitId: visit.id, status: { notIn: ['CANCELLED'] } } });
      return ships
        .filter((shipment) => (shipment.direction === 'OUTBOUND' ? !['DISPATCHED', 'DELIVERED'].includes(shipment.status) : !['RECEIVED', 'CLOSED'].includes(shipment.status)))
        .map((shipment) => ({
          code: shipment.direction === 'OUTBOUND' ? 'SHIPMENT_NOT_DISPATCHED' : 'SHIPMENT_NOT_RECEIVED',
          message: `${shipment.code} is ${shipment.status}`,
          refType: 'Shipment',
          refId: shipment.id,
        }));
    });
    this.contributors.addSnapshot(async (tx, siteId) => {
      const ships = await tx.shipment.findMany({ where: { siteId, status: { in: ACTIVE } }, orderBy: { createdAt: 'asc' } });
      return { activeShipments: await Promise.all(ships.map((shipment) => this.snapshot(tx, shipment))) };
    });
    // K-05 On-time dispatch (KPI chính, DEC-12), K-05b On-time delivery, K-06 Inbound today
    this.contributors.addKpis(async (siteId, { todayStart, now }) => {
      const since = new Date(now.getTime() - 30 * 86_400_000);
      const settings = await this.prisma.siteSetting.findUnique({ where: { siteId_key: { siteId, key: 'onTimeDispatchToleranceMinutes' } } });
      const tol = ((settings?.value as number | undefined) ?? 0) * 60_000;
      const dispatched = await this.prisma.shipment.findMany({ where: { siteId, direction: 'OUTBOUND', dispatchedAt: { gte: since }, plannedDispatchAt: { not: null } } });
      const onTime = dispatched.filter((shipment) => shipment.dispatchedAt!.getTime() <= shipment.plannedDispatchAt!.getTime() + tol).length;
      const delivered = await this.prisma.shipment.findMany({ where: { siteId, direction: 'OUTBOUND', deliveredAt: { gte: since }, promisedAt: { not: null } } });
      const deliveredOnTime = delivered.filter((shipment) => shipment.deliveredAt! <= shipment.promisedAt!).length;
      const prevSince = new Date(now.getTime() - 60 * 86_400_000);
      const prev = await this.prisma.shipment.findMany({ where: { siteId, direction: 'OUTBOUND', deliveredAt: { gte: prevSince, lt: since }, promisedAt: { not: null } }, select: { deliveredAt: true, promisedAt: true } });
      const prevOnTime = prev.filter((shipment) => shipment.deliveredAt! <= shipment.promisedAt!).length;
      const inboundToday = await this.prisma.shipment.count({ where: { siteId, direction: 'INBOUND', arrivedAt: { gte: todayStart } } });
      const pct = (numerator: number, denominator: number) => (denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 10);
      return [
        { key: 'ON_TIME_DISPATCH', value: pct(onTime, dispatched.length), unit: '%', total: dispatched.length, sub: { onTime, samples: dispatched.length }, deltaPeriod: '30d', asOf: now.toISOString() },
        {
          key: 'ON_TIME_DELIVERY',
          value: pct(deliveredOnTime, delivered.length),
          unit: '%',
          total: delivered.length,
          sub: { onTime: deliveredOnTime, samples: delivered.length },
          delta: delivered.length && prev.length ? Math.round((pct(deliveredOnTime, delivered.length)! - pct(prevOnTime, prev.length)!) * 10) / 10 : null,
          deltaPeriod: '30d',
          asOf: now.toISOString(),
        },
        { key: 'INBOUND_TODAY', value: inboundToday, unit: 'shipments', deltaPeriod: 'today', asOf: now.toISOString() },
      ];
    });
  }

  async create(tx: Tx, input: CreateShipment): Promise<Shipment> {
    const shipment = await tx.shipment.create({
      data: {
        siteId: input.siteId,
        code: await this.codes.prefixed(tx, 'SHP', 5),
        direction: input.direction,
        status: input.status,
        partnerId: input.partnerId ?? null,
        carrierId: input.carrierId ?? null,
        truckVisitId: input.truckVisitId ?? null,
        stagingLocationId: input.stagingLocationId ?? null,
        destinationText: input.destinationText ?? null,
        plannedDispatchAt: input.plannedDispatchAt ?? null,
        promisedAt: input.promisedAt ?? null,
        etaAt: input.etaAt ?? null,
        expectedHuCount: input.expectedHuCount ?? 0,
      },
    });
    await this.milestone(tx, shipment.id, input.status === 'EXPECTED' ? 'EXPECTED' : 'CREATED');
    await this.audit.record(tx, { siteId: input.siteId, action: 'SHIPMENT_CREATED', entityType: 'Shipment', entityId: shipment.id, diff: { after: { code: shipment.code, direction: shipment.direction } } });
    await this.emit(tx, shipment.id);
    return shipment;
  }

  /** ShipmentCommandPort.transition (mục 13.2) — gọi trong TX của Inbound/Outbound. */
  async transition(tx: Tx, shipment: Shipment, to: ShipmentStatus, data: Prisma.ShipmentUncheckedUpdateManyInput = {}) {
    if (shipment.status === to) return;
    if (!TRANSITIONS[shipment.status].includes(to)) throw DomainError.invalidTransition('Shipment', shipment.status, to);
    const res = await tx.shipment.updateMany({ where: { id: shipment.id, version: shipment.version, status: shipment.status }, data: { ...data, status: to, version: { increment: 1 } } });
    if (res.count === 0) throw DomainError.concurrent();
    await this.milestone(tx, shipment.id, to);
    await this.audit.record(tx, { siteId: shipment.siteId, action: `SHIPMENT_${to}`, entityType: 'Shipment', entityId: shipment.id });
    await this.emit(tx, shipment.id);
  }

  async milestone(tx: Tx, shipmentId: string, milestone: string, source = 'SYSTEM') {
    let actorId: string | null = null;
    try {
      actorId = requirePrincipal().userId;
    } catch {
      actorId = null;
    }
    await tx.shipmentMilestone.create({ data: { shipmentId, milestone, source, actorId } });
  }

  async addItem(tx: Tx, shipmentId: string, siteId: string, handlingUnitId: string) {
    const exists = await tx.shipmentItem.findFirst({ where: { shipmentId, handlingUnitId } });
    if (exists) return exists;
    return tx.shipmentItem.create({ data: { shipmentId, siteId, itemType: 'HANDLING_UNIT', handlingUnitId } });
  }

  async load(tx: Tx, siteId: string, id: string) {
    const shipment = await tx.shipment.findFirst({ where: { id, siteId } });
    if (!shipment) throw DomainError.notFound('Shipment');
    return shipment;
  }

  async emit(tx: Tx, shipmentId: string) {
    const shipment = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    const snap = await this.snapshot(tx, shipment);
    const steps = await this.steps(tx, shipment);
    await this.outbox.publish(tx, {
      siteId: shipment.siteId,
      type: 'shipment.progress_updated',
      aggregateType: 'Shipment',
      aggregateId: shipment.id,
      aggregateVersion: shipment.version,
      data: { shipment: snap, steps },
    });
  }

  /** Tiến độ (K-10): outbound = HU đã load / tổng HU; inbound = HU đã nhận / HU dự kiến. */
  async progress(tx: Tx, shipment: Shipment): Promise<{ done: number; total: number }> {
    if (shipment.direction === 'INBOUND') {
      const receipts = await tx.receipt.findMany({ where: { shipmentId: shipment.id }, select: { id: true } });
      const done = await tx.receiptLine.count({ where: { receiptId: { in: receipts.map((receipt) => receipt.id) }, voided: false } });
      return { done, total: Math.max(shipment.expectedHuCount, done) };
    }
    const items = await tx.shipmentItem.findMany({ where: { shipmentId: shipment.id } });
    if (['DRAFT', 'CONFIRMED', 'PICKING'].includes(shipment.status)) {
      const hus = await tx.handlingUnit.findMany({ where: { id: { in: items.map((item) => item.handlingUnitId!).filter(Boolean) } } });
      return { done: hus.filter((handlingUnit) => ['PICKED', 'STAGED', 'LOADED', 'DISPATCHED'].includes(handlingUnit.lifecycle)).length, total: Math.max(items.length, shipment.expectedHuCount) };
    }
    return { done: items.filter((item) => item.loadedAt).length, total: items.length };
  }

  async snapshot(tx: Tx, shipment: Shipment): Promise<SnapshotShipment> {
    return { id: shipment.id, code: shipment.code, direction: shipment.direction, status: shipment.status, visitId: shipment.truckVisitId, progress: await this.progress(tx, shipment), version: shipment.version };
  }

  /** Stepper như video: Order Confirmed → Picked → Loading x/y → In Transit → Delivered; inbound: … → Unloading x/y → Received. */
  async steps(tx: Tx, shipment: Shipment): Promise<TrackingStep[]> {
    const ms = await tx.shipmentMilestone.findMany({ where: { shipmentId: shipment.id }, orderBy: { occurredAt: 'asc' } });
    const at = (...keys: string[]) => ms.find((milestone) => keys.includes(milestone.milestone))?.occurredAt.toISOString() ?? null;
    const progress = await this.progress(tx, shipment);
    const order: ShipmentStatus[] =
      shipment.direction === 'OUTBOUND' ? ['CONFIRMED', 'PICKING', 'STAGED', 'LOADING', 'DISPATCHED', 'DELIVERED'] : ['EXPECTED', 'ARRIVED', 'UNLOADING', 'RECEIVED', 'CLOSED'];
    const idx = order.indexOf(shipment.status);
    const step = (key: string, reachedAt: number, currentAt: number[], time: string | null, eta: Date | null = null, prog: { done: number; total: number } | null = null): TrackingStep => ({
      key,
      state: currentAt.includes(idx) ? 'CURRENT' : idx >= reachedAt ? 'DONE' : 'PENDING',
      at: time,
      eta: eta && idx < reachedAt ? eta.toISOString() : null,
      progress: prog,
    });
    if (shipment.direction === 'OUTBOUND') {
      return [
        step('ORDER_CONFIRMED', 0, [], at('CONFIRMED', 'CREATED')),
        step('PICKED', 2, [1], at('STAGED'), null, idx === 1 ? progress : null),
        step('LOADING', 4, [3], at('LOADING'), shipment.plannedDispatchAt ? new Date(shipment.plannedDispatchAt.getTime() - 8 * 60_000) : null, idx >= 3 ? progress : null),
        step('IN_TRANSIT', 5, [4], at('DISPATCHED'), shipment.plannedDispatchAt),
        step('DELIVERED', 5, [], at('DELIVERED'), shipment.promisedAt),
      ];
    }
    // Inbound: Order Confirmed → Picked → Loaded (mốc tại kho gửi, từ ASN) → In Transit → Unloading x/y
    const unloadEta = shipment.etaAt ? new Date(Math.max(shipment.etaAt.getTime(), Date.now()) + 15 * 60_000) : null;
    return [
      step('ORDER_CONFIRMED', 0, [], at('ORDER_CONFIRMED', 'EXPECTED', 'CREATED')),
      step('PICKED', 0, [], at('PICKED', 'EXPECTED')),
      step('LOADED', 0, [], at('LOADED', 'EXPECTED')),
      step('IN_TRANSIT', 1, [0], at('IN_TRANSIT', 'ARRIVED'), shipment.etaAt),
      step('UNLOADING', 3, [1, 2], at('RECEIVED'), unloadEta, progress),
    ];
  }

  async list(siteId: string, filter: { direction?: string; status?: string; active?: boolean }): Promise<ShipmentRow[]> {
    const rows = await this.prisma.shipment.findMany({
      where: {
        siteId,
        ...(filter.direction ? { direction: filter.direction as ShipmentDirection } : {}),
        ...(filter.status ? { status: { in: filter.status.split(',') as ShipmentStatus[] } } : filter.active ? { status: { in: ACTIVE } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return Promise.all(rows.map(async (shipment) => this.toRow(shipment)));
  }

  private async toRow(shipment: Shipment): Promise<ShipmentRow> {
    const detail = await this.detail(shipment.siteId, shipment.id);
    return { id: detail.id, code: detail.code, direction: detail.direction, status: detail.status, partner: detail.partner, visit: detail.visit, progress: detail.progress, plannedDispatchAt: detail.plannedDispatchAt, etaAt: detail.etaAt, version: detail.version };
  }

  async detail(siteId: string, id: string): Promise<ShipmentDetail> {
    const shipment = await this.load(this.prisma, siteId, id);
    const [partner, carrier, visit, staging, items, inOrders, outOrders] = await Promise.all([
      shipment.partnerId ? this.prisma.partner.findUnique({ where: { id: shipment.partnerId } }) : null,
      shipment.carrierId ? this.prisma.partner.findUnique({ where: { id: shipment.carrierId } }) : null,
      shipment.truckVisitId ? this.prisma.truckVisit.findUnique({ where: { id: shipment.truckVisitId }, include: { truck: true } }) : null,
      shipment.stagingLocationId ? this.prisma.location.findUnique({ where: { id: shipment.stagingLocationId } }) : null,
      this.prisma.shipmentItem.findMany({ where: { shipmentId: shipment.id } }),
      this.prisma.inboundOrder.findMany({ where: { shipmentId: shipment.id } }),
      this.prisma.outboundOrder.findMany({ where: { shipmentId: shipment.id } }),
    ]);
    const dock = visit?.dockLocationId ? await this.prisma.location.findUnique({ where: { id: visit.dockLocationId } }) : null;
    const hus = await this.prisma.handlingUnit.findMany({ where: { id: { in: items.map((item) => item.handlingUnitId!).filter(Boolean) } } });
    const balances = await this.prisma.inventoryBalance.findMany({ where: { handlingUnitId: { in: hus.map((handlingUnit) => handlingUnit.id) } } });
    const skus = new Map((await this.prisma.sku.findMany({ where: { id: { in: [...new Set(balances.map((balance) => balance.skuId))] } } })).map((sku) => [sku.id, sku.name]));
    return {
      id: shipment.id,
      code: shipment.code,
      direction: shipment.direction,
      status: shipment.status,
      partner: partner ? { id: partner.id, name: partner.name } : null,
      carrier: carrier ? { id: carrier.id, name: carrier.name } : null,
      visit: visit ? { id: visit.id, code: visit.code, status: visit.status, truckCode: visit.truck.code, dockCode: dock?.code ?? null } : null,
      stagingLocation: staging ? { id: staging.id, code: staging.code } : null,
      destinationText: shipment.destinationText,
      plannedDispatchAt: shipment.plannedDispatchAt?.toISOString() ?? null,
      promisedAt: shipment.promisedAt?.toISOString() ?? null,
      etaAt: shipment.etaAt?.toISOString() ?? null,
      arrivedAt: shipment.arrivedAt?.toISOString() ?? null,
      dispatchedAt: shipment.dispatchedAt?.toISOString() ?? null,
      deliveredAt: shipment.deliveredAt?.toISOString() ?? null,
      sealNumber: shipment.sealNumber,
      progress: await this.progress(this.prisma, shipment),
      items: items.map((item) => {
        const hu = hus.find((handlingUnit) => handlingUnit.id === item.handlingUnitId);
        const balance = balances.find((balanceRow) => balanceRow.handlingUnitId === item.handlingUnitId);
        return { id: item.id, handlingUnitId: item.handlingUnitId, code: hu?.code ?? '', label: balance ? (skus.get(balance.skuId) ?? '') : '', loadedAt: item.loadedAt?.toISOString() ?? null, lifecycle: hu?.lifecycle ?? null };
      }),
      orders: [...inOrders, ...outOrders].map((order) => ({ id: order.id, code: order.code, status: order.status })),
      steps: await this.steps(this.prisma, shipment),
      version: shipment.version,
    };
  }

  async assignVisit(siteId: string, id: string, truckVisitId: string | null, expectedVersion: number) {
    await this.tx.run(async (tx) => {
      const shipment = await this.load(tx, siteId, id);
      if (truckVisitId) {
        const visit = await tx.truckVisit.findFirst({ where: { id: truckVisitId, siteId } });
        if (!visit) throw DomainError.notFound('Visit');
      }
      const res = await tx.shipment.updateMany({ where: { id, version: expectedVersion }, data: { truckVisitId, version: { increment: 1 } } });
      if (res.count === 0) throw DomainError.concurrent();
      await this.audit.record(tx, { siteId, action: 'SHIPMENT_VISIT_ASSIGNED', entityType: 'Shipment', entityId: shipment.id, diff: { after: { truckVisitId } } });
      await this.emit(tx, shipment.id);
    });
    return this.detail(siteId, id);
  }

  /** Xác nhận Delivered thủ công (DEC-11, GAP-18). */
  async deliver(siteId: string, id: string, deliveredAt: string, note: string | undefined, expectedVersion: number) {
    await this.tx.run(async (tx) => {
      const shipment = await this.load(tx, siteId, id);
      if (shipment.version !== expectedVersion) throw DomainError.concurrent();
      const when = new Date(deliveredAt);
      if (shipment.dispatchedAt && when < shipment.dispatchedAt) throw DomainError.rule('VALIDATION_ERROR', 'Delivered time is before dispatch');
      if (when.getTime() > Date.now() + 5 * 60_000) throw DomainError.rule('VALIDATION_ERROR', 'Delivered time is in the future');
      await this.transition(tx, shipment, 'DELIVERED', { deliveredAt: when });
      if (note) await this.audit.record(tx, { siteId, action: 'SHIPMENT_DELIVERY_NOTE', entityType: 'Shipment', entityId: shipment.id, reason: note });
    });
    return this.detail(siteId, id);
  }
}
