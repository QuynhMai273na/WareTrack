import { Injectable } from '@nestjs/common';
import type { Driver, Location, Partner, Prisma, Truck, TruckVisit, TruckVisitStatus } from '@prisma/client';
import {
  type ArriveRequest,
  type AssignDockRequest,
  type ArriveAtDockRequest,
  type Blocker,
  type CreateVisitRequest,
  ErrorCode,
  type GateOutRequest,
  type ReasonRequest,
  type VerifyRequest,
  type VersionOnlyRequest,
  type VisitDetail,
  type VisitRow,
  type WalkInRequest,
} from '@waretrack/shared-schemas';
import { AuditService } from '../../platform/audit/audit.service';
import { CodeGenerator } from '../../platform/codes/code-generator';
import { requirePrincipal } from '../../platform/auth/decorators';
import { DomainError } from '../../platform/errors/domain-error';
import { LocationLockPort } from '../../platform/locks/location-lock';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { PrismaService, type Tx, TxRunner } from '../../platform/prisma/prisma.service';
import { SitesService } from '../sites/sites.service';
import { OccupancyService } from './occupancy.service';
import { assertTransition, ON_SITE } from './visit-state';

type VisitWithRefs = TruckVisit & { truck: Truck & { carrier: Partner | null }; driver: Driver | null };

const VISIT_INCLUDE = { truck: { include: { carrier: true } }, driver: true } as const;

/** Nguồn blocker cho gate-out do module khác đăng ký (Inbound/Outbound/Operations) — BR-17. */
export type GateOutBlockerProvider = (tx: Tx, visit: TruckVisit) => Promise<Blocker[]>;

function normalizePlate(p: string) {
  return p.replace(/[\s.-]/g, '').toUpperCase();
}

@Injectable()
export class VisitsService {
  private readonly blockerProviders: GateOutBlockerProvider[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TxRunner,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly locks: LocationLockPort,
    private readonly occupancy: OccupancyService,
    private readonly sites: SitesService,
    private readonly codes: CodeGenerator,
  ) {}

  private readonly verifiedHooks: Array<(tx: Tx, visit: TruckVisit) => Promise<void>> = [];

  registerGateOutBlockers(provider: GateOutBlockerProvider) {
    this.blockerProviders.push(provider);
  }

  /** Module khác phản ứng khi xe qua cổng (Shipments: inbound EXPECTED → ARRIVED) — IoC, không import ngược. */
  registerVerifiedHook(hook: (tx: Tx, visit: TruckVisit) => Promise<void>) {
    this.verifiedHooks.push(hook);
  }

  // ───────────── Queries ─────────────

  async list(siteId: string, filter: { status?: string; direction?: string; from?: string; to?: string }): Promise<VisitRow[]> {
    const where: Prisma.TruckVisitWhereInput = { siteId };
    if (filter.status) where.status = { in: filter.status.split(',') as TruckVisitStatus[] };
    if (filter.direction) where.direction = filter.direction as TruckVisit['direction'];
    if (filter.from || filter.to) {
      where.OR = [
        { appointmentStart: { gte: filter.from ? new Date(filter.from) : undefined, lte: filter.to ? new Date(filter.to) : undefined } },
        { arrivedAt: { gte: filter.from ? new Date(filter.from) : undefined, lte: filter.to ? new Date(filter.to) : undefined } },
      ];
    }
    const visits = await this.prisma.truckVisit.findMany({ where, include: VISIT_INCLUDE, orderBy: [{ appointmentStart: 'asc' }, { createdAt: 'asc' }], take: 500 });
    const docks = await this.dockCodes(visits.map((v) => v.dockLocationId));
    return visits.map((v) => this.toRow(v, docks));
  }

