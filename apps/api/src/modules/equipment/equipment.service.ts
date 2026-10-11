import { Injectable } from '@nestjs/common';
import type { Equipment, EquipmentStatus } from '@prisma/client';
import { type CreateEquipmentRequest, ErrorCode, type SnapshotForklift, type UpdateEquipmentRequest } from '@waretrack/shared-schemas';
import { AuditService } from '../../platform/audit/audit.service';
import { DomainError } from '../../platform/errors/domain-error';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { PrismaService, type Tx, TxRunner } from '../../platform/prisma/prisma.service';

/** Chuyển trạng thái thủ công (mục 9.7). ASSIGNED/BUSY ↔ AVAILABLE chỉ do task điều khiển. */
const MANUAL: Partial<Record<EquipmentStatus, EquipmentStatus[]>> = {
  AVAILABLE: ['CHARGING', 'OFFLINE', 'MAINTENANCE'],
  CHARGING: ['AVAILABLE', 'MAINTENANCE'],
  OFFLINE: ['AVAILABLE', 'MAINTENANCE'],
  ASSIGNED: ['MAINTENANCE'],
  BUSY: ['MAINTENANCE'],
  MAINTENANCE: ['AVAILABLE'],
};
export const LOW_BATTERY_PCT = 20;

/** Hook do Operations đăng ký: xe nâng hỏng giữa chừng → trả task về hàng đợi (IoC, tránh phụ thuộc vòng). */
export type MaintenanceHook = (tx: Tx, equipment: Equipment, reason: string) => Promise<void>;

export interface EquipmentTelemetry {
  batteryPct?: number;
  speedKmh?: number;
  movesToday?: number;
}

/** Equipment (mục 13.2, state machine 9.7). */
@Injectable()
export class EquipmentService {
  private maintenanceHooks: MaintenanceHook[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TxRunner,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  registerMaintenanceHook(hook: MaintenanceHook) {
    this.maintenanceHooks.push(hook);
  }

  /** #158 — sạc / bảo trì / offline / sẵn sàng. */
  async changeStatus(siteId: string, id: string, to: EquipmentStatus, reason: string | undefined, expectedVersion: number) {
    return this.tx.run(async (tx) => {
      const e = await tx.equipment.findFirst({ where: { id, siteId, deletedAt: null } });
      if (!e) throw DomainError.notFound('Equipment');
      if (e.version !== expectedVersion) throw DomainError.concurrent();
      if (!MANUAL[e.status]?.includes(to)) throw DomainError.invalidTransition('Equipment', e.status, to);
      if (to === 'MAINTENANCE' && (e.status === 'ASSIGNED' || e.status === 'BUSY')) {
        for (const hook of this.maintenanceHooks) await hook(tx, e, reason ?? 'Equipment breakdown');
      }
      const fresh = await tx.equipment.findUniqueOrThrow({ where: { id } });
      const updated = await this.setStatus(tx, siteId, id, to, { taskSummary: to === 'AVAILABLE' ? null : (reason ?? null), allowedFrom: [fresh.status], reason });
      await this.audit.record(tx, { siteId, action: `EQUIPMENT_${to}`, entityType: 'Equipment', entityId: id, diff: { before: { status: e.status }, after: { status: to } }, reason: reason ?? null });
      return updated;
    });
  }

  /** #159 — nhập telemetry thủ công (DEC-55: chưa có cảm biến). Pin xuống dưới ngưỡng → cảnh báo (FR-18.02). */
  async recordTelemetry(siteId: string, id: string, body: { batteryPct?: number; speedKmh?: number; observedAt?: string }) {
    return this.tx.run(async (tx) => {
      const e = await tx.equipment.findFirst({ where: { id, siteId, deletedAt: null } });
      if (!e) throw DomainError.notFound('Equipment');
      const t = (e.telemetry as EquipmentTelemetry | null) ?? {};
      const next: EquipmentTelemetry = { ...t, ...(body.batteryPct !== undefined ? { batteryPct: body.batteryPct } : {}), ...(body.speedKmh !== undefined ? { speedKmh: body.speedKmh } : {}) };
      const updated = await tx.equipment.update({
        where: { id },
        data: { telemetry: next as object, telemetryAt: body.observedAt ? new Date(body.observedAt) : new Date(), telemetrySource: 'CONFIRMED_MANUAL', version: { increment: 1 } },
      });
      const lowBattery = next.batteryPct !== undefined && next.batteryPct < LOW_BATTERY_PCT && (t.batteryPct ?? 100) >= LOW_BATTERY_PCT;
      await this.publish(tx, updated, e.status, { lowBattery });
      return updated;
    });
  }

  /** Đăng ký xe nâng mới cho site (vận hành thật) — trạng thái ban đầu OFFLINE tới khi người lái nhận xe. */
  async create(siteId: string, body: CreateEquipmentRequest) {
    return this.tx.run(async (tx) => {
      if (await tx.equipment.findFirst({ where: { siteId, code: body.code, deletedAt: null } })) throw DomainError.rule(ErrorCode.CODE_ALREADY_EXISTS, `Equipment ${body.code} already exists at this site`);
      await this.assertChargerAndOperator(tx, siteId, body.chargerLocationId ?? null, body.operatorUserId ?? null);
      const created = await tx.equipment.create({
        data: {
          siteId,
          code: body.code,
          equipmentType: body.equipmentType,
          model: body.model ?? null,
          status: 'OFFLINE',
          chargerLocationId: body.chargerLocationId ?? null,
          currentOperatorId: body.operatorUserId ?? null,
          telemetry: { batteryPct: 100, speedKmh: 0, movesToday: 0 },
          telemetryAt: new Date(),
          telemetrySource: 'CONFIRMED_MANUAL',
        },
      });
      await this.audit.record(tx, { siteId, action: 'EQUIPMENT_CREATED', entityType: 'Equipment', entityId: created.id, diff: { after: { code: created.code, model: created.model } } });
      await this.publish(tx, created, created.status, {});
      return created;
    });
  }

  async update(siteId: string, equipmentId: string, body: UpdateEquipmentRequest) {
    return this.tx.run(async (tx) => {
      const before = await tx.equipment.findFirst({ where: { id: equipmentId, siteId, deletedAt: null } });
      if (!before) throw DomainError.notFound('Equipment');
      await this.assertChargerAndOperator(tx, siteId, body.chargerLocationId ?? null, body.operatorUserId ?? null);
      const updated = await tx.equipment.update({
        where: { id: equipmentId },
        data: {
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.chargerLocationId !== undefined ? { chargerLocationId: body.chargerLocationId } : {}),
          ...(body.operatorUserId !== undefined ? { currentOperatorId: body.operatorUserId } : {}),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        siteId,
        action: 'EQUIPMENT_UPDATED',
        entityType: 'Equipment',
        entityId: equipmentId,
        diff: { before: { model: before.model, operator: before.currentOperatorId, charger: before.chargerLocationId }, after: { model: updated.model, operator: updated.currentOperatorId, charger: updated.chargerLocationId } },
      });
      await this.publish(tx, updated, before.status, {});
      return updated;
    });
  }

  /** Trạm sạc phải là location CHARGER của site; người lái phải có quyền tại site (vai trò bất kỳ). */
  private async assertChargerAndOperator(tx: Tx, siteId: string, chargerLocationId: string | null, operatorUserId: string | null) {
    if (chargerLocationId) {
      const charger = await tx.location.findFirst({ where: { id: chargerLocationId, siteId, deletedAt: null } });
      if (!charger || charger.locationType !== 'CHARGER') throw DomainError.rule(ErrorCode.VALIDATION_ERROR, 'Charger must be a charging bay of this site');
    }
    if (operatorUserId) {
      const assignment = await tx.userSiteRole.findFirst({ where: { userId: operatorUserId, revokedAt: null, OR: [{ siteId }, { siteId: null }] } });
      if (!assignment) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, 'Operator has no role at this site');
    }
  }

