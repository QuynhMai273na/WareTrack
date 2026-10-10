import { Injectable, OnModuleInit } from '@nestjs/common';
import type { OperationTask, PositionSource, Prisma, TaskStatus, TaskType } from '@prisma/client';
import { ErrorCode, type TaskDto } from '@waretrack/shared-schemas';
import { AuditService } from '../../platform/audit/audit.service';
import { requirePrincipal } from '../../platform/auth/decorators';
import { CodeGenerator } from '../../platform/codes/code-generator';
import { DomainError } from '../../platform/errors/domain-error';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { PrismaService, type Tx, TxRunner } from '../../platform/prisma/prisma.service';
import { EquipmentService } from '../equipment/equipment.service';
import { AccessService } from '../identity/access.service';
import { SitesService } from '../sites/sites.service';

export interface TaskSpec {
  siteId: string;
  taskType: TaskType;
  subjectType: 'HANDLING_UNIT' | 'VEHICLE_STAY';
  subjectId: string;
  fromLocationId?: string | null;
  toLocationId?: string | null;
  sourceType: string;
  sourceId: string;
  priority?: number;
  payload?: Record<string, unknown>;
}

export interface TaskCompletionContext {
  destinationLocationId: string;
  source: PositionSource;
  overrideReason?: string;
}

