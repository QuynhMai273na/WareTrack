import { Injectable } from '@nestjs/common';
import type { ExceptionSeverity } from '@prisma/client';
import type { ExceptionDto } from '@waretrack/shared-schemas';
import { AuditService } from '../../platform/audit/audit.service';
import { currentContext } from '../../platform/context/request-context';
import { CodeGenerator } from '../../platform/codes/code-generator';
import { DomainError } from '../../platform/errors/domain-error';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { PrismaService, type Tx, TxRunner } from '../../platform/prisma/prisma.service';

export interface RaiseException {
  siteId: string;
  caseType: string;
  severity?: ExceptionSeverity;
  subjectType?: string | null;
  subjectId?: string | null;
  description: string;
}

/** ExceptionPort (mục 13.2, UC-23): ngoại lệ được ghi nhận, không tự sửa dữ liệu nghiệp vụ (AC-04). */
@Injectable()
export class ExceptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TxRunner,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly codes: CodeGenerator,
  ) {}

  async raise(tx: Tx, e: RaiseException) {
    const created = await tx.exceptionCase.create({
      data: {
        siteId: e.siteId,
        code: await this.codes.prefixed(tx, 'EXC', 5),
        caseType: e.caseType,
        severity: e.severity ?? 'MEDIUM',
        subjectType: e.subjectType ?? null,
        subjectId: e.subjectId ?? null,
        description: e.description,
        createdById: currentContext()?.principal?.userId ?? null,
      },
    });
    await this.audit.record(tx, { siteId: e.siteId, action: 'EXCEPTION_RAISED', entityType: 'ExceptionCase', entityId: created.id, reason: e.description });
    await this.emit(tx, created.id);
    return created;
  }

  async emit(tx: Tx, id: string) {
    const c = await tx.exceptionCase.findUniqueOrThrow({ where: { id } });
    await this.outbox.publish(tx, {
      siteId: c.siteId,
      type: 'exception.raised',
      aggregateType: 'ExceptionCase',
      aggregateId: c.id,
      aggregateVersion: c.version,
      data: { caseId: c.id, code: c.code, caseType: c.caseType, severity: c.severity, status: c.status, subjectType: c.subjectType, subjectId: c.subjectId, description: c.description },
    });
  }

  async list(siteId: string, status?: string): Promise<ExceptionDto[]> {
    const rows = await this.prisma.exceptionCase.findMany({
      where: { siteId, ...(status ? { status: { in: status.split(',') as ExceptionDto['status'][] } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: rows.flatMap((r) => [r.createdById, r.assigneeId]).filter((x): x is string => !!x) } } })).map((u) => [u.id, u.fullName]));
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      caseType: r.caseType,
      severity: r.severity,
      status: r.status,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      description: r.description,
      assignee: r.assigneeId ? (users.get(r.assigneeId) ?? null) : null,
      resolutionCode: r.resolutionCode,
      resolutionNote: r.resolutionNote,
      createdBy: r.createdById ? (users.get(r.createdById) ?? null) : 'System',
      createdAt: r.createdAt.toISOString(),
      version: r.version,
    }));
  }

  async create(siteId: string, e: Omit<RaiseException, 'siteId'>) {
    return this.tx.run((tx) => this.raise(tx, { ...e, siteId }));
  }

  async transition(siteId: string, id: string, to: 'IN_REVIEW' | 'RESOLVED' | 'REJECTED', opts: { expectedVersion: number; resolutionCode?: string; note?: string; assigneeId?: string }) {
    return this.tx.run(async (tx) => {
      const c = await tx.exceptionCase.findFirst({ where: { id, siteId } });
      if (!c) throw DomainError.notFound('Exception');
      const allowed: Record<string, string[]> = { OPEN: ['IN_REVIEW', 'RESOLVED', 'REJECTED'], IN_REVIEW: ['RESOLVED', 'REJECTED'] };
      if (!allowed[c.status]?.includes(to)) throw DomainError.invalidTransition('ExceptionCase', c.status, to);
      const res = await tx.exceptionCase.updateMany({
        where: { id, version: opts.expectedVersion },
        data: {
          status: to,
          version: { increment: 1 },
          ...(to === 'IN_REVIEW' ? { assigneeId: opts.assigneeId ?? currentContext()?.principal?.userId ?? null } : {}),
          ...(to !== 'IN_REVIEW' ? { resolutionCode: opts.resolutionCode ?? to, resolutionNote: opts.note ?? null } : {}),
        },
      });
      if (res.count === 0) throw DomainError.concurrent();
      await this.audit.record(tx, { siteId, action: `EXCEPTION_${to}`, entityType: 'ExceptionCase', entityId: id, reason: opts.note ?? null });
      await this.emit(tx, id);
    });
  }
}
