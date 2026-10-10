import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Prisma, VehicleStay, VehicleStayStatus } from '@prisma/client';
import {
  type CreateStayRequest,
  ErrorCode,
  type InspectionRequest,
  type KpiDto,
  type ReceiveVehicleRequest,
  type SnapshotVehicle,
  type VehicleHistoryEntry,
  type VehicleStayDto,
  vinCheckDigitValid,
} from '@waretrack/shared-schemas';
import { AuditService } from '../../platform/audit/audit.service';
import { requirePrincipal } from '../../platform/auth/decorators';
import { DomainError } from '../../platform/errors/domain-error';
import { LocationLockPort } from '../../platform/locks/location-lock';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { PrismaService, type Tx, TxRunner } from '../../platform/prisma/prisma.service';
import { DashboardContributors } from '../dashboard/contributors';
import { ExceptionsService } from '../operations/exceptions.service';
import { MovementService } from '../operations/movement.service';
import { TasksService } from '../operations/tasks.service';
import { SitesService } from '../sites/sites.service';
import { OccupancyService } from '../yard/occupancy.service';

/** Transition của VehicleStay (mục 9.2). Move nội bộ không đổi lifecycle. */
const TRANSITIONS: Record<VehicleStayStatus, VehicleStayStatus[]> = {
  EXPECTED: ['RECEIVED', 'CANCELLED'],
  RECEIVED: ['INSPECTED', 'CANCELLED'],
  INSPECTED: ['ALLOCATED'],
  ALLOCATED: ['INSPECTED', 'STORED'],
  STORED: ['RELEASE_REQUESTED'],
  RELEASE_REQUESTED: ['STORED', 'RELEASED'],
  RELEASED: ['EXITED'],
  EXITED: [],
  CANCELLED: [],
};

const ACTIVE: VehicleStayStatus[] = ['EXPECTED', 'RECEIVED', 'INSPECTED', 'ALLOCATED', 'STORED', 'RELEASE_REQUESTED', 'RELEASED'];
const matches = (scan: string, loc: { code: string; qrValue: string }) => scan.trim() === loc.qrValue || scan.trim().toUpperCase() === loc.code.toUpperCase();

