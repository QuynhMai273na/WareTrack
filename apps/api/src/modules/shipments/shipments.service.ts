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
      for (const s of inbound) await this.transition(tx, s, 'ARRIVED', { arrivedAt: new Date() });
    });
    // BR-17: không cho xe ra khi shipment chưa xong
    this.visits.registerGateOutBlockers(async (tx, visit) => {
      const ships = await tx.shipment.findMany({ where: { truckVisitId: visit.id, status: { notIn: ['CANCELLED'] } } });
      return ships
        .filter((s) => (s.direction === 'OUTBOUND' ? !['DISPATCHED', 'DELIVERED'].includes(s.status) : !['RECEIVED', 'CLOSED'].includes(s.status)))
        .map((s) => ({
          code: s.direction === 'OUTBOUND' ? 'SHIPMENT_NOT_DISPATCHED' : 'SHIPMENT_NOT_RECEIVED',
          message: `${s.code} is ${s.status}`,
          refType: 'Shipment',
          refId: s.id,
        }));
    });
    this.contributors.addSnapshot(async (tx, siteId) => {
      const ships = await tx.shipment.findMany({ where: { siteId, status: { in: ACTIVE } }, orderBy: { createdAt: 'asc' } });
      return { activeShipments: await Promise.all(ships.map((s) => this.snapshot(tx, s))) };
    });
    // K-05 On-time dispatch (KPI chính, DEC-12), K-05b On-time delivery, K-06 Inbound today
    this.contributors.addKpis(async (siteId, { todayStart, now }) => {
      const since = new Date(now.getTime() - 30 * 86_400_000);
      const settings = await this.prisma.siteSetting.findUnique({ where: { siteId_key: { siteId, key: 'onTimeDispatchToleranceMinutes' } } });
      const tol = ((settings?.value as number | undefined) ?? 0) * 60_000;
      const dispatched = await this.prisma.shipment.findMany({ where: { siteId, direction: 'OUTBOUND', dispatchedAt: { gte: since }, plannedDispatchAt: { not: null } } });
      const onTime = dispatched.filter((s) => s.dispatchedAt!.getTime() <= s.plannedDispatchAt!.getTime() + tol).length;
      const delivered = await this.prisma.shipment.findMany({ where: { siteId, direction: 'OUTBOUND', deliveredAt: { gte: since }, promisedAt: { not: null } } });
      const deliveredOnTime = delivered.filter((s) => s.deliveredAt! <= s.promisedAt!).length;
      const prevSince = new Date(now.getTime() - 60 * 86_400_000);
      const prev = await this.prisma.shipment.findMany({ where: { siteId, direction: 'OUTBOUND', deliveredAt: { gte: prevSince, lt: since }, promisedAt: { not: null } }, select: { deliveredAt: true, promisedAt: true } });
      const prevOnTime = prev.filter((s) => s.deliveredAt! <= s.promisedAt!).length;
      const inboundToday = await this.prisma.shipment.count({ where: { siteId, direction: 'INBOUND', arrivedAt: { gte: todayStart } } });
      const pct = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 1000) / 10);
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

  async create(tx: Tx, c: CreateShipment): Promise<Shipment> {
    const s = await tx.shipment.create({
      data: {
        siteId: c.siteId,
        code: await this.codes.prefixed(tx, 'SHP', 5),
        direction: c.direction,
        status: c.status,
        partnerId: c.partnerId ?? null,
        carrierId: c.carrierId ?? null,
        truckVisitId: c.truckVisitId ?? null,
        stagingLocationId: c.stagingLocationId ?? null,
        destinationText: c.destinationText ?? null,
        plannedDispatchAt: c.plannedDispatchAt ?? null,
        promisedAt: c.promisedAt ?? null,
        etaAt: c.etaAt ?? null,
        expectedHuCount: c.expectedHuCount ?? 0,
      },
    });
    await this.milestone(tx, s.id, c.status === 'EXPECTED' ? 'EXPECTED' : 'CREATED');
    await this.audit.record(tx, { siteId: c.siteId, action: 'SHIPMENT_CREATED', entityType: 'Shipment', entityId: s.id, diff: { after: { code: s.code, direction: s.direction } } });
    await this.emit(tx, s.id);
    return s;
  }

  /** ShipmentCommandPort.transition (mục 13.2) — gọi trong TX của Inbound/Outbound. */
  async transition(tx: Tx, s: Shipment, to: ShipmentStatus, data: Prisma.ShipmentUncheckedUpdateManyInput = {}) {
    if (s.status === to) return;
    if (!TRANSITIONS[s.status].includes(to)) throw DomainError.invalidTransition('Shipment', s.status, to);
    const res = await tx.shipment.updateMany({ where: { id: s.id, version: s.version, status: s.status }, data: { ...data, status: to, version: { increment: 1 } } });
    if (res.count === 0) throw DomainError.concurrent();
    await this.milestone(tx, s.id, to);
    await this.audit.record(tx, { siteId: s.siteId, action: `SHIPMENT_${to}`, entityType: 'Shipment', entityId: s.id });
    await this.emit(tx, s.id);
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
    const s = await tx.shipment.findFirst({ where: { id, siteId } });
    if (!s) throw DomainError.notFound('Shipment');
    return s;
  }

  async emit(tx: Tx, shipmentId: string) {
    const s = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    const snap = await this.snapshot(tx, s);
    const steps = await this.steps(tx, s);
    await this.outbox.publish(tx, {
      siteId: s.siteId,
      type: 'shipment.progress_updated',
      aggregateType: 'Shipment',
      aggregateId: s.id,
      aggregateVersion: s.version,
      data: { shipment: snap, steps },
    });
  }

  /** Tiến độ (K-10): outbound = HU đã load / tổng HU; inbound = HU đã nhận / HU dự kiến. */
  async progress(tx: Tx, s: Shipment): Promise<{ done: number; total: number }> {
    if (s.direction === 'INBOUND') {
      const receipts = await tx.receipt.findMany({ where: { shipmentId: s.id }, select: { id: true } });
      const done = await tx.receiptLine.count({ where: { receiptId: { in: receipts.map((r) => r.id) }, voided: false } });
      return { done, total: Math.max(s.expectedHuCount, done) };
    }
    const items = await tx.shipmentItem.findMany({ where: { shipmentId: s.id } });
    if (['DRAFT', 'CONFIRMED', 'PICKING'].includes(s.status)) {
      const hus = await tx.handlingUnit.findMany({ where: { id: { in: items.map((i) => i.handlingUnitId!).filter(Boolean) } } });
      return { done: hus.filter((h) => ['PICKED', 'STAGED', 'LOADED', 'DISPATCHED'].includes(h.lifecycle)).length, total: Math.max(items.length, s.expectedHuCount) };
    }
    return { done: items.filter((i) => i.loadedAt).length, total: items.length };
  }

  async snapshot(tx: Tx, s: Shipment): Promise<SnapshotShipment> {
    return { id: s.id, code: s.code, direction: s.direction, status: s.status, visitId: s.truckVisitId, progress: await this.progress(tx, s), version: s.version };
  }

  /** Stepper như video: Order Confirmed → Picked → Loading x/y → In Transit → Delivered; inbound: … → Unloading x/y → Received. */
  async steps(tx: Tx, s: Shipment): Promise<TrackingStep[]> {
    const ms = await tx.shipmentMilestone.findMany({ where: { shipmentId: s.id }, orderBy: { occurredAt: 'asc' } });
    const at = (...keys: string[]) => ms.find((m) => keys.includes(m.milestone))?.occurredAt.toISOString() ?? null;
    const progress = await this.progress(tx, s);
    const order: ShipmentStatus[] =
      s.direction === 'OUTBOUND' ? ['CONFIRMED', 'PICKING', 'STAGED', 'LOADING', 'DISPATCHED', 'DELIVERED'] : ['EXPECTED', 'ARRIVED', 'UNLOADING', 'RECEIVED', 'CLOSED'];
    const idx = order.indexOf(s.status);
    const step = (key: string, reachedAt: number, currentAt: number[], time: string | null, eta: Date | null = null, prog: { done: number; total: number } | null = null): TrackingStep => ({
      key,
      state: currentAt.includes(idx) ? 'CURRENT' : idx >= reachedAt ? 'DONE' : 'PENDING',
      at: time,
      eta: eta && idx < reachedAt ? eta.toISOString() : null,
      progress: prog,
    });
    if (s.direction === 'OUTBOUND') {
      return [
        step('ORDER_CONFIRMED', 0, [], at('CONFIRMED', 'CREATED')),
        step('PICKED', 2, [1], at('STAGED'), null, idx === 1 ? progress : null),
        step('LOADING', 4, [3], at('LOADING'), s.plannedDispatchAt ? new Date(s.plannedDispatchAt.getTime() - 8 * 60_000) : null, idx >= 3 ? progress : null),
        step('IN_TRANSIT', 5, [4], at('DISPATCHED'), s.plannedDispatchAt),
        step('DELIVERED', 5, [], at('DELIVERED'), s.promisedAt),
      ];
    }
    // Inbound: Order Confirmed → Picked → Loaded (mốc tại kho gửi, từ ASN) → In Transit → Unloading x/y
    const unloadEta = s.etaAt ? new Date(Math.max(s.etaAt.getTime(), Date.now()) + 15 * 60_000) : null;
    return [
      step('ORDER_CONFIRMED', 0, [], at('ORDER_CONFIRMED', 'EXPECTED', 'CREATED')),
      step('PICKED', 0, [], at('PICKED', 'EXPECTED')),
      step('LOADED', 0, [], at('LOADED', 'EXPECTED')),
      step('IN_TRANSIT', 1, [0], at('IN_TRANSIT', 'ARRIVED'), s.etaAt),
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
    return Promise.all(rows.map(async (s) => this.toRow(s)));
  }

  private async toRow(s: Shipment): Promise<ShipmentRow> {
    const d = await this.detail(s.siteId, s.id);
    return { id: d.id, code: d.code, direction: d.direction, status: d.status, partner: d.partner, visit: d.visit, progress: d.progress, plannedDispatchAt: d.plannedDispatchAt, etaAt: d.etaAt, version: d.version };
  }

  async detail(siteId: string, id: string): Promise<ShipmentDetail> {
    const s = await this.load(this.prisma, siteId, id);
    const [partner, carrier, visit, staging, items, inOrders, outOrders] = await Promise.all([
      s.partnerId ? this.prisma.partner.findUnique({ where: { id: s.partnerId } }) : null,
      s.carrierId ? this.prisma.partner.findUnique({ where: { id: s.carrierId } }) : null,
      s.truckVisitId ? this.prisma.truckVisit.findUnique({ where: { id: s.truckVisitId }, include: { truck: true } }) : null,
      s.stagingLocationId ? this.prisma.location.findUnique({ where: { id: s.stagingLocationId } }) : null,
      this.prisma.shipmentItem.findMany({ where: { shipmentId: s.id } }),
      this.prisma.inboundOrder.findMany({ where: { shipmentId: s.id } }),
      this.prisma.outboundOrder.findMany({ where: { shipmentId: s.id } }),
    ]);
    const dock = visit?.dockLocationId ? await this.prisma.location.findUnique({ where: { id: visit.dockLocationId } }) : null;
    const hus = await this.prisma.handlingUnit.findMany({ where: { id: { in: items.map((i) => i.handlingUnitId!).filter(Boolean) } } });
    const balances = await this.prisma.inventoryBalance.findMany({ where: { handlingUnitId: { in: hus.map((h) => h.id) } } });
    const skus = new Map((await this.prisma.sku.findMany({ where: { id: { in: [...new Set(balances.map((b) => b.skuId))] } } })).map((x) => [x.id, x.name]));
    return {
      id: s.id,
      code: s.code,
      direction: s.direction,
      status: s.status,
      partner: partner ? { id: partner.id, name: partner.name } : null,
      carrier: carrier ? { id: carrier.id, name: carrier.name } : null,
      visit: visit ? { id: visit.id, code: visit.code, status: visit.status, truckCode: visit.truck.code, dockCode: dock?.code ?? null } : null,
      stagingLocation: staging ? { id: staging.id, code: staging.code } : null,
      destinationText: s.destinationText,
      plannedDispatchAt: s.plannedDispatchAt?.toISOString() ?? null,
      promisedAt: s.promisedAt?.toISOString() ?? null,
      etaAt: s.etaAt?.toISOString() ?? null,
      arrivedAt: s.arrivedAt?.toISOString() ?? null,
      dispatchedAt: s.dispatchedAt?.toISOString() ?? null,
      deliveredAt: s.deliveredAt?.toISOString() ?? null,
      sealNumber: s.sealNumber,
      progress: await this.progress(this.prisma, s),
      items: items.map((i) => {
        const hu = hus.find((h) => h.id === i.handlingUnitId);
        const b = balances.find((x) => x.handlingUnitId === i.handlingUnitId);
        return { id: i.id, handlingUnitId: i.handlingUnitId, code: hu?.code ?? '', label: b ? (skus.get(b.skuId) ?? '') : '', loadedAt: i.loadedAt?.toISOString() ?? null, lifecycle: hu?.lifecycle ?? null };
      }),
      orders: [...inOrders, ...outOrders].map((o) => ({ id: o.id, code: o.code, status: o.status })),
      steps: await this.steps(this.prisma, s),
      version: s.version,
    };
  }

  async assignVisit(siteId: string, id: string, truckVisitId: string | null, expectedVersion: number) {
    await this.tx.run(async (tx) => {
      const s = await this.load(tx, siteId, id);
      if (truckVisitId) {
        const v = await tx.truckVisit.findFirst({ where: { id: truckVisitId, siteId } });
        if (!v) throw DomainError.notFound('Visit');
      }
      const res = await tx.shipment.updateMany({ where: { id, version: expectedVersion }, data: { truckVisitId, version: { increment: 1 } } });
      if (res.count === 0) throw DomainError.concurrent();
      await this.audit.record(tx, { siteId, action: 'SHIPMENT_VISIT_ASSIGNED', entityType: 'Shipment', entityId: s.id, diff: { after: { truckVisitId } } });
      await this.emit(tx, s.id);
    });
    return this.detail(siteId, id);
  }

  /** Xác nhận Delivered thủ công (DEC-11, GAP-18). */
  async deliver(siteId: string, id: string, deliveredAt: string, note: string | undefined, expectedVersion: number) {
    await this.tx.run(async (tx) => {
      const s = await this.load(tx, siteId, id);
      if (s.version !== expectedVersion) throw DomainError.concurrent();
      const when = new Date(deliveredAt);
      if (s.dispatchedAt && when < s.dispatchedAt) throw DomainError.rule('VALIDATION_ERROR', 'Delivered time is before dispatch');
      if (when.getTime() > Date.now() + 5 * 60_000) throw DomainError.rule('VALIDATION_ERROR', 'Delivered time is in the future');
      await this.transition(tx, s, 'DELIVERED', { deliveredAt: when });
      if (note) await this.audit.record(tx, { siteId, action: 'SHIPMENT_DELIVERY_NOTE', entityType: 'Shipment', entityId: s.id, reason: note });
    });
    return this.detail(siteId, id);
  }
}
