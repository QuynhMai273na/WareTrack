import { Injectable } from '@nestjs/common';
import { Prisma, type StockCount } from '@prisma/client';
import type { CreateStockCountRequest, StockCountDto, StockCountLineDto } from '@waretrack/shared-schemas';
import { AuditService } from '../../platform/audit/audit.service';
import { requirePrincipal } from '../../platform/auth/decorators';
import { CodeGenerator } from '../../platform/codes/code-generator';
import { DomainError } from '../../platform/errors/domain-error';
import { PrismaService, TxRunner } from '../../platform/prisma/prisma.service';
import { SitesService } from '../sites/sites.service';
import { StockService } from './stock.service';

const D = Prisma.Decimal;

interface Scope {
  zoneIds?: string[];
  locationIds?: string[];
  skuIds?: string[];
}

/** Kiểm kê (UC-16): blind count mặc định, freeze tùy chọn (DEC-16), chênh lệch → adjustment có duyệt. */
@Injectable()
export class StockCountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TxRunner,
    private readonly sites: SitesService,
    private readonly stock: StockService,
    private readonly audit: AuditService,
    private readonly codes: CodeGenerator,
  ) {}

  async list(siteId: string): Promise<StockCountDto[]> {
    const counts = await this.prisma.stockCount.findMany({ where: { siteId }, include: { lines: true }, orderBy: { createdAt: 'desc' }, take: 50 });
    return counts.map((c) => this.toDto(c, c.lines));
  }

  async get(siteId: string, id: string, canSeeSystemQty: boolean) {
    const c = await this.prisma.stockCount.findFirst({ where: { id, siteId }, include: { lines: true } });
    if (!c) throw DomainError.notFound('Stock count');
    const locs = new Map((await this.prisma.location.findMany({ where: { id: { in: c.lines.map((l) => l.locationId) } } })).map((l) => [l.id, l.code]));
    const skus = new Map((await this.prisma.sku.findMany({ where: { id: { in: c.lines.map((l) => l.skuId) } } })).map((s) => [s.id, s]));
    const lots = new Map((await this.prisma.lot.findMany({ where: { id: { in: c.lines.map((l) => l.lotId).filter((x): x is string => !!x) } } })).map((l) => [l.id, l.lotNumber]));
    const hus = new Map((await this.prisma.handlingUnit.findMany({ where: { id: { in: c.lines.map((l) => l.handlingUnitId).filter((x): x is string => !!x) } } })).map((h) => [h.id, h.code]));
    // Blind count: người đếm không thấy số hệ thống cho đến khi đối chiếu (UC-16-AC1)
    const reveal = canSeeSystemQty || !c.blind || ['RECONCILING', 'COMPLETED'].includes(c.status);
    const lines: StockCountLineDto[] = c.lines.map((l) => ({
      id: l.id,
      location: locs.get(l.locationId) ?? '',
      sku: { code: skus.get(l.skuId)?.code ?? '', name: skus.get(l.skuId)?.name ?? '' },
      lotNumber: l.lotId ? (lots.get(l.lotId) ?? null) : null,
      handlingUnitCode: l.handlingUnitId ? (hus.get(l.handlingUnitId) ?? null) : null,
      systemQty: reveal ? new D(l.systemQty).toFixed(3) : null,
      countedQty: l.countedQty ? new D(l.countedQty).toFixed(3) : null,
      variance: reveal && l.countedQty ? new D(l.countedQty).minus(l.systemQty).toFixed(3) : null,
      countRound: l.countRound,
    }));
    return { ...this.toDto(c, c.lines), lines };
  }

  async create(siteId: string, body: CreateStockCountRequest) {
    return this.tx.run(async (tx) => {
      const c = await tx.stockCount.create({
        data: { siteId, code: await this.codes.prefixed(tx, 'CNT'), blind: body.blind, freeze: body.freeze, scope: body.scope as object, createdById: requirePrincipal().userId },
      });
      await this.audit.record(tx, { siteId, action: 'COUNT_CREATED', entityType: 'StockCount', entityId: c.id, diff: { after: body.scope as Record<string, unknown> } });
      return c.id;
    });
  }

  /** Bắt đầu: snapshot systemQty theo phạm vi; freeze location nếu chọn. */
  async start(siteId: string, id: string) {
    return this.tx.run(async (tx) => {
      const c = await this.load(tx, siteId, id, 'PLANNED');
      const scope = c.scope as Scope;
      const locationIds = await this.scopeLocations(tx, siteId, scope);
      const balances = await tx.inventoryBalance.findMany({
        where: { siteId, locationId: { in: locationIds }, qtyOnHand: { gt: 0 }, ...(scope.skuIds?.length ? { skuId: { in: scope.skuIds } } : {}) },
      });
      if (c.freeze) await this.sites.freeze(tx, siteId, [...new Set(balances.map((b) => b.locationId).concat(scope.locationIds ?? []))], c.id);
      await tx.stockCountLine.createMany({
        data: balances.map((b) => ({ stockCountId: c.id, siteId, locationId: b.locationId, skuId: b.skuId, lotId: b.lotId, handlingUnitId: b.handlingUnitId, balanceId: b.id, systemQty: b.qtyOnHand })),
      });
      await this.transition(tx, c, 'IN_PROGRESS');
      await this.audit.record(tx, { siteId, action: 'COUNT_STARTED', entityType: 'StockCount', entityId: c.id, diff: { after: { lines: balances.length, freeze: c.freeze } } });
    });
  }

  async recordLine(siteId: string, id: string, lineId: string, countedQty: string) {
    return this.tx.run(async (tx) => {
      await this.load(tx, siteId, id, 'IN_PROGRESS');
      const line = await tx.stockCountLine.findFirst({ where: { id: lineId, stockCountId: id } });
      if (!line) throw DomainError.notFound('Count line');
      await tx.stockCountLine.update({ where: { id: lineId }, data: { countedQty: new D(countedQty), countRound: { increment: 1 }, countedById: requirePrincipal().userId, countedAt: new Date() } });
      await this.audit.record(tx, { siteId, action: 'COUNT_LINE_RECORDED', entityType: 'StockCount', entityId: id, diff: { after: { lineId, countedQty, round: line.countRound + 1 } } });
    });
  }

  async close(siteId: string, id: string) {
    return this.tx.run(async (tx) => {
      const c = await this.load(tx, siteId, id, 'IN_PROGRESS');
      await this.transition(tx, c, 'RECONCILING');
      await this.audit.record(tx, { siteId, action: 'COUNT_RECONCILED', entityType: 'StockCount', entityId: c.id });
    });
  }

  /** Hoàn tất: tạo adjustment PENDING_APPROVAL cho dòng chênh lệch; unfreeze (mục 8.6). */
  async complete(siteId: string, id: string, createAdjustments: boolean) {
    return this.tx.run(async (tx) => {
      const c = await this.load(tx, siteId, id, 'RECONCILING');
      const lines = await tx.stockCountLine.findMany({ where: { stockCountId: id, countedQty: { not: null } } });
      let created = 0;
      if (createAdjustments) {
        for (const l of lines) {
          const variance = new D(l.countedQty!).minus(l.systemQty);
          if (variance.isZero() || !l.balanceId) continue;
          await this.stock.requestAdjustment(siteId, { balanceId: l.balanceId, qtyDelta: variance.toFixed(3), reasonCode: 'COUNT_VARIANCE', note: `${c.code}` }, l.id, tx);
          created++;
        }
      }
      await this.sites.unfreeze(tx, c.id);
      await this.transition(tx, c, 'COMPLETED');
      await this.audit.record(tx, { siteId, action: 'COUNT_COMPLETED', entityType: 'StockCount', entityId: c.id, diff: { after: { adjustments: created } } });
      return { adjustments: created };
    });
  }

  async cancel(siteId: string, id: string, reason: string) {
    return this.tx.run(async (tx) => {
      const c = await tx.stockCount.findFirst({ where: { id, siteId } });
      if (!c) throw DomainError.notFound('Stock count');
      if (['COMPLETED', 'CANCELLED'].includes(c.status)) throw DomainError.invalidTransition('StockCount', c.status, 'CANCELLED');
      await this.sites.unfreeze(tx, c.id);
      await this.transition(tx, c, 'CANCELLED');
      await this.audit.record(tx, { siteId, action: 'COUNT_CANCELLED', entityType: 'StockCount', entityId: c.id, reason });
    });
  }

  private async scopeLocations(tx: Parameters<Parameters<TxRunner['run']>[0]>[0], siteId: string, scope: Scope): Promise<string[]> {
    const where: Prisma.LocationWhereInput = { siteId, deletedAt: null, locationType: { in: ['STORAGE', 'STAGING', 'QUARANTINE'] } };
    if (scope.locationIds?.length) where.id = { in: scope.locationIds };
    else if (scope.zoneIds?.length) where.zoneId = { in: scope.zoneIds };
    return (await tx.location.findMany({ where, select: { id: true } })).map((l) => l.id);
  }

  private async load(tx: Parameters<Parameters<TxRunner['run']>[0]>[0], siteId: string, id: string, expected: StockCount['status']) {
    const c = await tx.stockCount.findFirst({ where: { id, siteId } });
    if (!c) throw DomainError.notFound('Stock count');
    if (c.status !== expected) throw DomainError.invalidTransition('StockCount', c.status, expected);
    return c;
  }

  private async transition(tx: Parameters<Parameters<TxRunner['run']>[0]>[0], c: StockCount, to: StockCount['status']) {
    const res = await tx.stockCount.updateMany({ where: { id: c.id, version: c.version }, data: { status: to, version: { increment: 1 } } });
    if (res.count === 0) throw DomainError.concurrent();
  }

  private toDto(c: StockCount, lines: Array<{ countedQty: Prisma.Decimal | null; systemQty: Prisma.Decimal }>): StockCountDto {
    return {
      id: c.id,
      code: c.code,
      status: c.status,
      blind: c.blind,
      freeze: c.freeze,
      scope: c.scope as Scope,
      lineCount: lines.length,
      countedCount: lines.filter((l) => l.countedQty !== null).length,
      varianceCount: lines.filter((l) => l.countedQty !== null && !new D(l.countedQty).equals(l.systemQty)).length,
      createdAt: c.createdAt.toISOString(),
      version: c.version,
    };
  }
}