  async get(siteId: string, visitId: string): Promise<VisitDetail> {
    const v = await this.prisma.truckVisit.findFirst({ where: { id: visitId, siteId }, include: VISIT_INCLUDE });
    if (!v) throw DomainError.notFound('Visit');
    const docks = await this.dockCodes([v.dockLocationId]);
    const audit = await this.prisma.auditLog.findMany({ where: { entityType: 'TruckVisit', entityId: v.id }, orderBy: { occurredAt: 'asc' } });
    const actorIds = [...new Set(audit.map((a) => a.actorId).filter((x): x is string => !!x))];
    const actors = new Map((await this.prisma.user.findMany({ where: { id: { in: actorIds } } })).map((u) => [u.id, u.fullName]));
    return {
      ...this.toRow(v, docks),
      sealIn: v.sealIn,
      sealOut: v.sealOut,
      rejectReason: v.rejectReason,
      timeline: audit.map((a) => ({ at: a.occurredAt.toISOString(), action: a.action, actor: a.actorId ? (actors.get(a.actorId) ?? null) : 'System', note: a.reason })),
    };
  }

  async lookup(siteId: string, q: string): Promise<VisitRow[]> {
    const plate = normalizePlate(q);
    const visits = await this.prisma.truckVisit.findMany({
      where: {
        siteId,
        status: { in: ['SCHEDULED', ...ON_SITE] },
        OR: [{ code: { equals: q.toUpperCase() } }, { truck: { plateNumber: { contains: q, mode: 'insensitive' } } }, { truck: { code: { equals: q.toUpperCase() } } }, { actualPlate: { equals: plate } }],
      },
      include: VISIT_INCLUDE,
      take: 20,
    });
    const docks = await this.dockCodes(visits.map((v) => v.dockLocationId));
    return visits.map((v) => this.toRow(v, docks));
  }

  // ───────────── Commands ─────────────

  /** Tạo lịch hẹn — visit SCHEDULED (FR-04.01). */
  async create(siteId: string, body: CreateVisitRequest): Promise<VisitDetail> {
    const id = await this.tx.run(async (tx) => {
      const truck = await tx.truck.findFirst({ where: { id: body.truckId, deletedAt: null } });
      if (!truck) throw DomainError.notFound('Truck');
      const visit = await tx.truckVisit.create({
        data: {
          siteId,
          code: await this.codes.visitCode(tx),
          truckId: truck.id,
          driverId: body.driverId ?? null,
          direction: body.direction,
          status: 'SCHEDULED',
          appointmentStart: new Date(body.appointmentStart),
          appointmentEnd: new Date(body.appointmentEnd),
          etaAt: body.etaAt ? new Date(body.etaAt) : null,
          createdById: requirePrincipal().userId,
        },
      });
      await this.audit.record(tx, { siteId, action: 'VISIT_SCHEDULED', entityType: 'TruckVisit', entityId: visit.id, diff: { after: { code: visit.code, truck: truck.code } } });
      return visit.id;
    });
    return this.get(siteId, id);
  }

  /** UC-01 bước 4: SCHEDULED → AT_GATE. */
  async arrive(siteId: string, visitId: string, body: ArriveRequest): Promise<VisitDetail> {
    await this.tx.run(async (tx) => {
      const v = await this.load(tx, siteId, visitId);
      assertTransition(v.status, 'AT_GATE');
      const settings = await this.sites.settings(siteId, tx);
      const now = new Date();
      const tol = settings.appointmentToleranceMinutes * 60_000;
      const outsideWindow =
        v.appointmentStart && v.appointmentEnd && (now.getTime() < v.appointmentStart.getTime() - tol || now.getTime() > v.appointmentEnd.getTime() + tol);
      if (outsideWindow && !body.lateReason) {
        throw DomainError.rule('LATE_REASON_REQUIRED', 'Truck arrived outside the appointment window — a reason is required');
      }
      await this.transition(tx, v, body.expectedVersion, 'AT_GATE', {
        arrivedAt: now,
        actualPlate: normalizePlate(body.actualPlate),
        sealIn: body.sealIn ?? null,
        driverId: body.driverId ?? v.driverId,
        lateReason: body.lateReason ?? null,
      });
      await tx.gateEvent.create({ data: { siteId, eventType: 'IN_ARRIVAL', truckVisitId: v.id, plateRead: normalizePlate(body.actualPlate), actorId: requirePrincipal().userId } });
      await this.audit.record(tx, { siteId, action: 'VISIT_ARRIVED', entityType: 'TruckVisit', entityId: v.id, reason: body.lateReason ?? null });
      await this.emit(tx, v.id, 'truck.arrived');
    });
    return this.get(siteId, visitId);
  }

