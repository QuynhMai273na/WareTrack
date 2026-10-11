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

  /**
   * Người nhận việc được tại site: user đang hoạt động có vai trò vận hành tại site (hoặc cấp doanh nghiệp).
   * Dùng cho hộp thoại giao task của giám sát kho / điều phối — họ không có quyền xem danh sách user đầy đủ.
   */
  async assignees(siteId: string) {
    const assignments = await this.prisma.userSiteRole.findMany({
      where: { revokedAt: null, OR: [{ siteId }, { siteId: null }], role: { code: { in: ['FORKLIFT_OPERATOR', 'WAREHOUSE_OPERATOR', 'WAREHOUSE_SUPERVISOR', 'YARD_DISPATCHER', 'INVENTORY_CONTROLLER'] } }, user: { status: 'ACTIVE' } },
      include: { user: true, role: true },
    });
    const byUser = new Map<string, { id: string; fullName: string; username: string; roleCodes: string[] }>();
    for (const assignment of assignments) {
      const entry = byUser.get(assignment.userId) ?? { id: assignment.userId, fullName: assignment.user.fullName, username: assignment.user.username, roleCodes: [] };
      if (!entry.roleCodes.includes(assignment.role.code)) entry.roleCodes.push(assignment.role.code);
      byUser.set(assignment.userId, entry);
    }
    return [...byUser.values()].sort((left, right) => left.fullName.localeCompare(right.fullName));
  }

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
      for (const task of tasks) {
        const to = task.status === 'ASSIGNED' ? 'PENDING' : 'BLOCKED';
        await this.transition(tx, task, task.version, to, { equipmentId: null, ...(to === 'PENDING' ? { assigneeId: null } : {}), blockReason: `${eq.code}: ${reason}` });
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
    for (const task of open) await this.doCancel(tx, task, reason);
  }

  async assign(siteId: string, taskId: string, body: { assigneeId: string; equipmentId?: string; expectedVersion: number }) {
    const principal = requirePrincipal();
    return this.tx.run(async (tx) => {
      const task = await this.load(tx, siteId, taskId);
      const supervisorRoles = ['SITE_MANAGER', 'YARD_DISPATCHER', 'WAREHOUSE_SUPERVISOR'];
      if (!principal.roles.some((role) => supervisorRoles.includes(role))) {
        // DEC-33: operator chỉ tự nhận task khi site bật selfAssign
        const settings = await this.sites.settings(siteId, tx);
        if (body.assigneeId !== principal.userId || !settings.selfAssign) throw DomainError.forbidden('Self-assignment is disabled for this site (DEC-33)');
      }
      const assignee = await this.access.getUserAccess(body.assigneeId);
      if (!assignee || !(await this.access.permissionsAt(assignee, siteId)).has('task.execute')) {
        throw DomainError.rule(ErrorCode.VALIDATION_ERROR, 'Assignee cannot execute tasks at this site');
      }
      if (task.equipmentId && task.equipmentId !== body.equipmentId) await this.equipment.setStatus(tx, siteId, task.equipmentId, 'AVAILABLE', { taskSummary: null });
      if (body.equipmentId && body.equipmentId !== task.equipmentId) {
        await this.equipment.setStatus(tx, siteId, body.equipmentId, 'ASSIGNED', { taskSummary: await this.summary(tx, task), allowedFrom: ['AVAILABLE'] });
      }
      await this.transition(tx, task, body.expectedVersion, 'ASSIGNED', { assigneeId: body.assigneeId, equipmentId: body.equipmentId ?? null });
    });
  }

  async start(siteId: string, taskId: string, expectedVersion: number) {
    const principal = requirePrincipal();
    return this.tx.run(async (tx) => {
      const task = await this.load(tx, siteId, taskId);
      if (task.assigneeId !== principal.userId) throw DomainError.forbidden('Only the assignee can start this task');
      const busy = await tx.operationTask.findFirst({ where: { assigneeId: principal.userId, status: 'IN_PROGRESS' } });
      if (busy) throw DomainError.conflict(ErrorCode.OPERATOR_BUSY, `You already have ${busy.code} in progress (BR-27)`);
      if (task.equipmentId) {
        const eqBusy = await tx.operationTask.findFirst({ where: { equipmentId: task.equipmentId, status: 'IN_PROGRESS' } });
        if (eqBusy) throw DomainError.conflict(ErrorCode.EQUIPMENT_BUSY, `Equipment is busy with ${eqBusy.code} (BR-27)`);
        await this.equipment.setStatus(tx, siteId, task.equipmentId, 'BUSY', { taskSummary: await this.summary(tx, task), allowedFrom: ['ASSIGNED', 'AVAILABLE'] });
      }
      await this.transition(tx, task, expectedVersion, 'IN_PROGRESS', { startedAt: new Date() });
    });
  }

  /** Xác nhận nguồn: quét location + đối tượng phải khớp vị trí hệ thống (UC-07/UC-10/UC-12). */
  async confirmSource(siteId: string, taskId: string, body: { locationScan: string; subjectScan: string }) {
    return this.tx.run(async (tx) => {
      const task = await this.load(tx, siteId, taskId);
      if (task.status !== 'IN_PROGRESS') throw DomainError.invalidTransition('OperationTask', task.status, 'IN_PROGRESS');
      if (task.fromLocationId) {
        const from = await tx.location.findUniqueOrThrow({ where: { id: task.fromLocationId } });
        if (!matches(body.locationScan, from)) throw DomainError.rule(ErrorCode.LOCATION_MISMATCH, `Scanned ${body.locationScan}, expected ${from.code}`);
      }
      const subjectCode = await this.subjectCode(tx, task);
      if (subjectCode && body.subjectScan.trim().toUpperCase() !== subjectCode.toUpperCase()) {
        throw DomainError.rule(ErrorCode.HU_MISMATCH, `Scanned ${body.subjectScan}, expected ${subjectCode}`);
      }
      const payload = { ...((task.payload as Record<string, unknown>) ?? {}), sourceConfirmedAt: new Date().toISOString() };
      await tx.operationTask.update({ where: { id: task.id }, data: { payload, version: { increment: 1 } } });
      await this.audit.record(tx, { siteId, action: 'TASK_SOURCE_CONFIRMED', entityType: 'OperationTask', entityId: task.id });
    });
  }

  /** Xác nhận đích → handler nghiệp vụ → COMPLETED trong cùng transaction (mục 13.2: "Complete task = 1 TX"). */
  async confirmDestination(siteId: string, taskId: string, body: { locationScan: string; overrideReason?: string }) {
    return this.tx.run(async (tx) => {
      const task = await this.load(tx, siteId, taskId);
      if (task.status !== 'IN_PROGRESS') throw DomainError.invalidTransition('OperationTask', task.status, 'COMPLETED');
      const handler = this.handlers.get(task.taskType);
      if (!handler) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, `No handler for ${task.taskType}`);
      const scanned = await tx.location.findFirst({ where: { siteId, deletedAt: null, OR: [{ qrValue: body.locationScan.trim() }, { code: { equals: body.locationScan.trim(), mode: 'insensitive' } }] } });
      if (!scanned) throw DomainError.rule(ErrorCode.LOCATION_MISMATCH, `Unknown location ${body.locationScan}`);
      if (task.toLocationId && scanned.id !== task.toLocationId && !handler.allowAlternativeDestination) {
        const expected = await tx.location.findUniqueOrThrow({ where: { id: task.toLocationId } });
        throw DomainError.rule(scanned.locationType === 'DOCK' ? ErrorCode.DOCK_MISMATCH : ErrorCode.LOCATION_MISMATCH, `Scanned ${scanned.code}, expected ${expected.code}`);
      }
      await this.completeInTx(tx, task, { destinationLocationId: scanned.id, source: 'CONFIRMED_SCAN', overrideReason: body.overrideReason });
    });
  }

  /** Handler nghiệp vụ + giải phóng thiết bị + COMPLETED trong transaction của caller. */
  async completeInTx(tx: Tx, task: OperationTask, ctx: TaskCompletionContext) {
    const handler = this.handlers.get(task.taskType);
    if (!handler) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, `No handler for ${task.taskType}`);
    await handler.complete(tx, task, ctx);
    if (task.equipmentId) await this.equipment.setStatus(tx, task.siteId, task.equipmentId, 'AVAILABLE', { taskSummary: null, incrementMoves: true });
    const fresh = await tx.operationTask.findUniqueOrThrow({ where: { id: task.id } });
    await this.transition(tx, fresh, fresh.version, 'COMPLETED', { completedAt: new Date(), toLocationId: ctx.destinationLocationId });
  }

  async cancelInTx(tx: Tx, task: OperationTask, reason: string) {
    await this.doCancel(tx, task, reason);
  }

  async block(siteId: string, taskId: string, reason: string) {
    return this.tx.run(async (tx) => {
      const task = await this.load(tx, siteId, taskId);
      if (task.equipmentId) await this.equipment.setStatus(tx, siteId, task.equipmentId, 'ASSIGNED', { taskSummary: `Blocked: ${reason}` });
      await this.transition(tx, task, task.version, 'BLOCKED', { blockReason: reason });
    });
  }

  async unblock(siteId: string, taskId: string) {
    return this.tx.run(async (tx) => {
      const task = await this.load(tx, siteId, taskId);
      await this.transition(tx, task, task.version, 'ASSIGNED', { blockReason: null });
    });
  }

  async cancel(siteId: string, taskId: string, reason: string) {
    return this.tx.run(async (tx) => this.doCancel(tx, await this.load(tx, siteId, taskId), reason));
  }

  private async doCancel(tx: Tx, task: OperationTask, reason: string) {
    await this.handlers.get(task.taskType)?.cancel?.(tx, task);
    if (task.equipmentId && ['ASSIGNED', 'IN_PROGRESS', 'BLOCKED'].includes(task.status)) {
      await this.equipment.setStatus(tx, task.siteId, task.equipmentId, 'AVAILABLE', { taskSummary: null });
    }
    await this.transition(tx, task, task.version, 'CANCELLED', { blockReason: reason });
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
    const task = await this.prisma.operationTask.findFirst({ where: { id, siteId } });
    if (!task) throw DomainError.notFound('Task');
    return (await this.toDtos([task]))[0];
  }

  async toDtos(rows: OperationTask[]): Promise<TaskDto[]> {
    const ids = (xs: Array<string | null>) => [...new Set(xs.filter((id): id is string => !!id))];
    const [locs, users, eqs, hus] = await Promise.all([
      this.prisma.location.findMany({ where: { id: { in: ids(rows.flatMap((task) => [task.fromLocationId, task.toLocationId])) } } }),
      this.prisma.user.findMany({ where: { id: { in: ids(rows.map((task) => task.assigneeId)) } } }),
      this.prisma.equipment.findMany({ where: { id: { in: ids(rows.map((task) => task.equipmentId)) } } }),
      this.prisma.handlingUnit.findMany({ where: { id: { in: ids(rows.filter((task) => task.subjectType === 'HANDLING_UNIT').map((task) => task.subjectId)) } } }),
    ]);
    const balances = await this.prisma.inventoryBalance.findMany({ where: { handlingUnitId: { in: hus.map((handlingUnit) => handlingUnit.id) }, qtyOnHand: { gt: 0 } } });
    const skus = new Map((await this.prisma.sku.findMany({ where: { id: { in: ids(balances.map((balance) => balance.skuId)) } } })).map((sku) => [sku.id, sku.name]));
    const mapById = <T extends { id: string }>(xs: T[]) => new Map(xs.map((record) => [record.id, record]));
    const ml = mapById(locs), mu = mapById(users), me = mapById(eqs), mh = mapById(hus);
    const loc = (id: string | null) => (id && ml.get(id) ? { id, code: ml.get(id)!.code, qrValue: ml.get(id)!.qrValue } : null);
    return rows.map((task) => {
      const hu = mh.get(task.subjectId);
      const bal = balances.find((balance) => balance.handlingUnitId === task.subjectId);
      const payload = (task.payload as Record<string, unknown> | null) ?? {};
      return {
        id: task.id,
        code: task.code,
        taskType: task.taskType,
        status: task.status,
        priority: task.priority,
        subject: { type: task.subjectType, id: task.subjectId, code: hu?.code ?? (payload.subjectCode as string) ?? task.subjectId.slice(0, 8), label: bal ? (skus.get(bal.skuId) ?? null) : ((payload.subjectLabel as string) ?? null) },
        from: loc(task.fromLocationId),
        to: loc(task.toLocationId),
        source: { type: task.sourceType, id: task.sourceId, code: (payload.sourceCode as string) ?? null },
        assignee: task.assigneeId && mu.get(task.assigneeId) ? { id: task.assigneeId, fullName: mu.get(task.assigneeId)!.fullName } : null,
        equipment: task.equipmentId && me.get(task.equipmentId) ? { id: task.equipmentId, code: me.get(task.equipmentId)!.code } : null,
        sourceConfirmed: !!payload.sourceConfirmedAt,
        blockReason: task.blockReason,
        createdAt: task.createdAt.toISOString(),
        startedAt: task.startedAt?.toISOString() ?? null,
        completedAt: task.completedAt?.toISOString() ?? null,
        version: task.version,
      };
    });
  }

  // ───────────── Internals ─────────────

  private async load(tx: Tx, siteId: string, id: string) {
    const task = await tx.operationTask.findFirst({ where: { id, siteId } });
    if (!task) throw DomainError.notFound('Task');
    return task;
  }

  private async transition(tx: Tx, task: OperationTask, expectedVersion: number, to: TaskStatus, data: Prisma.OperationTaskUncheckedUpdateManyInput) {
    if (!TRANSITIONS[task.status].includes(to)) throw DomainError.invalidTransition('OperationTask', task.status, to);
    const res = await tx.operationTask.updateMany({ where: { id: task.id, version: expectedVersion, status: task.status }, data: { ...data, status: to, version: { increment: 1 } } });
    if (res.count === 0) throw DomainError.concurrent();
    await tx.taskEvent.create({ data: { taskId: task.id, fromStatus: task.status, toStatus: to, actorId: requirePrincipalOrNull(), note: (data.blockReason as string | undefined) ?? null } });
    await this.audit.record(tx, { siteId: task.siteId, action: `TASK_${to}`, entityType: 'OperationTask', entityId: task.id, reason: (data.blockReason as string | undefined) ?? null });
    await this.emit(tx, await tx.operationTask.findUniqueOrThrow({ where: { id: task.id } }), task.status);
  }

  private async emit(tx: Tx, task: OperationTask, fromStatus?: TaskStatus) {
    const data = { taskId: task.id, code: task.code, taskType: task.taskType, fromStatus: fromStatus ?? null, status: task.status, assigneeId: task.assigneeId, equipmentId: task.equipmentId };
    await this.outbox.publish(tx, { siteId: task.siteId, type: 'task.status_changed', aggregateType: 'OperationTask', aggregateId: task.id, aggregateVersion: task.version, data });
    if (task.equipmentId) {
      const eq = await tx.equipment.findUnique({ where: { id: task.equipmentId } });
      await this.outbox.publish(tx, {
        siteId: task.siteId,
        type: 'forklift.task_updated',
        aggregateType: 'OperationTask',
        aggregateId: task.id,
        aggregateVersion: task.version,
        data: { ...data, summary: eq?.taskSummary ?? null, fromLocationId: task.fromLocationId, toLocationId: task.toLocationId, forklift: eq ? this.equipment.toSnapshot(eq) : null },
      });
    }
  }

  private async subjectCode(tx: Tx, task: OperationTask): Promise<string | null> {
    if (task.subjectType === 'HANDLING_UNIT') return (await tx.handlingUnit.findUnique({ where: { id: task.subjectId } }))?.code ?? null;
    return ((task.payload as Record<string, unknown>)?.subjectCode as string) ?? null;
  }

  /** Nhãn hiển thị cho forklift (video: "Loading TRK-2051 at Bay 1"). */
  private async summary(tx: Tx, task: OperationTask): Promise<string> {
    const code = await this.subjectCode(tx, task);
    const to = task.toLocationId ? (await tx.location.findUnique({ where: { id: task.toLocationId } }))?.code : null;
    const payload = (task.payload as Record<string, unknown>) ?? {};
    if (payload.truckCode) return `${task.taskType === 'PICK' ? 'Picking for' : 'Loading'} ${payload.truckCode as string}${to ? ` at ${to}` : ''}`;
    const verb: Record<string, string> = { PUTAWAY: 'Put-away', PICK: 'Picking', MOVE_PALLET: 'Moving', RETURN_TO_STOCK: 'Returning', MOVE_VEHICLE: 'Moving vehicle' };
    return `${verb[task.taskType] ?? task.taskType} ${code ?? ''}${to ? ` → ${to}` : ''}`.trim();
  }
}

function requirePrincipalOrNull(): string | null {
  try {
    return requirePrincipal().userId;
  } catch {
    return null;
  }
}
