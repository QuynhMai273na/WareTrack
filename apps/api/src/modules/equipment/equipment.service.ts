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
      const equipment = await tx.equipment.findFirst({ where: { id, siteId, deletedAt: null } });
      if (!equipment) throw DomainError.notFound('Equipment');
      if (equipment.version !== expectedVersion) throw DomainError.concurrent();
      if (!MANUAL[equipment.status]?.includes(to)) throw DomainError.invalidTransition('Equipment', equipment.status, to);
      if (to === 'MAINTENANCE' && (equipment.status === 'ASSIGNED' || equipment.status === 'BUSY')) {
        for (const hook of this.maintenanceHooks) await hook(tx, equipment, reason ?? 'Equipment breakdown');
      }
      const fresh = await tx.equipment.findUniqueOrThrow({ where: { id } });
      const updated = await this.setStatus(tx, siteId, id, to, { taskSummary: to === 'AVAILABLE' ? null : (reason ?? null), allowedFrom: [fresh.status], reason });
      await this.audit.record(tx, { siteId, action: `EQUIPMENT_${to}`, entityType: 'Equipment', entityId: id, diff: { before: { status: equipment.status }, after: { status: to } }, reason: reason ?? null });
      return updated;
    });
  }

  /** #159 — nhập telemetry thủ công (DEC-55: chưa có cảm biến). Pin xuống dưới ngưỡng → cảnh báo (FR-18.02). */
  async recordTelemetry(siteId: string, id: string, body: { batteryPct?: number; speedKmh?: number; observedAt?: string }) {
    return this.tx.run(async (tx) => {
      const equipment = await tx.equipment.findFirst({ where: { id, siteId, deletedAt: null } });
      if (!equipment) throw DomainError.notFound('Equipment');
      const telemetry = (equipment.telemetry as EquipmentTelemetry | null) ?? {};
      const next: EquipmentTelemetry = { ...telemetry, ...(body.batteryPct !== undefined ? { batteryPct: body.batteryPct } : {}), ...(body.speedKmh !== undefined ? { speedKmh: body.speedKmh } : {}) };
      const updated = await tx.equipment.update({
        where: { id },
        data: { telemetry: next as object, telemetryAt: body.observedAt ? new Date(body.observedAt) : new Date(), telemetrySource: 'CONFIRMED_MANUAL', version: { increment: 1 } },
      });
      const lowBattery = next.batteryPct !== undefined && next.batteryPct < LOW_BATTERY_PCT && (telemetry.batteryPct ?? 100) >= LOW_BATTERY_PCT;
      await this.publish(tx, updated, equipment.status, { lowBattery });
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
    const clean = ids.filter((id): id is string => !!id);
    return clean.length ? this.prisma.user.findMany({ where: { id: { in: clean } }, select: { id: true, fullName: true } }) : [];
  }

  async get(siteId: string, id: string): Promise<Equipment> {
    const equipment = await this.prisma.equipment.findFirst({ where: { id, siteId, deletedAt: null } });
    if (!equipment) throw DomainError.notFound('Equipment');
    return equipment;
  }

  /**
   * EquipmentCommandPort (mục 13.2): đổi trạng thái theo task trong transaction của Operations,
   * phát forklift.status_changed với snapshot để client patch cache.
   */
  async setStatus(tx: Tx, siteId: string, id: string, to: EquipmentStatus, opts: { taskSummary?: string | null; incrementMoves?: boolean; allowedFrom?: EquipmentStatus[]; reason?: string } = {}) {
    const equipment = await tx.equipment.findFirst({ where: { id, siteId, deletedAt: null } });
    if (!equipment) throw DomainError.notFound('Equipment');
    if (opts.allowedFrom && !opts.allowedFrom.includes(equipment.status)) {
      throw DomainError.rule(ErrorCode.EQUIPMENT_UNAVAILABLE, `${equipment.code} is ${equipment.status}`, { status: equipment.status });
    }
    const telemetry = (equipment.telemetry as EquipmentTelemetry | null) ?? {};
    const updated = await tx.equipment.update({
      where: { id },
      data: {
        status: to,
        version: { increment: 1 },
        ...(opts.taskSummary !== undefined ? { taskSummary: opts.taskSummary } : {}),
        ...(opts.incrementMoves ? { telemetry: { ...telemetry, movesToday: (telemetry.movesToday ?? 0) + 1 } } : {}),
      },
    });
    await this.publish(tx, updated, equipment.status, { reason: opts.reason ?? null });
    return updated;
  }

  private async publish(tx: Tx, equipment: Equipment, fromStatus: EquipmentStatus, extra: Record<string, unknown> = {}) {
    await this.outbox.publish(tx, {
      siteId: equipment.siteId,
      type: 'forklift.status_changed',
      aggregateType: 'Equipment',
      aggregateId: equipment.id,
      aggregateVersion: equipment.version,
      data: { forklift: this.toSnapshot(equipment), fromStatus, ...extra },
    });
  }

  /** Vị trí forklift: không có cảm biến (DEC-55) → INFERRED tại charger (mục 18.3). */
  toSnapshot(equipment: Equipment): SnapshotForklift {
    const telemetry = (equipment.telemetry as EquipmentTelemetry | null) ?? {};
    return {
      id: equipment.id,
      code: equipment.code,
      equipmentType: equipment.equipmentType,
      model: equipment.model,
      status: equipment.status,
      taskSummary: equipment.taskSummary,
      position: equipment.chargerLocationId
        ? { locationId: equipment.chargerLocationId, source: 'INFERRED', confirmedAt: (equipment.telemetryAt ?? equipment.updatedAt).toISOString() }
        : null,
      batteryPct: telemetry.batteryPct ?? null,
      telemetryAt: equipment.telemetryAt?.toISOString() ?? null,
      version: equipment.version,
    };
  }
}