/** Handler nghiệp vụ do module nguồn đăng ký cho từng loại task (inversion of control — mục 13.2 Operations). */
export interface TaskHandler {
  complete(tx: Tx, task: OperationTask, ctx: TaskCompletionContext): Promise<void>;
  cancel?(tx: Tx, task: OperationTask): Promise<void>;
  /** Cho phép đích khác đích gợi ý (UC-10 A1). Mặc định: phải đúng đích. */
  allowAlternativeDestination?: boolean;
}

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  PENDING: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['PENDING', 'IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'],
  BLOCKED: ['ASSIGNED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

const matches = (scan: string, loc: { code: string; qrValue: string }) => scan.trim() === loc.qrValue || scan.trim().toUpperCase() === loc.code.toUpperCase();

/** Operation task (mục 9.8, UC-18): giao việc không xung đột (BR-27), xác nhận nguồn/đích bằng quét. */
@Injectable()
export class TasksService implements OnModuleInit {
  private readonly handlers = new Map<TaskType, TaskHandler>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TxRunner,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly codes: CodeGenerator,
    private readonly equipment: EquipmentService,
    private readonly sites: SitesService,
    private readonly access: AccessService,
  ) {}

  onModuleInit() {
    // Xe nâng vào bảo trì giữa chừng (mục 9.7): task ASSIGNED về hàng đợi, task đang chạy → BLOCKED để giao lại
    this.equipment.registerMaintenanceHook(async (tx, eq, reason) => {
      const tasks = await tx.operationTask.findMany({ where: { equipmentId: eq.id, status: { in: ['ASSIGNED', 'IN_PROGRESS'] } } });
      for (const t of tasks) {
        const to = t.status === 'ASSIGNED' ? 'PENDING' : 'BLOCKED';
        await this.transition(tx, t, t.version, to, { equipmentId: null, ...(to === 'PENDING' ? { assigneeId: null } : {}), blockReason: `${eq.code}: ${reason}` });
      }
    });
  }

  registerHandler(type: TaskType, handler: TaskHandler) {
    this.handlers.set(type, handler);
  }

  async create(tx: Tx, spec: TaskSpec): Promise<OperationTask> {
    const task = await tx.operationTask.create({
      data: {
        siteId: spec.siteId,
        code: await this.codes.prefixed(tx, 'TSK', 5),
        taskType: spec.taskType,
        priority: spec.priority ?? 3,
        subjectType: spec.subjectType,
        subjectId: spec.subjectId,
        fromLocationId: spec.fromLocationId ?? null,
        toLocationId: spec.toLocationId ?? null,
        sourceType: spec.sourceType,
        sourceId: spec.sourceId,
        payload: (spec.payload ?? {}) as Prisma.InputJsonValue,
      },
    });
    await tx.taskEvent.create({ data: { taskId: task.id, toStatus: 'PENDING', actorId: requirePrincipalOrNull() } });
    await this.emit(tx, task);
    return task;
  }

  /** Hủy mọi task chưa xong của một nguồn nghiệp vụ (ví dụ đơn xuất bị hủy). */
  async cancelBySource(tx: Tx, sourceType: string, sourceId: string, reason: string) {
    const open = await tx.operationTask.findMany({ where: { sourceType, sourceId, status: { in: ['PENDING', 'ASSIGNED', 'BLOCKED', 'IN_PROGRESS'] } } });
    for (const t of open) await this.doCancel(tx, t, reason);
  }

  async assign(siteId: string, taskId: string, body: { assigneeId: string; equipmentId?: string; expectedVersion: number }) {
    const principal = requirePrincipal();
    return this.tx.run(async (tx) => {
      const t = await this.load(tx, siteId, taskId);
      const supervisorRoles = ['SITE_MANAGER', 'YARD_DISPATCHER', 'WAREHOUSE_SUPERVISOR'];
      if (!principal.roles.some((r) => supervisorRoles.includes(r))) {
        // DEC-33: operator chỉ tự nhận task khi site bật selfAssign
        const settings = await this.sites.settings(siteId, tx);
        if (body.assigneeId !== principal.userId || !settings.selfAssign) throw DomainError.forbidden('Self-assignment is disabled for this site (DEC-33)');
      }
      const assignee = await this.access.getUserAccess(body.assigneeId);
      if (!assignee || !(await this.access.permissionsAt(assignee, siteId)).has('task.execute')) {
        throw DomainError.rule(ErrorCode.VALIDATION_ERROR, 'Assignee cannot execute tasks at this site');
      }
      if (t.equipmentId && t.equipmentId !== body.equipmentId) await this.equipment.setStatus(tx, siteId, t.equipmentId, 'AVAILABLE', { taskSummary: null });
      if (body.equipmentId && body.equipmentId !== t.equipmentId) {
        await this.equipment.setStatus(tx, siteId, body.equipmentId, 'ASSIGNED', { taskSummary: await this.summary(tx, t), allowedFrom: ['AVAILABLE'] });
      }
      await this.transition(tx, t, body.expectedVersion, 'ASSIGNED', { assigneeId: body.assigneeId, equipmentId: body.equipmentId ?? null });
    });
  }

  async start(siteId: string, taskId: string, expectedVersion: number) {
    const principal = requirePrincipal();
    return this.tx.run(async (tx) => {
      const t = await this.load(tx, siteId, taskId);
      if (t.assigneeId !== principal.userId) throw DomainError.forbidden('Only the assignee can start this task');
      const busy = await tx.operationTask.findFirst({ where: { assigneeId: principal.userId, status: 'IN_PROGRESS' } });
      if (busy) throw DomainError.conflict(ErrorCode.OPERATOR_BUSY, `You already have ${busy.code} in progress (BR-27)`);
      if (t.equipmentId) {
        const eqBusy = await tx.operationTask.findFirst({ where: { equipmentId: t.equipmentId, status: 'IN_PROGRESS' } });
        if (eqBusy) throw DomainError.conflict(ErrorCode.EQUIPMENT_BUSY, `Equipment is busy with ${eqBusy.code} (BR-27)`);
        await this.equipment.setStatus(tx, siteId, t.equipmentId, 'BUSY', { taskSummary: await this.summary(tx, t), allowedFrom: ['ASSIGNED', 'AVAILABLE'] });
      }
      await this.transition(tx, t, expectedVersion, 'IN_PROGRESS', { startedAt: new Date() });
    });
  }

  /** Xác nhận nguồn: quét location + đối tượng phải khớp vị trí hệ thống (UC-07/UC-10/UC-12). */
  async confirmSource(siteId: string, taskId: string, body: { locationScan: string; subjectScan: string }) {
    return this.tx.run(async (tx) => {
      const t = await this.load(tx, siteId, taskId);
      if (t.status !== 'IN_PROGRESS') throw DomainError.invalidTransition('OperationTask', t.status, 'IN_PROGRESS');
      if (t.fromLocationId) {
        const from = await tx.location.findUniqueOrThrow({ where: { id: t.fromLocationId } });
        if (!matches(body.locationScan, from)) throw DomainError.rule(ErrorCode.LOCATION_MISMATCH, `Scanned ${body.locationScan}, expected ${from.code}`);
      }
      const subjectCode = await this.subjectCode(tx, t);
      if (subjectCode && body.subjectScan.trim().toUpperCase() !== subjectCode.toUpperCase()) {
        throw DomainError.rule(ErrorCode.HU_MISMATCH, `Scanned ${body.subjectScan}, expected ${subjectCode}`);
      }
      const payload = { ...((t.payload as Record<string, unknown>) ?? {}), sourceConfirmedAt: new Date().toISOString() };
      await tx.operationTask.update({ where: { id: t.id }, data: { payload, version: { increment: 1 } } });
      await this.audit.record(tx, { siteId, action: 'TASK_SOURCE_CONFIRMED', entityType: 'OperationTask', entityId: t.id });
    });
  }

  /** Xác nhận đích → handler nghiệp vụ → COMPLETED trong cùng transaction (mục 13.2: "Complete task = 1 TX"). */
  async confirmDestination(siteId: string, taskId: string, body: { locationScan: string; overrideReason?: string }) {
    return this.tx.run(async (tx) => {
      const t = await this.load(tx, siteId, taskId);
      if (t.status !== 'IN_PROGRESS') throw DomainError.invalidTransition('OperationTask', t.status, 'COMPLETED');
      const handler = this.handlers.get(t.taskType);
      if (!handler) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, `No handler for ${t.taskType}`);
      const scanned = await tx.location.findFirst({ where: { siteId, deletedAt: null, OR: [{ qrValue: body.locationScan.trim() }, { code: { equals: body.locationScan.trim(), mode: 'insensitive' } }] } });
      if (!scanned) throw DomainError.rule(ErrorCode.LOCATION_MISMATCH, `Unknown location ${body.locationScan}`);
      if (t.toLocationId && scanned.id !== t.toLocationId && !handler.allowAlternativeDestination) {
        const expected = await tx.location.findUniqueOrThrow({ where: { id: t.toLocationId } });
        throw DomainError.rule(scanned.locationType === 'DOCK' ? ErrorCode.DOCK_MISMATCH : ErrorCode.LOCATION_MISMATCH, `Scanned ${scanned.code}, expected ${expected.code}`);
      }
      await this.completeInTx(tx, t, { destinationLocationId: scanned.id, source: 'CONFIRMED_SCAN', overrideReason: body.overrideReason });
    });
  }

  /** Handler nghiệp vụ + giải phóng thiết bị + COMPLETED trong transaction của caller. */
  async completeInTx(tx: Tx, t: OperationTask, ctx: TaskCompletionContext) {
    const handler = this.handlers.get(t.taskType);
    if (!handler) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, `No handler for ${t.taskType}`);
    await handler.complete(tx, t, ctx);
    if (t.equipmentId) await this.equipment.setStatus(tx, t.siteId, t.equipmentId, 'AVAILABLE', { taskSummary: null, incrementMoves: true });
    const fresh = await tx.operationTask.findUniqueOrThrow({ where: { id: t.id } });
    await this.transition(tx, fresh, fresh.version, 'COMPLETED', { completedAt: new Date(), toLocationId: ctx.destinationLocationId });
  }

  async cancelInTx(tx: Tx, t: OperationTask, reason: string) {
    await this.doCancel(tx, t, reason);
  }

  async block(siteId: string, taskId: string, reason: string) {
    return this.tx.run(async (tx) => {
      const t = await this.load(tx, siteId, taskId);
      if (t.equipmentId) await this.equipment.setStatus(tx, siteId, t.equipmentId, 'ASSIGNED', { taskSummary: `Blocked: ${reason}` });
      await this.transition(tx, t, t.version, 'BLOCKED', { blockReason: reason });
    });
  }

  async unblock(siteId: string, taskId: string) {
    return this.tx.run(async (tx) => {
      const t = await this.load(tx, siteId, taskId);
      await this.transition(tx, t, t.version, 'ASSIGNED', { blockReason: null });
    });
  }

  async cancel(siteId: string, taskId: string, reason: string) {
    return this.tx.run(async (tx) => this.doCancel(tx, await this.load(tx, siteId, taskId), reason));
  }

  private async doCancel(tx: Tx, t: OperationTask, reason: string) {
    await this.handlers.get(t.taskType)?.cancel?.(tx, t);
    if (t.equipmentId && ['ASSIGNED', 'IN_PROGRESS', 'BLOCKED'].includes(t.status)) {
      await this.equipment.setStatus(tx, t.siteId, t.equipmentId, 'AVAILABLE', { taskSummary: null });
    }
    await this.transition(tx, t, t.version, 'CANCELLED', { blockReason: reason });
  }

  // ───────────── Queries ─────────────

  async list(siteId: string, filter: { status?: string; type?: string; assigneeId?: string; sourceId?: string }): Promise<TaskDto[]> {
    const rows = await this.prisma.operationTask.findMany({
      where: {
        siteId,
        ...(filter.status ? { status: { in: filter.status.split(',') as TaskStatus[] } } : {}),
        ...(filter.type ? { taskType: { in: filter.type.split(',') as TaskType[] } } : {}),
        ...(filter.assigneeId ? { assigneeId: filter.assigneeId } : {}),
        ...(filter.sourceId ? { sourceId: filter.sourceId } : {}),
      },
      orderBy: [{ status: 'asc' }, { priority: 'asc' }, { createdAt: 'asc' }],
      take: 300,
    });
    return this.toDtos(rows);
  }

  async get(siteId: string, id: string): Promise<TaskDto> {
    const t = await this.prisma.operationTask.findFirst({ where: { id, siteId } });
    if (!t) throw DomainError.notFound('Task');
    return (await this.toDtos([t]))[0];
  }

  async toDtos(rows: OperationTask[]): Promise<TaskDto[]> {
    const ids = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => !!x))];
    const [locs, users, eqs, hus] = await Promise.all([
      this.prisma.location.findMany({ where: { id: { in: ids(rows.flatMap((r) => [r.fromLocationId, r.toLocationId])) } } }),
      this.prisma.user.findMany({ where: { id: { in: ids(rows.map((r) => r.assigneeId)) } } }),
      this.prisma.equipment.findMany({ where: { id: { in: ids(rows.map((r) => r.equipmentId)) } } }),
      this.prisma.handlingUnit.findMany({ where: { id: { in: ids(rows.filter((r) => r.subjectType === 'HANDLING_UNIT').map((r) => r.subjectId)) } } }),
    ]);
    const balances = await this.prisma.inventoryBalance.findMany({ where: { handlingUnitId: { in: hus.map((h) => h.id) }, qtyOnHand: { gt: 0 } } });
    const skus = new Map((await this.prisma.sku.findMany({ where: { id: { in: ids(balances.map((b) => b.skuId)) } } })).map((s) => [s.id, s.name]));
    const m = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));
    const ml = m(locs), mu = m(users), me = m(eqs), mh = m(hus);
    const loc = (id: string | null) => (id && ml.get(id) ? { id, code: ml.get(id)!.code, qrValue: ml.get(id)!.qrValue } : null);
    return rows.map((r) => {
      const hu = mh.get(r.subjectId);
      const bal = balances.find((b) => b.handlingUnitId === r.subjectId);
      const payload = (r.payload as Record<string, unknown> | null) ?? {};
      return {
        id: r.id,
        code: r.code,
        taskType: r.taskType,
        status: r.status,
        priority: r.priority,
        subject: { type: r.subjectType, id: r.subjectId, code: hu?.code ?? (payload.subjectCode as string) ?? r.subjectId.slice(0, 8), label: bal ? (skus.get(bal.skuId) ?? null) : ((payload.subjectLabel as string) ?? null) },
        from: loc(r.fromLocationId),
        to: loc(r.toLocationId),
        source: { type: r.sourceType, id: r.sourceId, code: (payload.sourceCode as string) ?? null },
        assignee: r.assigneeId && mu.get(r.assigneeId) ? { id: r.assigneeId, fullName: mu.get(r.assigneeId)!.fullName } : null,
        equipment: r.equipmentId && me.get(r.equipmentId) ? { id: r.equipmentId, code: me.get(r.equipmentId)!.code } : null,
        sourceConfirmed: !!payload.sourceConfirmedAt,
        blockReason: r.blockReason,
        createdAt: r.createdAt.toISOString(),
        startedAt: r.startedAt?.toISOString() ?? null,
        completedAt: r.completedAt?.toISOString() ?? null,
        version: r.version,
      };
    });
  }

  // ───────────── Internals ─────────────

  private async load(tx: Tx, siteId: string, id: string) {
    const t = await tx.operationTask.findFirst({ where: { id, siteId } });
    if (!t) throw DomainError.notFound('Task');
    return t;
  }

  private async transition(tx: Tx, t: OperationTask, expectedVersion: number, to: TaskStatus, data: Prisma.OperationTaskUncheckedUpdateManyInput) {
    if (!TRANSITIONS[t.status].includes(to)) throw DomainError.invalidTransition('OperationTask', t.status, to);
    const res = await tx.operationTask.updateMany({ where: { id: t.id, version: expectedVersion, status: t.status }, data: { ...data, status: to, version: { increment: 1 } } });
    if (res.count === 0) throw DomainError.concurrent();
    await tx.taskEvent.create({ data: { taskId: t.id, fromStatus: t.status, toStatus: to, actorId: requirePrincipalOrNull(), note: (data.blockReason as string | undefined) ?? null } });
    await this.audit.record(tx, { siteId: t.siteId, action: `TASK_${to}`, entityType: 'OperationTask', entityId: t.id, reason: (data.blockReason as string | undefined) ?? null });
    await this.emit(tx, await tx.operationTask.findUniqueOrThrow({ where: { id: t.id } }), t.status);
  }

  private async emit(tx: Tx, t: OperationTask, fromStatus?: TaskStatus) {
    const data = { taskId: t.id, code: t.code, taskType: t.taskType, fromStatus: fromStatus ?? null, status: t.status, assigneeId: t.assigneeId, equipmentId: t.equipmentId };
    await this.outbox.publish(tx, { siteId: t.siteId, type: 'task.status_changed', aggregateType: 'OperationTask', aggregateId: t.id, aggregateVersion: t.version, data });
    if (t.equipmentId) {
      const eq = await tx.equipment.findUnique({ where: { id: t.equipmentId } });
      await this.outbox.publish(tx, {
        siteId: t.siteId,
        type: 'forklift.task_updated',
        aggregateType: 'OperationTask',
        aggregateId: t.id,
        aggregateVersion: t.version,
        data: { ...data, summary: eq?.taskSummary ?? null, fromLocationId: t.fromLocationId, toLocationId: t.toLocationId, forklift: eq ? this.equipment.toSnapshot(eq) : null },
      });
    }
  }

  private async subjectCode(tx: Tx, t: OperationTask): Promise<string | null> {
    if (t.subjectType === 'HANDLING_UNIT') return (await tx.handlingUnit.findUnique({ where: { id: t.subjectId } }))?.code ?? null;
    return ((t.payload as Record<string, unknown>)?.subjectCode as string) ?? null;
  }

  /** Nhãn hiển thị cho forklift (video: "Loading TRK-2051 at Bay 1"). */
  private async summary(tx: Tx, t: OperationTask): Promise<string> {
    const code = await this.subjectCode(tx, t);
    const to = t.toLocationId ? (await tx.location.findUnique({ where: { id: t.toLocationId } }))?.code : null;
    const payload = (t.payload as Record<string, unknown>) ?? {};
    if (payload.truckCode) return `${t.taskType === 'PICK' ? 'Picking for' : 'Loading'} ${payload.truckCode as string}${to ? ` at ${to}` : ''}`;
    const verb: Record<string, string> = { PUTAWAY: 'Put-away', PICK: 'Picking', MOVE_PALLET: 'Moving', RETURN_TO_STOCK: 'Returning', MOVE_VEHICLE: 'Moving vehicle' };
    return `${verb[t.taskType] ?? t.taskType} ${code ?? ''}${to ? ` → ${to}` : ''}`.trim();
  }
}

function requirePrincipalOrNull(): string | null {
  try {
    return requirePrincipal().userId;
  } catch {
    return null;
  }
}