  /** UC-01 bước 5: AT_GATE → WAITING (hoặc DOCK_ASSIGNED nếu đã giữ dock trước). */
  async verify(siteId: string, visitId: string, body: VerifyRequest): Promise<VisitDetail> {
    await this.tx.run(async (tx) => {
      const v = await this.load(tx, siteId, visitId);
      const settings = await this.sites.settings(siteId, tx);
      const passed = new Set(body.documentChecks.filter((c) => c.passed).map((c) => c.key));
      const missing = settings.gateDocumentChecklist.filter((c) => c.required && !passed.has(c.key)).map((c) => c.key);
      if (v.actualPlate && normalizePlate(v.truck.plateNumber) !== v.actualPlate) missing.push('PLATE_MISMATCH');
      if (missing.length > 0) {
        throw DomainError.rule(ErrorCode.GATE_VERIFICATION_FAILED, 'Gate verification failed', { missing });
      }
      const reservation = (await this.occupancy.activeByOccupant('TRUCK_VISIT', v.id, tx)).find((o) => o.kind === 'RESERVED');
      const to: TruckVisitStatus = reservation ? 'DOCK_ASSIGNED' : 'WAITING';
      assertTransition(v.status, to);
      await this.transition(tx, v, body.expectedVersion, to, { verifiedAt: new Date() });
      await tx.gateEvent.create({ data: { siteId, eventType: 'IN_VERIFIED', truckVisitId: v.id, actorId: requirePrincipal().userId } });
      await this.audit.record(tx, { siteId, action: 'VISIT_VERIFIED', entityType: 'TruckVisit', entityId: v.id, diff: { after: { status: to, checks: [...passed] } } });
      await this.emit(tx, v.id, 'truck.status_changed', { fromStatus: v.status });
      for (const hook of this.verifiedHooks) await hook(tx, v);
    });
    return this.get(siteId, visitId);
  }

  async reject(siteId: string, visitId: string, body: ReasonRequest): Promise<VisitDetail> {
    await this.tx.run(async (tx) => {
      const v = await this.load(tx, siteId, visitId);
      assertTransition(v.status, 'REJECTED');
      const released = await this.occupancy.releaseAllFor(tx, 'TRUCK_VISIT', v.id);
      await this.transition(tx, v, body.expectedVersion, 'REJECTED', { rejectReason: body.reason, dockLocationId: null });
      await tx.gateEvent.create({ data: { siteId, eventType: 'REJECTED', truckVisitId: v.id, note: body.reason, actorId: requirePrincipal().userId } });
      await this.audit.record(tx, { siteId, action: 'VISIT_REJECTED', entityType: 'TruckVisit', entityId: v.id, reason: body.reason });
      await this.emit(tx, v.id, 'truck.status_changed', { fromStatus: v.status, reason: body.reason });
      for (const loc of released) await this.sites.emitLocationStatus(tx, siteId, loc);
    });
    return this.get(siteId, visitId);
  }

  /** Walk-in: tạo visit không lịch ở AT_GATE (FR-04.03, UC-01 A1). */
  async walkIn(siteId: string, body: WalkInRequest): Promise<VisitDetail> {
    const id = await this.tx.run(async (tx) => {
      let truckId = body.truckId;
      if (!truckId && body.newTruck) {
        const truck = await tx.truck.create({
          data: {
            code: await this.codes.prefixed(tx, 'TRK'),
            plateNumber: normalizePlate(body.newTruck.plateNumber),
            truckType: body.newTruck.truckType,
            carrierId: body.newTruck.carrierId ?? null,
          },
        });
        await this.audit.record(tx, { siteId, action: 'TRUCK_CREATED', entityType: 'Truck', entityId: truck.id, diff: { after: { code: truck.code, plate: truck.plateNumber } } });
        truckId = truck.id;
      }
      const truck = await tx.truck.findFirst({ where: { id: truckId, deletedAt: null } });
      if (!truck) throw DomainError.notFound('Truck');
      const now = new Date();
      const visit = await tx.truckVisit.create({
        data: {
          siteId,
          code: await this.codes.visitCode(tx),
          truckId: truck.id,
          driverId: body.driverId ?? null,
          direction: body.direction,
          status: 'AT_GATE',
          unscheduled: true,
          arrivedAt: now,
          actualPlate: normalizePlate(body.actualPlate),
          lateReason: body.reason,
          createdById: requirePrincipal().userId,
        },
      });
      await tx.gateEvent.create({ data: { siteId, eventType: 'IN_ARRIVAL', truckVisitId: visit.id, plateRead: visit.actualPlate, actorId: requirePrincipal().userId } });
      await this.audit.record(tx, { siteId, action: 'VISIT_WALKIN_CREATED', entityType: 'TruckVisit', entityId: visit.id, reason: body.reason });
      await this.emit(tx, visit.id, 'truck.arrived');
      return visit.id;
    });
    return this.get(siteId, id);
  }