/** Vehicle Storage (UC-04 → UC-07): xe ô tô là đối tượng lưu bãi, khác xe tải vận chuyển (BR-11). */
@Injectable()
export class VehiclesService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TxRunner,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly occupancy: OccupancyService,
    private readonly locks: LocationLockPort,
    private readonly sites: SitesService,
    private readonly movements: MovementService,
    private readonly tasks: TasksService,
    private readonly exceptions: ExceptionsService,
    private readonly contributors: DashboardContributors,
  ) {}

  onModuleInit() {
    // MOVE_VEHICLE: hoàn tất = chiếm chỗ đã giữ, giải phóng chỗ cũ, ghi movement (UC-06, UC-07)
    this.tasks.registerHandler('MOVE_VEHICLE', {
      complete: async (tx, task, ctx) => this.arrive(tx, task.siteId, task.subjectId, ctx.destinationLocationId, ctx.source, task.id),
      cancel: async (tx, task) => {
        const reserved = (await this.occupancy.activeByOccupant('VEHICLE_STAY', task.subjectId, tx)).filter((o) => o.kind === 'RESERVED');
        for (const r of reserved) {
          await this.occupancy.release(tx, r.id);
          await this.sites.emitLocationStatus(tx, task.siteId, r.locationId);
        }
        const stay = await tx.vehicleStay.findUnique({ where: { id: task.subjectId } });
        if (stay?.status === 'ALLOCATED') await this.transition(tx, stay, 'INSPECTED');
      },
    });
    this.contributors.addKpis((siteId, { todayStart, now }) => this.kpis(siteId, todayStart, now));
    this.contributors.addSnapshot(async (tx, siteId) => {
      const stays = await tx.vehicleStay.findMany({ where: { siteId, status: { in: ACTIVE } }, include: { vehicle: true } });
      const occ = await tx.locationOccupancy.findMany({ where: { occupantType: 'VEHICLE_STAY', occupantId: { in: stays.map((s) => s.id) }, releasedAt: null, kind: 'OCCUPIED' } });
      return { vehicles: stays.map((s) => this.snapshot(s, occ.find((o) => o.occupantId === s.id) ?? null)) };
    });
  }

  /** KPI bãi lưu xe — chỉ góp cho site có ô đỗ (đơn vị riêng, không cộng với pallet/xe tải — BR-31). */
  private async kpis(siteId: string, todayStart: Date, now: Date): Promise<KpiDto[]> {
    const slots = await this.prisma.location.count({ where: { siteId, locationType: 'PARKING_SLOT', deletedAt: null } });
    if (slots === 0) return [];
    const asOf = now.toISOString();
    const [stored, onHold, damaged, pending, approved, receivedToday, exitedToday] = await Promise.all([
      this.prisma.vehicleStay.count({ where: { siteId, status: { in: ['STORED', 'RELEASE_REQUESTED'] } } }),
      this.prisma.vehicleStay.count({ where: { siteId, status: { in: ACTIVE }, holdFlag: true } }),
      this.prisma.vehicleStay.count({ where: { siteId, status: { in: ACTIVE }, conditionStatus: 'MAJOR_DAMAGE' } }),
      this.prisma.releaseRequest.count({ where: { siteId, status: 'PENDING' } }),
      this.prisma.releaseRequest.count({ where: { siteId, status: 'APPROVED' } }),
      this.prisma.vehicleStay.count({ where: { siteId, receivedAt: { gte: todayStart } } }),
      this.prisma.vehicleStay.count({ where: { siteId, exitedAt: { gte: todayStart } } }),
    ]);
    return [
      { key: 'VEHICLES_STORED', value: stored, unit: 'vehicles', sub: { onHold, damaged }, delta: receivedToday, deltaPeriod: 'received today', asOf },
      { key: 'VEHICLE_RELEASES', value: pending, unit: 'requests', sub: { approved, exitedToday }, asOf },
    ];
  }

  // ───────────── Commands ─────────────

  /** UC-04 bước 1–2: tạo lượt lưu EXPECTED theo VIN (BR-14, DEC-22). */
  async create(siteId: string, body: CreateStayRequest) {
    if (!vinCheckDigitValid(body.vin) && !body.acceptCheckDigit) {
      throw DomainError.rule('VIN_CHECK_DIGIT_CONFIRM_REQUIRED', 'VIN check digit does not match — confirm to continue (DEC-22)');
    }
    const id = await this.tx.run(async (tx) => {
      const vehicle = await tx.storedVehicle.upsert({
        where: { vin: body.vin },
        create: { vin: body.vin, make: body.make ?? null, model: body.model ?? null, modelYear: body.modelYear ?? null, color: body.color ?? null, plateNumber: body.plateNumber ?? null, ownerPartnerId: body.ownerPartnerId ?? null },
        update: { ...(body.make ? { make: body.make } : {}), ...(body.model ? { model: body.model } : {}), ...(body.plateNumber ? { plateNumber: body.plateNumber } : {}) },
      });
      const active = await tx.vehicleStay.findFirst({ where: { vehicleId: vehicle.id, status: { in: ACTIVE } } });
      if (active) throw DomainError.conflict('VEHICLE_ALREADY_IN_STORAGE', `VIN ${body.vin} already has an active stay (BR-14)`, { stayId: active.id, siteId: active.siteId });
      const stay = await tx.vehicleStay.create({ data: { siteId, vehicleId: vehicle.id, status: 'EXPECTED', expectedAt: body.expectedAt ? new Date(body.expectedAt) : null } });
      await this.audit.record(tx, { siteId, action: 'VEHICLE_STAY_CREATED', entityType: 'VehicleStay', entityId: stay.id, diff: { after: { vin: body.vin } }, reason: body.acceptCheckDigit ? 'VIN check digit warning accepted' : null });
      await this.emit(tx, stay.id, 'vehicle.status_changed');
      return stay.id;
    });
    return this.get(siteId, id);
  }

  async receive(siteId: string, id: string, body: ReceiveVehicleRequest) {
    await this.tx.run(async (tx) => {
      const stay = await this.load(tx, siteId, id);
      if (body.scan.value.trim().toUpperCase() !== stay.vehicle.vin) throw DomainError.rule('VIN_MISMATCH', `Scanned ${body.scan.value} does not match ${stay.vehicle.vin}`);
      await this.transition(tx, stay, 'RECEIVED', { receivedAt: new Date(), odometerKm: body.odometerKm ?? null, fuelOrBatteryPct: body.fuelOrBatteryPct ?? null, keyTag: body.keyTag ?? null }, body.expectedVersion);
      await tx.gateEvent.create({ data: { siteId, eventType: 'VEHICLE_IN', vehicleStayId: stay.id, plateRead: stay.vehicle.plateNumber, actorId: requirePrincipal().userId } });
      await this.audit.record(tx, { siteId, action: 'VEHICLE_RECEIVED', entityType: 'VehicleStay', entityId: stay.id });
    });
    return this.get(siteId, id);
  }

  /** UC-04 bước 4–5: checklist bắt buộc (DEC-20); hư hỏng nặng → exception + hold tùy chọn. */
  async inspect(siteId: string, id: string, body: InspectionRequest) {
    await this.tx.run(async (tx) => {
      const stay = await this.load(tx, siteId, id);
      const settings = await this.sites.settings(siteId, tx);
      const passed = new Set(body.checklist.filter((c) => c.passed).map((c) => c.key));
      const missing = settings.vehicleInspectionChecklist.filter((c) => c.required && !passed.has(c.key) && !body.checklist.some((x) => x.key === c.key)).map((c) => c.key);
      if (missing.length) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, 'Inspection checklist incomplete', { missing });
      await tx.vehicleInspection.create({ data: { siteId, vehicleStayId: stay.id, inspectionType: body.inspectionType, checklist: body.checklist as Prisma.InputJsonValue, resultCondition: body.resultCondition, inspectorId: requirePrincipal().userId } });
      const data: Prisma.VehicleStayUncheckedUpdateManyInput = { conditionStatus: body.resultCondition };
      if (body.setHold) Object.assign(data, { holdFlag: true, holdReason: body.setHold.reason });
      if (body.inspectionType === 'RECEIVING') await this.transition(tx, stay, 'INSPECTED', data, body.expectedVersion);
      else await this.update(tx, stay, data, body.expectedVersion);
      if (body.resultCondition === 'MAJOR_DAMAGE') {
        await this.exceptions.raise(tx, { siteId, caseType: 'VEHICLE_DAMAGE', severity: 'HIGH', subjectType: 'VEHICLE_STAY', subjectId: stay.id, description: `Major damage on ${stay.vehicle.vin}` });
      }
      await this.audit.record(tx, { siteId, action: 'VEHICLE_INSPECTED', entityType: 'VehicleStay', entityId: stay.id, diff: { after: { condition: body.resultCondition, hold: !!body.setHold } } });
    });
    return this.get(siteId, id);
  }

  /** UC-06: giữ ô đỗ (BR-01) + sinh task MOVE_VEHICLE. */
  async allocateSlot(siteId: string, id: string, slotLocationId: string, expectedVersion: number) {
    await this.tx.run(async (tx) => {
      const stay = await this.load(tx, siteId, id);
      await this.locks.lockForUpdate(tx, [slotLocationId]);
      const slot = await this.sites.requireLocation(tx, siteId, slotLocationId);
      if (slot.locationType !== 'PARKING_SLOT') throw DomainError.rule(ErrorCode.VALIDATION_ERROR, 'Selected location is not a parking slot');
      await this.occupancy.reserve(tx, { siteId, locationId: slot.id, occupantType: 'VEHICLE_STAY', occupantId: stay.id });
      await this.transition(tx, stay, 'ALLOCATED', {}, expectedVersion);
      await this.createMoveTask(tx, stay, null, slot.id, 'PARK');
      await this.audit.record(tx, { siteId, action: 'SLOT_RESERVED', entityType: 'VehicleStay', entityId: stay.id, diff: { after: { slot: slot.code } } });
      await this.sites.emitLocationStatus(tx, siteId, slot.id);
    });
    return this.get(siteId, id);
  }

  async releaseAllocation(siteId: string, id: string, expectedVersion: number) {
    await this.tx.run(async (tx) => {
      const stay = await this.load(tx, siteId, id);
      if (stay.version !== expectedVersion) throw DomainError.concurrent();
      await this.tasks.cancelBySource(tx, 'VEHICLE_STAY', stay.id, 'Allocation released');
      const fresh = await this.load(tx, siteId, id);
      if (fresh.status === 'ALLOCATED') await this.transition(tx, fresh, 'INSPECTED');
    });
    return this.get(siteId, id);
  }

  /** Xác nhận đỗ trực tiếp bằng quét QR ô (không qua hàng đợi task). Ô khác ô đã giữ: chỉ khi ô đó còn trống (UC-06 A1). */
  async confirmParked(siteId: string, id: string, scan: string, method: string, expectedVersion: number) {
    await this.tx.run(async (tx) => {
      const stay = await this.load(tx, siteId, id);
      if (stay.version !== expectedVersion) throw DomainError.concurrent();
      if (stay.status !== 'ALLOCATED') throw DomainError.invalidTransition('VehicleStay', stay.status, 'STORED');
      const reserved = (await this.occupancy.activeByOccupant('VEHICLE_STAY', stay.id, tx)).find((o) => o.kind === 'RESERVED');
      const scanned = await tx.location.findFirst({ where: { siteId, deletedAt: null, OR: [{ qrValue: scan.trim() }, { code: { equals: scan.trim(), mode: 'insensitive' } }] } });
      if (!scanned || scanned.locationType !== 'PARKING_SLOT') throw DomainError.rule('SLOT_MISMATCH', `${scan} is not a parking slot`);
      if (reserved && reserved.locationId !== scanned.id) {
        await this.locks.lockForUpdate(tx, [reserved.locationId, scanned.id]);
        await this.occupancy.release(tx, reserved.id);
        await this.occupancy.reserve(tx, { siteId, locationId: scanned.id, occupantType: 'VEHICLE_STAY', occupantId: stay.id });
        await this.sites.emitLocationStatus(tx, siteId, reserved.locationId);
      }
      const open = await tx.operationTask.findMany({ where: { sourceType: 'VEHICLE_STAY', sourceId: stay.id, status: { in: ['PENDING', 'ASSIGNED', 'BLOCKED'] } } });
      for (const t of open) await tx.operationTask.update({ where: { id: t.id }, data: { status: 'CANCELLED', blockReason: 'Parked confirmed directly', version: { increment: 1 } } });
      await this.arrive(tx, siteId, stay.id, scanned.id, method === 'MANUAL' ? 'CONFIRMED_MANUAL' : 'CONFIRMED_SCAN', null);
    });
    return this.get(siteId, id);
  }

  /** UC-07: lệnh di chuyển — giữ chỗ đích + task MOVE_VEHICLE. */
  async move(siteId: string, id: string, toLocationId: string, reason: string) {
    await this.tx.run(async (tx) => {
      const stay = await this.load(tx, siteId, id);
      if (!['STORED', 'RELEASE_REQUESTED'].includes(stay.status)) throw DomainError.invalidTransition('VehicleStay', stay.status, 'MOVE');
      const current = (await this.occupancy.activeByOccupant('VEHICLE_STAY', stay.id, tx)).find((o) => o.kind === 'OCCUPIED');
      await this.locks.lockForUpdate(tx, [toLocationId, ...(current ? [current.locationId] : [])]);
      await this.occupancy.reserve(tx, { siteId, locationId: toLocationId, occupantType: 'VEHICLE_STAY', occupantId: stay.id });
      await this.createMoveTask(tx, stay, current?.locationId ?? null, toLocationId, reason);
      await this.audit.record(tx, { siteId, action: 'VEHICLE_MOVE_CREATED', entityType: 'VehicleStay', entityId: stay.id, reason });
      await this.sites.emitLocationStatus(tx, siteId, toLocationId);
    });
    return this.get(siteId, id);
  }

  async setHold(siteId: string, id: string, hold: boolean, reason: string, expectedVersion: number) {
    await this.tx.run(async (tx) => {
      const stay = await this.load(tx, siteId, id);
      if (['EXITED', 'CANCELLED'].includes(stay.status)) throw DomainError.invalidTransition('VehicleStay', stay.status, 'HOLD');
      if (stay.holdFlag === hold) throw DomainError.invalidTransition('VehicleStay', hold ? 'ON_HOLD' : 'NO_HOLD', hold ? 'ON_HOLD' : 'NO_HOLD');
      await this.update(tx, stay, { holdFlag: hold, holdReason: hold ? reason : null }, expectedVersion);
      await this.audit.record(tx, { siteId, action: hold ? 'VEHICLE_HOLD_SET' : 'VEHICLE_HOLD_RELEASED', entityType: 'VehicleStay', entityId: stay.id, reason });
    });
    return this.get(siteId, id);
  }

  /** UC-05 bước 1. */
  async requestRelease(siteId: string, id: string, body: { reason: string; recipientName: string; plannedAt?: string }) {
    await this.tx.run(async (tx) => {
      const stay = await this.load(tx, siteId, id);
      await this.transition(tx, stay, 'RELEASE_REQUESTED');
      await tx.releaseRequest.create({ data: { siteId, vehicleStayId: stay.id, reason: body.reason, recipientName: body.recipientName, plannedAt: body.plannedAt ? new Date(body.plannedAt) : null, requestedById: requirePrincipal().userId } });
      await this.audit.record(tx, { siteId, action: 'VEHICLE_RELEASE_REQUESTED', entityType: 'VehicleStay', entityId: stay.id, reason: body.reason });
    });
    return this.get(siteId, id);
  }

  /** UC-05 bước 2–3: duyệt (chỉ Site Manager, maker-checker — DEC-19), chặn khi hold (BR-28), sinh task đưa xe ra release staging. */
  async decideRelease(siteId: string, requestId: string, approve: boolean, note: string | undefined, expectedVersion: number) {
    const principal = requirePrincipal();
    let stayId = '';
    await this.tx.run(async (tx) => {
      const req = await tx.releaseRequest.findFirst({ where: { id: requestId, siteId } });
      if (!req) throw DomainError.notFound('Release request');
      if (req.status !== 'PENDING') throw DomainError.invalidTransition('ReleaseRequest', req.status, approve ? 'APPROVED' : 'REJECTED');
      if (req.version !== expectedVersion) throw DomainError.concurrent();
      if (req.requestedById === principal.userId) throw new DomainError(403, ErrorCode.MAKER_CHECKER_VIOLATION, 'The requester cannot decide their own release request (DEC-19)');
      const stay = await this.load(tx, siteId, req.vehicleStayId);
      stayId = stay.id;
      if (approve) {
        const blockers = [];
        if (stay.holdFlag) blockers.push({ code: 'VEHICLE_ON_HOLD', message: `On hold: ${stay.holdReason}` });
        if (stay.conditionStatus === 'MAJOR_DAMAGE') blockers.push({ code: 'MAJOR_DAMAGE', message: 'Vehicle has unresolved major damage' });
        const moving = await tx.operationTask.findFirst({ where: { sourceType: 'VEHICLE_STAY', sourceId: stay.id, status: 'IN_PROGRESS' } });
        if (moving) blockers.push({ code: 'MOVE_IN_PROGRESS', message: `Vehicle is being moved (${moving.code})` });
        if (blockers.length) throw DomainError.blocked('RELEASE_BLOCKED', 'Release is blocked', blockers);
        // Lệnh di chuyển nội bộ chưa thực hiện bị thay bằng lệnh đưa ra release staging
        await this.tasks.cancelBySource(tx, 'VEHICLE_STAY', stay.id, 'Superseded by release');
        const releaseLoc = await tx.location.findFirst({ where: { siteId, code: { startsWith: 'REL' }, deletedAt: null, blockedAt: null } });
        if (!releaseLoc) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, 'No release staging location at this site');
        const current = (await this.occupancy.activeByOccupant('VEHICLE_STAY', stay.id, tx)).find((o) => o.kind === 'OCCUPIED');
        await this.locks.lockForUpdate(tx, [releaseLoc.id, ...(current ? [current.locationId] : [])]);
        await this.occupancy.reserve(tx, { siteId, locationId: releaseLoc.id, occupantType: 'VEHICLE_STAY', occupantId: stay.id });
        await this.createMoveTask(tx, stay, current?.locationId ?? null, releaseLoc.id, 'RELEASE');
      } else {
        await this.transition(tx, stay, 'STORED');
      }
      await tx.releaseRequest.update({ where: { id: req.id }, data: { status: approve ? 'APPROVED' : 'REJECTED', decidedById: principal.userId, decidedAt: new Date(), decisionNote: note ?? null, version: { increment: 1 } } });
      await this.audit.record(tx, { siteId, action: approve ? 'VEHICLE_RELEASE_APPROVED' : 'VEHICLE_RELEASE_REJECTED', entityType: 'VehicleStay', entityId: stay.id, reason: note ?? null });
      await this.emit(tx, stay.id, 'vehicle.status_changed');
    });
    return this.get(siteId, stayId);
  }

  /** UC-05 bước 4: bàn giao tại release staging → RELEASED. */
  async handover(siteId: string, id: string, expectedVersion: number) {
    await this.tx.run(async (tx) => {
      const stay = await this.load(tx, siteId, id);
      const req = await tx.releaseRequest.findFirst({ where: { vehicleStayId: stay.id, status: 'APPROVED' } });
      if (!req) throw DomainError.blocked('RELEASE_BLOCKED', 'Release request is not approved', [{ code: 'NOT_APPROVED', message: 'Approval required (BR-28)' }]);
      const occ = (await this.occupancy.activeByOccupant('VEHICLE_STAY', stay.id, tx)).find((o) => o.kind === 'OCCUPIED');
      const loc = occ ? await tx.location.findUnique({ where: { id: occ.locationId } }) : null;
      if (!loc?.code.startsWith('REL')) throw DomainError.blocked('RELEASE_BLOCKED', 'Vehicle is not at the release staging area yet', [{ code: 'NOT_AT_RELEASE_STAGING', message: `Vehicle is at ${loc?.code ?? 'unknown'}` }]);
      await this.transition(tx, stay, 'RELEASED', { releasedAt: new Date() }, expectedVersion);
      await tx.releaseRequest.update({ where: { id: req.id }, data: { status: 'COMPLETED', version: { increment: 1 } } });
      await this.audit.record(tx, { siteId, action: 'VEHICLE_RELEASED', entityType: 'VehicleStay', entityId: stay.id });
    });
    return this.get(siteId, id);
  }

  async gateOut(siteId: string, id: string, expectedVersion: number) {
    await this.tx.run(async (tx) => {
      const stay = await this.load(tx, siteId, id);
      const released = await this.occupancy.releaseAllFor(tx, 'VEHICLE_STAY', stay.id);
      await this.transition(tx, stay, 'EXITED', { exitedAt: new Date() }, expectedVersion);
      await tx.gateEvent.create({ data: { siteId, eventType: 'VEHICLE_OUT', vehicleStayId: stay.id, actorId: requirePrincipal().userId } });
      await this.movements.record(tx, { siteId, subjectType: 'VEHICLE_STAY', subjectId: stay.id, fromLocationId: released[0] ?? null, toLocationId: null, positionSource: 'CONFIRMED_MANUAL', reason: 'Exited site' });
      await this.audit.record(tx, { siteId, action: 'VEHICLE_EXITED', entityType: 'VehicleStay', entityId: stay.id });
      for (const l of released) await this.sites.emitLocationStatus(tx, siteId, l);
      await this.emit(tx, stay.id, 'vehicle.location_changed');
    });
    return this.get(siteId, id);
  }

  async cancel(siteId: string, id: string, reason: string, expectedVersion: number) {
    await this.tx.run(async (tx) => {
      const stay = await this.load(tx, siteId, id);
      await this.transition(tx, stay, 'CANCELLED', {}, expectedVersion);
      await this.audit.record(tx, { siteId, action: 'VEHICLE_STAY_CANCELLED', entityType: 'VehicleStay', entityId: stay.id, reason });
    });
    return this.get(siteId, id);
  }

  // ───────────── Internals ─────────────

  /** Xe tới đích: chiếm chỗ đã giữ (hoặc chiếm trực tiếp), giải phóng chỗ cũ, ALLOCATED → STORED. */
  private async arrive(tx: Tx, siteId: string, stayId: string, destinationId: string, source: 'CONFIRMED_SCAN' | 'CONFIRMED_MANUAL' | 'SENSOR_OBSERVED' | 'INFERRED', taskId: string | null) {
    const stay = await this.load(tx, siteId, stayId);
    const active = await this.occupancy.activeByOccupant('VEHICLE_STAY', stay.id, tx);
    const reserved = active.find((o) => o.kind === 'RESERVED' && o.locationId === destinationId);
    if (!reserved) throw DomainError.rule('SLOT_MISMATCH', 'Destination was not reserved for this vehicle');
    const old = active.find((o) => o.kind === 'OCCUPIED');
    await this.locks.lockForUpdate(tx, [destinationId, ...(old ? [old.locationId] : [])]);
    if (old) await this.occupancy.release(tx, old.id);
    await this.occupancy.occupy(tx, reserved.id, source);
    await this.movements.record(tx, { siteId, subjectType: 'VEHICLE_STAY', subjectId: stay.id, fromLocationId: old?.locationId ?? null, toLocationId: destinationId, positionSource: source, reason: stay.status === 'ALLOCATED' ? 'Parked' : 'Moved', taskId });
    if (stay.status === 'ALLOCATED') await this.transition(tx, stay, 'STORED', { storedAt: new Date() });
    await this.audit.record(tx, { siteId, action: stay.status === 'ALLOCATED' ? 'VEHICLE_STORED' : 'VEHICLE_MOVED', entityType: 'VehicleStay', entityId: stay.id });
    await this.emit(tx, stay.id, 'vehicle.location_changed');
    await this.sites.emitLocationStatus(tx, siteId, destinationId);
    if (old) await this.sites.emitLocationStatus(tx, siteId, old.locationId);
  }

  private async createMoveTask(tx: Tx, stay: VehicleStay & { vehicle: { vin: string; make: string | null; model: string | null } }, from: string | null, to: string, reason: string) {
    await this.tasks.create(tx, {
      siteId: stay.siteId,
      taskType: 'MOVE_VEHICLE',
      subjectType: 'VEHICLE_STAY',
      subjectId: stay.id,
      fromLocationId: from,
      toLocationId: to,
      sourceType: 'VEHICLE_STAY',
      sourceId: stay.id,
      payload: { subjectCode: stay.vehicle.vin, subjectLabel: [stay.vehicle.make, stay.vehicle.model].filter(Boolean).join(' ') || null, sourceCode: reason },
    });
  }

  private async load(tx: Tx, siteId: string, id: string) {
    const s = await tx.vehicleStay.findFirst({ where: { id, siteId }, include: { vehicle: true } });
    if (!s) throw DomainError.notFound('Vehicle stay');
    return s;
  }

  private async transition(tx: Tx, s: VehicleStay, to: VehicleStayStatus, data: Prisma.VehicleStayUncheckedUpdateManyInput = {}, expectedVersion?: number) {
    if (!TRANSITIONS[s.status].includes(to)) throw DomainError.invalidTransition('VehicleStay', s.status, to);
    const res = await tx.vehicleStay.updateMany({ where: { id: s.id, status: s.status, version: expectedVersion ?? s.version }, data: { ...data, status: to, version: { increment: 1 } } });
    if (res.count === 0) throw DomainError.concurrent();
    await this.emit(tx, s.id, 'vehicle.status_changed', s.status);
  }

  private async update(tx: Tx, s: VehicleStay, data: Prisma.VehicleStayUncheckedUpdateManyInput, expectedVersion: number) {
    const res = await tx.vehicleStay.updateMany({ where: { id: s.id, version: expectedVersion }, data: { ...data, version: { increment: 1 } } });
    if (res.count === 0) throw DomainError.concurrent();
    await this.emit(tx, s.id, 'vehicle.status_changed', s.status);
  }

  private snapshot(s: VehicleStay & { vehicle: { vin: string; make: string | null; model: string | null } }, occ: { locationId: string; positionSource: string | null; occupiedAt: Date | null; startedAt: Date } | null): SnapshotVehicle {
    return {
      stayId: s.id,
      vin: s.vehicle.vin,
      label: [s.vehicle.make, s.vehicle.model].filter(Boolean).join(' '),
      status: s.status,
      condition: s.conditionStatus,
      hold: s.holdFlag,
      position: occ ? { locationId: occ.locationId, source: (occ.positionSource ?? 'CONFIRMED_MANUAL') as NonNullable<SnapshotVehicle['position']>['source'], confirmedAt: (occ.occupiedAt ?? occ.startedAt).toISOString() } : null,
      version: s.version,
    };
  }

  private async emit(tx: Tx, stayId: string, type: 'vehicle.status_changed' | 'vehicle.location_changed', fromStatus?: VehicleStayStatus) {
    const s = await tx.vehicleStay.findUniqueOrThrow({ where: { id: stayId }, include: { vehicle: true } });
    const occ = await tx.locationOccupancy.findFirst({ where: { occupantType: 'VEHICLE_STAY', occupantId: s.id, releasedAt: null, kind: 'OCCUPIED' } });
    await this.outbox.publish(tx, {
      siteId: s.siteId,
      type,
      aggregateType: 'VehicleStay',
      aggregateId: s.id,
      aggregateVersion: s.version,
      data: { vehicle: this.snapshot(s, occ), fromStatus: fromStatus ?? null },
    });
  }

  // ───────────── Queries ─────────────

  async list(siteId: string, filter: { status?: string; q?: string }): Promise<VehicleStayDto[]> {
    const stays = await this.prisma.vehicleStay.findMany({
      where: {
        siteId,
        ...(filter.status ? { status: { in: filter.status.split(',') as VehicleStayStatus[] } } : { status: { in: ACTIVE } }),
        ...(filter.q ? { OR: [{ vehicle: { vin: { contains: filter.q.toUpperCase() } } }, { vehicle: { plateNumber: { contains: filter.q, mode: 'insensitive' } } }, { vehicle: { model: { contains: filter.q, mode: 'insensitive' } } }] } : {}),
      },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      take: 500,
    });
    return this.toDtos(stays.map((s) => s.id));
  }

  async get(siteId: string, id: string): Promise<VehicleStayDto> {
    const s = await this.prisma.vehicleStay.findFirst({ where: { id, siteId } });
    if (!s) throw DomainError.notFound('Vehicle stay');
    return (await this.toDtos([s.id]))[0];
  }

  private async toDtos(ids: string[]): Promise<VehicleStayDto[]> {
    const stays = await this.prisma.vehicleStay.findMany({ where: { id: { in: ids } }, include: { vehicle: true, releaseRequests: { where: { status: { in: ['PENDING', 'APPROVED'] } } } } });
    const occ = await this.prisma.locationOccupancy.findMany({ where: { occupantType: 'VEHICLE_STAY', occupantId: { in: ids }, releasedAt: null } });
    const locs = new Map((await this.prisma.location.findMany({ where: { id: { in: occ.map((o) => o.locationId) } } })).map((l) => [l.id, l]));
    const owners = new Map((await this.prisma.partner.findMany({ where: { id: { in: stays.map((s) => s.vehicle.ownerPartnerId).filter((x): x is string => !!x) } } })).map((p) => [p.id, p.name]));
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: stays.flatMap((s) => s.releaseRequests.map((r) => r.requestedById)) } } })).map((u) => [u.id, u.fullName]));
    const tasks = await this.prisma.operationTask.findMany({ where: { sourceType: 'VEHICLE_STAY', sourceId: { in: ids }, status: { in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED'] } } });
    const order = new Map(ids.map((id, i) => [id, i]));
    return stays
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      .map((s) => {
        const mine = occ.filter((o) => o.occupantId === s.id);
        const o = mine.find((x) => x.kind === 'OCCUPIED') ?? mine[0];
        const loc = o ? locs.get(o.locationId) : undefined;
        const req = s.releaseRequests[0];
        const task = tasks.find((t) => t.sourceId === s.id);
        const iso = (d: Date | null) => d?.toISOString() ?? null;
        return {
          id: s.id,
          siteId: s.siteId,
          vehicle: { id: s.vehicle.id, vin: s.vehicle.vin, make: s.vehicle.make, model: s.vehicle.model, modelYear: s.vehicle.modelYear, color: s.vehicle.color, plateNumber: s.vehicle.plateNumber },
          owner: s.vehicle.ownerPartnerId ? { id: s.vehicle.ownerPartnerId, name: owners.get(s.vehicle.ownerPartnerId) ?? '' } : null,
          status: s.status,
          conditionStatus: s.conditionStatus,
          holdFlag: s.holdFlag,
          holdReason: s.holdReason,
          odometerKm: s.odometerKm,
          fuelOrBatteryPct: s.fuelOrBatteryPct,
          keyTag: s.keyTag,
          position: { location: loc ? { id: loc.id, code: loc.code, type: loc.locationType } : null, kind: o?.kind ?? null, source: o?.positionSource ?? null, confirmedAt: o ? (o.occupiedAt ?? o.startedAt).toISOString() : null },
          releaseRequest: req ? { id: req.id, status: req.status, reason: req.reason, recipientName: req.recipientName, requestedBy: users.get(req.requestedById) ?? '', version: req.version } : null,
          expectedAt: iso(s.expectedAt),
          receivedAt: iso(s.receivedAt),
          storedAt: iso(s.storedAt),
          releasedAt: iso(s.releasedAt),
          exitedAt: iso(s.exitedAt),
          openTask: task ? { id: task.id, code: task.code, status: task.status, toCode: task.toLocationId ? (locs.get(task.toLocationId)?.code ?? null) : null } : null,
          version: s.version,
        };
      });
  }

  /** Lịch sử theo VIN qua mọi lượt lưu, lọc theo site được phép (AC-08). */
  async history(vin: string, allowedSiteIds: string[]): Promise<VehicleHistoryEntry[]> {
    const vehicle = await this.prisma.storedVehicle.findUnique({ where: { vin: vin.toUpperCase() } });
    if (!vehicle) throw DomainError.notFound('Vehicle');
    const stays = await this.prisma.vehicleStay.findMany({ where: { vehicleId: vehicle.id, siteId: { in: allowedSiteIds } } });
    const audit = await this.prisma.auditLog.findMany({ where: { entityType: 'VehicleStay', entityId: { in: stays.map((s) => s.id) } }, orderBy: { occurredAt: 'desc' } });
    const moves = await this.prisma.movementRecord.findMany({ where: { subjectType: 'VEHICLE_STAY', subjectId: { in: stays.map((s) => s.id) } } });
    const locs = new Map((await this.prisma.location.findMany({ where: { id: { in: moves.flatMap((m) => [m.fromLocationId, m.toLocationId]).filter((x): x is string => !!x) } } })).map((l) => [l.id, l.code]));
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: [...audit.map((a) => a.actorId), ...moves.map((m) => m.actorId)].filter((x): x is string => !!x) } } })).map((u) => [u.id, u.fullName]));
    const sites = new Map((await this.prisma.site.findMany({ where: { id: { in: stays.map((s) => s.siteId) } } })).map((s) => [s.id, s.code]));
    const siteOf = new Map(stays.map((s) => [s.id, sites.get(s.siteId) ?? null]));
    return [
      ...audit.map((a) => ({ at: a.occurredAt.toISOString(), action: a.action, detail: a.reason, actor: a.actorId ? (users.get(a.actorId) ?? null) : 'System', site: siteOf.get(a.entityId) ?? null })),
      ...moves.map((m) => ({
        at: m.occurredAt.toISOString(),
        action: 'MOVEMENT',
        detail: [m.fromLocationId ? locs.get(m.fromLocationId) : null, m.toLocationId ? locs.get(m.toLocationId) : 'exit'].filter(Boolean).join(' → '),
        actor: m.actorId ? (users.get(m.actorId) ?? null) : 'System',
        site: siteOf.get(m.subjectId) ?? null,
      })),
    ].sort((a, b) => b.at.localeCompare(a.at));
  }
}