  async list(siteId: string): Promise<Equipment[]> {
    return this.prisma.equipment.findMany({ where: { siteId, deletedAt: null }, orderBy: { code: 'asc' } });
  }

  async operators(ids: Array<string | null>) {
    const clean = ids.filter((x): x is string => !!x);
    return clean.length ? this.prisma.user.findMany({ where: { id: { in: clean } }, select: { id: true, fullName: true } }) : [];
  }

  async get(siteId: string, id: string): Promise<Equipment> {
    const e = await this.prisma.equipment.findFirst({ where: { id, siteId, deletedAt: null } });
    if (!e) throw DomainError.notFound('Equipment');
    return e;
  }

  /**
   * EquipmentCommandPort (mục 13.2): đổi trạng thái theo task trong transaction của Operations,
   * phát forklift.status_changed với snapshot để client patch cache.
   */
  async setStatus(tx: Tx, siteId: string, id: string, to: EquipmentStatus, opts: { taskSummary?: string | null; incrementMoves?: boolean; allowedFrom?: EquipmentStatus[]; reason?: string } = {}) {
    const e = await tx.equipment.findFirst({ where: { id, siteId, deletedAt: null } });
    if (!e) throw DomainError.notFound('Equipment');
    if (opts.allowedFrom && !opts.allowedFrom.includes(e.status)) {
      throw DomainError.rule(ErrorCode.EQUIPMENT_UNAVAILABLE, `${e.code} is ${e.status}`, { status: e.status });
    }
    const t = (e.telemetry as EquipmentTelemetry | null) ?? {};
    const updated = await tx.equipment.update({
      where: { id },
      data: {
        status: to,
        version: { increment: 1 },
        ...(opts.taskSummary !== undefined ? { taskSummary: opts.taskSummary } : {}),
        ...(opts.incrementMoves ? { telemetry: { ...t, movesToday: (t.movesToday ?? 0) + 1 } } : {}),
      },
    });
    await this.publish(tx, updated, e.status, { reason: opts.reason ?? null });
    return updated;
  }

  private async publish(tx: Tx, e: Equipment, fromStatus: EquipmentStatus, extra: Record<string, unknown> = {}) {
    await this.outbox.publish(tx, {
      siteId: e.siteId,
      type: 'forklift.status_changed',
      aggregateType: 'Equipment',
      aggregateId: e.id,
      aggregateVersion: e.version,
      data: { forklift: this.toSnapshot(e), fromStatus, ...extra },
    });
  }

  /** Vị trí forklift: không có cảm biến (DEC-55) → INFERRED tại charger (mục 18.3). */
  toSnapshot(e: Equipment): SnapshotForklift {
    const t = (e.telemetry as EquipmentTelemetry | null) ?? {};
    return {
      id: e.id,
      code: e.code,
      equipmentType: e.equipmentType,
      model: e.model,
      status: e.status,
      taskSummary: e.taskSummary,
      position: e.chargerLocationId
        ? { locationId: e.chargerLocationId, source: 'INFERRED', confirmedAt: (e.telemetryAt ?? e.updatedAt).toISOString() }
        : null,
      batteryPct: t.batteryPct ?? null,
      telemetryAt: e.telemetryAt?.toISOString() ?? null,
      version: e.version,
    };
  }
}