  /** UC-03: gán / đổi dock (cả pre-assign cho visit SCHEDULED). */
  async assignDock(siteId: string, visitId: string, body: AssignDockRequest): Promise<VisitDetail> {
    await this.tx.run(async (tx) => {
      const v = await this.load(tx, siteId, visitId);
      if (!['SCHEDULED', 'WAITING', 'DOCK_ASSIGNED'].includes(v.status)) throw DomainError.invalidTransition('TruckVisit', v.status, 'DOCK_ASSIGNED');
      await this.assertDockAssignAllowed(tx, siteId);
      const previous = (await this.occupancy.activeByOccupant('TRUCK_VISIT', v.id, tx)).find((o) => o.kind === 'RESERVED');
      await this.locks.lockForUpdate(tx, [body.dockLocationId, ...(previous ? [previous.locationId] : [])]);
      const dock = await this.sites.requireLocation(tx, siteId, body.dockLocationId);
      if (dock.locationType !== 'DOCK' || !dock.dock) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, 'Selected location is not a dock');
      if (v.direction !== 'BOTH' && dock.dock.direction !== 'BOTH' && dock.dock.direction !== v.direction) {
        throw DomainError.rule(ErrorCode.DOCK_DIRECTION_MISMATCH, `Dock ${dock.code} is ${dock.dock.direction}, visit is ${v.direction}`);
      }
      if (previous?.locationId === dock.id) return; // không đổi gì
      if (previous) await this.occupancy.release(tx, previous.id);
      const settings = await this.sites.settings(siteId, tx);
      const expiresAt =
        v.status === 'SCHEDULED' && v.appointmentStart ? new Date(v.appointmentStart.getTime() + settings.dockReservationTtlMinutes * 60_000) : null;
      await this.occupancy.reserve(tx, { siteId, locationId: dock.id, occupantType: 'TRUCK_VISIT', occupantId: v.id, expiresAt });
      const to: TruckVisitStatus = v.status === 'SCHEDULED' ? 'SCHEDULED' : 'DOCK_ASSIGNED';
      if (to !== v.status) assertTransition(v.status, to);
      await this.transition(tx, v, body.expectedVersion, to, { dockLocationId: dock.id });
      await this.audit.record(tx, {
        siteId,
        action: previous ? 'DOCK_REASSIGNED' : 'DOCK_ASSIGNED',
        entityType: 'TruckVisit',
        entityId: v.id,
        diff: { before: { dockLocationId: previous?.locationId ?? null }, after: { dockLocationId: dock.id, dockCode: dock.code } },
      });
      await this.emit(tx, v.id, 'truck.dock_assigned', { previousDockLocationId: previous?.locationId ?? null });
      await this.sites.emitLocationStatus(tx, siteId, dock.id);
      if (previous) await this.sites.emitLocationStatus(tx, siteId, previous.locationId);
    });
    return this.get(siteId, visitId);
  }

  async unassignDock(siteId: string, visitId: string, body: VersionOnlyRequest): Promise<VisitDetail> {
    await this.tx.run(async (tx) => {
      const v = await this.load(tx, siteId, visitId);
      const reservation = (await this.occupancy.activeByOccupant('TRUCK_VISIT', v.id, tx)).find((o) => o.kind === 'RESERVED');
      if (!reservation || !['SCHEDULED', 'DOCK_ASSIGNED'].includes(v.status)) throw DomainError.invalidTransition('TruckVisit', v.status, 'WAITING');
      await this.locks.lockForUpdate(tx, [reservation.locationId]);
      await this.occupancy.release(tx, reservation.id);
      const to: TruckVisitStatus = v.status === 'SCHEDULED' ? 'SCHEDULED' : 'WAITING';
      await this.transition(tx, v, body.expectedVersion, to, { dockLocationId: null });
      await this.audit.record(tx, { siteId, action: 'DOCK_UNASSIGNED', entityType: 'TruckVisit', entityId: v.id, reason: body.reason ?? null });
      await this.emit(tx, v.id, 'truck.status_changed', { fromStatus: v.status });
      await this.sites.emitLocationStatus(tx, siteId, reservation.locationId);
    });
    return this.get(siteId, visitId);
  }

  /** UC-03 bước 5: xe cập dock — quét QR dock phải khớp dock đã gán (BR-15). */
  async arriveAtDock(siteId: string, visitId: string, body: ArriveAtDockRequest): Promise<VisitDetail> {
    await this.tx.run(async (tx) => {
      const v = await this.load(tx, siteId, visitId);
      assertTransition(v.status, 'AT_DOCK');
      const reservation = (await this.occupancy.activeByOccupant('TRUCK_VISIT', v.id, tx)).find((o) => o.kind === 'RESERVED');
      if (!reservation) throw DomainError.invalidTransition('TruckVisit', v.status, 'AT_DOCK');
      await this.locks.lockForUpdate(tx, [reservation.locationId]);
      const dock = await this.sites.requireLocation(tx, siteId, reservation.locationId);
      const scanned = body.scan.value.trim();
      if (scanned !== dock.qrValue && scanned.toUpperCase() !== dock.code.toUpperCase()) {
        throw DomainError.rule(ErrorCode.DOCK_MISMATCH, `Scanned ${scanned} does not match assigned dock ${dock.code}`, { expected: dock.code });
      }
      await this.occupancy.occupy(tx, reservation.id, body.scan.method === 'MANUAL' ? 'CONFIRMED_MANUAL' : 'CONFIRMED_SCAN');
      await this.transition(tx, v, body.expectedVersion, 'AT_DOCK', { dockedAt: new Date() });
      await this.audit.record(tx, { siteId, action: 'DOCK_ARRIVAL_CONFIRMED', entityType: 'TruckVisit', entityId: v.id, diff: { after: { dock: dock.code, scan: body.scan.method } } });
      await this.emit(tx, v.id, 'truck.docked');
      await this.sites.emitLocationStatus(tx, siteId, dock.id);
    });
    return this.get(siteId, visitId);
  }

  /** Hủy phục vụ — chuẩn bị rời site (UC-02 A1). */
  async abort(siteId: string, visitId: string, body: ReasonRequest): Promise<VisitDetail> {
    await this.tx.run(async (tx) => {
      const v = await this.load(tx, siteId, visitId);
      if (!['WAITING', 'DOCK_ASSIGNED', 'AT_DOCK'].includes(v.status)) throw DomainError.rule(ErrorCode.ABORT_NOT_ALLOWED, `Cannot abort a visit in ${v.status}`);
      assertTransition(v.status, 'READY_TO_LEAVE');
      const released = await this.occupancy.releaseAllFor(tx, 'TRUCK_VISIT', v.id);
      await this.transition(tx, v, body.expectedVersion, 'READY_TO_LEAVE', { readyAt: new Date(), exitReason: 'ABORTED' });
      await this.audit.record(tx, { siteId, action: 'VISIT_ABORTED', entityType: 'TruckVisit', entityId: v.id, reason: body.reason });
      await this.emit(tx, v.id, 'truck.status_changed', { fromStatus: v.status, reason: body.reason });
      for (const loc of released) await this.sites.emitLocationStatus(tx, siteId, loc);
    });
    return this.get(siteId, visitId);
  }

  /** UC-02: gate-out với kiểm tra blocker (BR-17, AC-09). */
  async gateOut(siteId: string, visitId: string, body: GateOutRequest): Promise<VisitDetail> {
    await this.tx.run(async (tx) => {
      const v = await this.load(tx, siteId, visitId);
      assertTransition(v.status, 'EXITED');
      const blockers = await this.gateOutBlockers(tx, v);
      if (blockers.length > 0) throw DomainError.blocked(ErrorCode.GATE_OUT_BLOCKED, 'Truck cannot leave yet', blockers);
      await this.transition(tx, v, body.expectedVersion, 'EXITED', { exitedAt: new Date(), sealOut: body.sealOut ?? null, exitReason: v.exitReason ?? 'COMPLETED' });
      await tx.gateEvent.create({ data: { siteId, eventType: 'OUT', truckVisitId: v.id, actorId: requirePrincipal().userId } });
      await this.audit.record(tx, { siteId, action: 'VISIT_EXITED', entityType: 'TruckVisit', entityId: v.id });
      await this.emit(tx, v.id, 'truck.departed');
    });
    return this.get(siteId, visitId);
  }

  /** Ra khẩn cấp — chỉ Site Manager, bắt buộc lý do (UC-02 E3). */
  async forceExit(siteId: string, visitId: string, reason: string): Promise<VisitDetail> {
    await this.tx.run(async (tx) => {
      const v = await this.load(tx, siteId, visitId);
      if (!ON_SITE.includes(v.status)) throw DomainError.invalidTransition('TruckVisit', v.status, 'EXITED');
      const released = await this.occupancy.releaseAllFor(tx, 'TRUCK_VISIT', v.id);
      await this.transition(tx, v, v.version, 'EXITED', { exitedAt: new Date(), exitReason: 'EMERGENCY' }, { forceExit: true });
      await tx.gateEvent.create({ data: { siteId, eventType: 'OUT', truckVisitId: v.id, note: `FORCE EXIT: ${reason}`, actorId: requirePrincipal().userId } });
      await this.audit.record(tx, { siteId, action: 'VISIT_FORCE_EXITED', entityType: 'TruckVisit', entityId: v.id, reason: `HIGH_SEVERITY: ${reason}` });
      await this.emit(tx, v.id, 'truck.departed');
      for (const loc of released) await this.sites.emitLocationStatus(tx, siteId, loc);
    });
    return this.get(siteId, visitId);
  }

  async cancel(siteId: string, visitId: string, body: ReasonRequest): Promise<VisitDetail> {
    await this.tx.run(async (tx) => {
      const v = await this.load(tx, siteId, visitId);
      assertTransition(v.status, 'CANCELLED');
      const released = await this.occupancy.releaseAllFor(tx, 'TRUCK_VISIT', v.id);
      await this.transition(tx, v, body.expectedVersion, 'CANCELLED', { dockLocationId: null });
      await this.audit.record(tx, { siteId, action: 'VISIT_CANCELLED', entityType: 'TruckVisit', entityId: v.id, reason: body.reason });
      await this.emit(tx, v.id, 'truck.status_changed', { fromStatus: v.status, reason: body.reason });
      for (const loc of released) await this.sites.emitLocationStatus(tx, siteId, loc);
    });
    return this.get(siteId, visitId);
  }

  // ───────────── Ports cho module khác (YardCommandPort — mục 13.2) ─────────────

  /** AT_DOCK → HANDLING khi bắt đầu nhận/xếp hàng (Inbound/Outbound gọi trong TX của chúng). */
  async markHandlingStarted(tx: Tx, siteId: string, visitId: string): Promise<void> {
    const v = await this.load(tx, siteId, visitId);
    if (v.status === 'HANDLING') return;
    assertTransition(v.status, 'HANDLING');
    await this.transition(tx, v, v.version, 'HANDLING', { handlingStartedAt: new Date() });
    await this.audit.record(tx, { siteId, action: 'VISIT_HANDLING_STARTED', entityType: 'TruckVisit', entityId: v.id });
    await this.emit(tx, v.id, 'truck.status_changed', { fromStatus: v.status });
  }

  /** HANDLING → READY_TO_LEAVE và giải phóng dock (receipt hoàn tất / dispatch). */
  async markHandlingComplete(tx: Tx, siteId: string, visitId: string): Promise<void> {
    const v = await this.load(tx, siteId, visitId);
    if (v.status === 'READY_TO_LEAVE') return;
    assertTransition(v.status, 'READY_TO_LEAVE');
    const released = await this.occupancy.releaseAllFor(tx, 'TRUCK_VISIT', v.id);
    await this.transition(tx, v, v.version, 'READY_TO_LEAVE', { readyAt: new Date(), exitReason: 'COMPLETED' });
    await this.audit.record(tx, { siteId, action: 'VISIT_HANDLING_COMPLETED', entityType: 'TruckVisit', entityId: v.id });
    await this.emit(tx, v.id, 'truck.status_changed', { fromStatus: v.status });
    for (const loc of released) await this.sites.emitLocationStatus(tx, siteId, loc);
  }

  // ───────────── Scheduled jobs (gọi bởi YardScheduler) ─────────────

  /** NO_SHOW sau appointmentEnd + grace (DEC-24). */
  async markNoShows(): Promise<number> {
    const candidates = await this.prisma.truckVisit.findMany({ where: { status: 'SCHEDULED', appointmentEnd: { not: null } }, select: { id: true, siteId: true } });
    let count = 0;
    for (const c of candidates) {
      const changed = await this.tx.run(async (tx) => {
        const v = await this.load(tx, c.siteId, c.id);
        const settings = await this.sites.settings(c.siteId, tx);
        if (v.status !== 'SCHEDULED' || !v.appointmentEnd) return false;
        if (v.appointmentEnd.getTime() + settings.noShowGraceMinutes * 60_000 > Date.now()) return false;
        const released = await this.occupancy.releaseAllFor(tx, 'TRUCK_VISIT', v.id);
        await this.transition(tx, v, v.version, 'NO_SHOW', { dockLocationId: null });
        await this.audit.record(tx, { siteId: c.siteId, action: 'VISIT_NO_SHOW', entityType: 'TruckVisit', entityId: v.id, actorType: 'SYSTEM' });
        await this.emit(tx, v.id, 'truck.status_changed', { fromStatus: 'SCHEDULED' });
        for (const loc of released) await this.sites.emitLocationStatus(tx, c.siteId, loc);
        return true;
      });
      if (changed) count++;
    }
    return count;
  }

  /** Giữ dock hết hạn (DEC-28): giải phóng, visit DOCK_ASSIGNED quay về WAITING. */
  async expireDockReservations(): Promise<number> {
    const expired = await this.prisma.locationOccupancy.findMany({
      where: { occupantType: 'TRUCK_VISIT', kind: 'RESERVED', releasedAt: null, expiresAt: { lt: new Date() } },
    });
    for (const occ of expired) {
      await this.tx.run(async (tx) => {
        await this.locks.lockForUpdate(tx, [occ.locationId]);
        const still = await tx.locationOccupancy.findFirst({ where: { id: occ.id, releasedAt: null, kind: 'RESERVED' } });
        if (!still) return;
        await this.occupancy.release(tx, occ.id);
        const v = await this.load(tx, occ.siteId, occ.occupantId);
        const to: TruckVisitStatus = v.status === 'DOCK_ASSIGNED' ? 'WAITING' : v.status;
        await this.transition(tx, v, v.version, to, { dockLocationId: null });
        await this.audit.record(tx, { siteId: occ.siteId, action: 'DOCK_RESERVATION_EXPIRED', entityType: 'TruckVisit', entityId: v.id, actorType: 'SYSTEM' });
        await this.emit(tx, v.id, 'truck.status_changed', { fromStatus: v.status });
        await this.sites.emitLocationStatus(tx, occ.siteId, occ.locationId);
      });
    }
    return expired.length;
  }

  // ───────────── Internals ─────────────

  private async gateOutBlockers(tx: Tx, v: TruckVisit): Promise<Blocker[]> {
    const blockers: Blocker[] = [];
    const occ = await this.occupancy.activeByOccupant('TRUCK_VISIT', v.id, tx);
    if (occ.length > 0) blockers.push({ code: 'DOCK_NOT_RELEASED', message: 'Dock has not been released for this visit', refType: 'Location', refId: occ[0].locationId });
    for (const provider of this.blockerProviders) blockers.push(...(await provider(tx, v)));
    return blockers;
  }

  /** DEC-32: Warehouse Supervisor chỉ gán dock khi site bật warehouseCanAssignDock. */
  private async assertDockAssignAllowed(tx: Tx, siteId: string) {
    const principal = requirePrincipal();
    const yardRoles = ['SITE_MANAGER', 'YARD_DISPATCHER'];
    if (principal.roles.some((r) => yardRoles.includes(r))) return;
    const settings = await this.sites.settings(siteId, tx);
    if (!settings.warehouseCanAssignDock) throw DomainError.forbidden('Dock assignment by warehouse staff is disabled for this site');
  }

  private async load(tx: Tx, siteId: string, visitId: string): Promise<VisitWithRefs> {
    const v = await tx.truckVisit.findFirst({ where: { id: visitId, siteId }, include: VISIT_INCLUDE });
    if (!v) throw DomainError.notFound('Visit');
    return v;
  }

  /** Chuyển trạng thái có điều kiện status + version (mục 9 — race condition). */
  private async transition(
    tx: Tx,
    v: TruckVisit,
    expectedVersion: number,
    to: TruckVisitStatus,
    data: Prisma.TruckVisitUncheckedUpdateManyInput,
    opts: { forceExit?: boolean } = {},
  ) {
    if (to !== v.status) assertTransition(v.status, to, opts);
    const res = await tx.truckVisit.updateMany({
      where: { id: v.id, version: expectedVersion, status: v.status },
      data: { ...data, status: to, version: { increment: 1 } },
    });
    if (res.count === 0) throw DomainError.concurrent();
  }

  private async emit(tx: Tx, visitId: string, type: 'truck.arrived' | 'truck.dock_assigned' | 'truck.docked' | 'truck.status_changed' | 'truck.departed', extra: Record<string, unknown> = {}) {
    const v = await tx.truckVisit.findUniqueOrThrow({ where: { id: visitId }, include: VISIT_INCLUDE });
    const docks = await this.dockCodes([v.dockLocationId], tx);
    const row = this.toRow(v, docks);
    await this.outbox.publish(tx, {
      siteId: v.siteId,
      type,
      aggregateType: 'TruckVisit',
      aggregateId: v.id,
      aggregateVersion: v.version,
      data: { visitId: v.id, visit: row, ...extra },
    });
  }

  private async dockCodes(ids: Array<string | null>, tx?: Tx): Promise<Map<string, Location>> {
    const clean = [...new Set(ids.filter((x): x is string => !!x))];
    if (clean.length === 0) return new Map();
    const locs = await (tx ?? this.prisma).location.findMany({ where: { id: { in: clean } } });
    return new Map(locs.map((l) => [l.id, l]));
  }

  toRow(v: VisitWithRefs, docks: Map<string, Location>): VisitRow {
    const dock = v.dockLocationId ? docks.get(v.dockLocationId) : undefined;
    const iso = (d: Date | null) => d?.toISOString() ?? null;
    return {
      id: v.id,
      siteId: v.siteId,
      code: v.code,
      status: v.status,
      direction: v.direction,
      unscheduled: v.unscheduled,
      truck: {
        id: v.truck.id,
        code: v.truck.code,
        plateNumber: v.truck.plateNumber,
        truckType: v.truck.truckType,
        carrier: v.truck.carrier ? { id: v.truck.carrier.id, code: v.truck.carrier.code, name: v.truck.carrier.name } : null,
      },
      driver: v.driver ? { id: v.driver.id, fullName: v.driver.fullName, licenseNumber: v.driver.licenseNumber, phone: v.driver.phone } : null,
      dock: dock ? { id: dock.id, code: dock.code } : null,
      appointmentStart: iso(v.appointmentStart),
      appointmentEnd: iso(v.appointmentEnd),
      etaAt: iso(v.etaAt),
      arrivedAt: iso(v.arrivedAt),
      verifiedAt: iso(v.verifiedAt),
      dockedAt: iso(v.dockedAt),
      handlingStartedAt: iso(v.handlingStartedAt),
      readyAt: iso(v.readyAt),
      exitedAt: iso(v.exitedAt),
      exitReason: v.exitReason,
      actualPlate: v.actualPlate,
      version: v.version,
    };
  }
}
