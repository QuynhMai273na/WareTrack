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

  async raise(tx: Tx, exception: RaiseException) {
    const created = await tx.exceptionCase.create({
      data: {
        siteId: exception.siteId,
        code: await this.codes.prefixed(tx, 'EXC', 5),
        caseType: exception.caseType,
        severity: exception.severity ?? 'MEDIUM',
        subjectType: exception.subjectType ?? null,
        subjectId: exception.subjectId ?? null,
        description: exception.description,
        createdById: currentContext()?.principal?.userId ?? null,
      },
    });
    await this.audit.record(tx, { siteId: exception.siteId, action: 'EXCEPTION_RAISED', entityType: 'ExceptionCase', entityId: created.id, reason: exception.description });
    await this.emit(tx, created.id);
    return created;
  }

  async emit(tx: Tx, id: string) {
    const exceptionCase = await tx.exceptionCase.findUniqueOrThrow({ where: { id } });
    await this.outbox.publish(tx, {
      siteId: exceptionCase.siteId,
      type: 'exception.raised',
      aggregateType: 'ExceptionCase',
      aggregateId: exceptionCase.id,
      aggregateVersion: exceptionCase.version,
      data: { caseId: exceptionCase.id, code: exceptionCase.code, caseType: exceptionCase.caseType, severity: exceptionCase.severity, status: exceptionCase.status, subjectType: exceptionCase.subjectType, subjectId: exceptionCase.subjectId, description: exceptionCase.description },
    });
  }

  async list(siteId: string, status?: string): Promise<ExceptionDto[]> {
    const rows = await this.prisma.exceptionCase.findMany({
      where: { siteId, ...(status ? { status: { in: status.split(',') as ExceptionDto['status'][] } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: rows.flatMap((row) => [row.createdById, row.assigneeId]).filter((userId): userId is string => !!userId) } } })).map((user) => [user.id, user.fullName]));
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      caseType: row.caseType,
      severity: row.severity,
      status: row.status,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      description: row.description,
      assignee: row.assigneeId ? (users.get(row.assigneeId) ?? null) : null,
      resolutionCode: row.resolutionCode,
      resolutionNote: row.resolutionNote,
      createdBy: row.createdById ? (users.get(row.createdById) ?? null) : 'System',
      createdAt: row.createdAt.toISOString(),
      version: row.version,
    }));
  }

  async create(siteId: string, exception: Omit<RaiseException, 'siteId'>) {
    return this.tx.run((tx) => this.raise(tx, { ...exception, siteId }));
  }

  async transition(siteId: string, id: string, to: 'IN_REVIEW' | 'RESOLVED' | 'REJECTED', opts: { expectedVersion: number; resolutionCode?: string; note?: string; assigneeId?: string }) {
    return this.tx.run(async (tx) => {
      const exceptionCase = await tx.exceptionCase.findFirst({ where: { id, siteId } });
      if (!exceptionCase) throw DomainError.notFound('Exception');
      const allowed: Record<string, string[]> = { OPEN: ['IN_REVIEW', 'RESOLVED', 'REJECTED'], IN_REVIEW: ['RESOLVED', 'REJECTED'] };
      if (!allowed[exceptionCase.status]?.includes(to)) throw DomainError.invalidTransition('ExceptionCase', exceptionCase.status, to);
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
