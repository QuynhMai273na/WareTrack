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

const Decimal = Prisma.Decimal;

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
    return counts.map((stockCount) => this.toDto(stockCount, stockCount.lines));
  }

  async get(siteId: string, id: string, canSeeSystemQty: boolean) {
    const stockCount = await this.prisma.stockCount.findFirst({ where: { id, siteId }, include: { lines: true } });
    if (!stockCount) throw DomainError.notFound('Stock count');
    const locs = new Map((await this.prisma.location.findMany({ where: { id: { in: stockCount.lines.map((line) => line.locationId) } } })).map((location) => [location.id, location.code]));
    const skus = new Map((await this.prisma.sku.findMany({ where: { id: { in: stockCount.lines.map((line) => line.skuId) } } })).map((sku) => [sku.id, sku]));
    const lots = new Map((await this.prisma.lot.findMany({ where: { id: { in: stockCount.lines.map((line) => line.lotId).filter((lotId): lotId is string => !!lotId) } } })).map((lot) => [lot.id, lot.lotNumber]));
    const hus = new Map((await this.prisma.handlingUnit.findMany({ where: { id: { in: stockCount.lines.map((line) => line.handlingUnitId).filter((handlingUnitId): handlingUnitId is string => !!handlingUnitId) } } })).map((handlingUnit) => [handlingUnit.id, handlingUnit.code]));
    // Blind count: người đếm không thấy số hệ thống cho đến khi đối chiếu (UC-16-AC1)
    const reveal = canSeeSystemQty || !stockCount.blind || ['RECONCILING', 'COMPLETED'].includes(stockCount.status);
    const lines: StockCountLineDto[] = stockCount.lines.map((line) => ({
      id: line.id,
      location: locs.get(line.locationId) ?? '',
      sku: { code: skus.get(line.skuId)?.code ?? '', name: skus.get(line.skuId)?.name ?? '' },
      lotNumber: line.lotId ? (lots.get(line.lotId) ?? null) : null,
      handlingUnitCode: line.handlingUnitId ? (hus.get(line.handlingUnitId) ?? null) : null,
      systemQty: reveal ? new Decimal(line.systemQty).toFixed(3) : null,
      countedQty: line.countedQty ? new Decimal(line.countedQty).toFixed(3) : null,
      variance: reveal && line.countedQty ? new Decimal(line.countedQty).minus(line.systemQty).toFixed(3) : null,
      countRound: line.countRound,
    }));
    return { ...this.toDto(stockCount, stockCount.lines), lines };
  }

  async create(siteId: string, body: CreateStockCountRequest) {
    return this.tx.run(async (tx) => {
      const stockCount = await tx.stockCount.create({
        data: { siteId, code: await this.codes.prefixed(tx, 'CNT'), blind: body.blind, freeze: body.freeze, scope: body.scope as object, createdById: requirePrincipal().userId },
      });
      await this.audit.record(tx, { siteId, action: 'COUNT_CREATED', entityType: 'StockCount', entityId: stockCount.id, diff: { after: body.scope as Record<string, unknown> } });
      return stockCount.id;
    });
  }

  /** Bắt đầu: snapshot systemQty theo phạm vi; freeze location nếu chọn. */
  async start(siteId: string, id: string) {
    return this.tx.run(async (tx) => {
      const stockCount = await this.load(tx, siteId, id, 'PLANNED');
      const scope = stockCount.scope as Scope;
      const locationIds = await this.scopeLocations(tx, siteId, scope);
      const balances = await tx.inventoryBalance.findMany({
        where: { siteId, locationId: { in: locationIds }, qtyOnHand: { gt: 0 }, ...(scope.skuIds?.length ? { skuId: { in: scope.skuIds } } : {}) },
      });
      if (stockCount.freeze) await this.sites.freeze(tx, siteId, [...new Set(balances.map((balance) => balance.locationId).concat(scope.locationIds ?? []))], stockCount.id);
      await tx.stockCountLine.createMany({
        data: balances.map((balance) => ({ stockCountId: stockCount.id, siteId, locationId: balance.locationId, skuId: balance.skuId, lotId: balance.lotId, handlingUnitId: balance.handlingUnitId, balanceId: balance.id, systemQty: balance.qtyOnHand })),
      });
      await this.transition(tx, stockCount, 'IN_PROGRESS');
      await this.audit.record(tx, { siteId, action: 'COUNT_STARTED', entityType: 'StockCount', entityId: stockCount.id, diff: { after: { lines: balances.length, freeze: stockCount.freeze } } });
    });
  }

  async recordLine(siteId: string, id: string, lineId: string, countedQty: string) {
    return this.tx.run(async (tx) => {
      await this.load(tx, siteId, id, 'IN_PROGRESS');
      const line = await tx.stockCountLine.findFirst({ where: { id: lineId, stockCountId: id } });
      if (!line) throw DomainError.notFound('Count line');
      await tx.stockCountLine.update({ where: { id: lineId }, data: { countedQty: new Decimal(countedQty), countRound: { increment: 1 }, countedById: requirePrincipal().userId, countedAt: new Date() } });
      await this.audit.record(tx, { siteId, action: 'COUNT_LINE_RECORDED', entityType: 'StockCount', entityId: id, diff: { after: { lineId, countedQty, round: line.countRound + 1 } } });
    });
  }

  async close(siteId: string, id: string) {
    return this.tx.run(async (tx) => {
      const stockCount = await this.load(tx, siteId, id, 'IN_PROGRESS');
      await this.transition(tx, stockCount, 'RECONCILING');
      await this.audit.record(tx, { siteId, action: 'COUNT_RECONCILED', entityType: 'StockCount', entityId: stockCount.id });
    });
  }

  /** Hoàn tất: tạo adjustment PENDING_APPROVAL cho dòng chênh lệch; unfreeze (mục 8.6). */
  async complete(siteId: string, id: string, createAdjustments: boolean) {
    return this.tx.run(async (tx) => {
      const stockCount = await this.load(tx, siteId, id, 'RECONCILING');
      const lines = await tx.stockCountLine.findMany({ where: { stockCountId: id, countedQty: { not: null } } });
      let created = 0;
      if (createAdjustments) {
        for (const line of lines) {
          const variance = new Decimal(line.countedQty!).minus(line.systemQty);
          if (variance.isZero() || !line.balanceId) continue;
          await this.stock.requestAdjustment(siteId, { balanceId: line.balanceId, qtyDelta: variance.toFixed(3), reasonCode: 'COUNT_VARIANCE', note: `${stockCount.code}` }, line.id, tx);
          created++;
        }
      }
      await this.sites.unfreeze(tx, stockCount.id);
      await this.transition(tx, stockCount, 'COMPLETED');
      await this.audit.record(tx, { siteId, action: 'COUNT_COMPLETED', entityType: 'StockCount', entityId: stockCount.id, diff: { after: { adjustments: created } } });
      return { adjustments: created };
    });
  }

  async cancel(siteId: string, id: string, reason: string) {
    return this.tx.run(async (tx) => {
      const stockCount = await tx.stockCount.findFirst({ where: { id, siteId } });
      if (!stockCount) throw DomainError.notFound('Stock count');
      if (['COMPLETED', 'CANCELLED'].includes(stockCount.status)) throw DomainError.invalidTransition('StockCount', stockCount.status, 'CANCELLED');
      await this.sites.unfreeze(tx, stockCount.id);
      await this.transition(tx, stockCount, 'CANCELLED');
      await this.audit.record(tx, { siteId, action: 'COUNT_CANCELLED', entityType: 'StockCount', entityId: stockCount.id, reason });
    });
  }

  private async scopeLocations(tx: Parameters<Parameters<TxRunner['run']>[0]>[0], siteId: string, scope: Scope): Promise<string[]> {
    const where: Prisma.LocationWhereInput = { siteId, deletedAt: null, locationType: { in: ['STORAGE', 'STAGING', 'QUARANTINE'] } };
    if (scope.locationIds?.length) where.id = { in: scope.locationIds };
    else if (scope.zoneIds?.length) where.zoneId = { in: scope.zoneIds };
    return (await tx.location.findMany({ where, select: { id: true } })).map((location) => location.id);
  }

  private async load(tx: Parameters<Parameters<TxRunner['run']>[0]>[0], siteId: string, id: string, expected: StockCount['status']) {
    const stockCount = await tx.stockCount.findFirst({ where: { id, siteId } });
    if (!stockCount) throw DomainError.notFound('Stock count');
    if (stockCount.status !== expected) throw DomainError.invalidTransition('StockCount', stockCount.status, expected);
    return stockCount;
  }

  private async transition(tx: Parameters<Parameters<TxRunner['run']>[0]>[0], stockCount: StockCount, to: StockCount['status']) {
    const res = await tx.stockCount.updateMany({ where: { id: stockCount.id, version: stockCount.version }, data: { status: to, version: { increment: 1 } } });
    if (res.count === 0) throw DomainError.concurrent();
  }

  private toDto(stockCount: StockCount, lines: Array<{ countedQty: Prisma.Decimal | null; systemQty: Prisma.Decimal }>): StockCountDto {
    return {
      id: stockCount.id,
      code: stockCount.code,
      status: stockCount.status,
      blind: stockCount.blind,
      freeze: stockCount.freeze,
      scope: stockCount.scope as Scope,
      lineCount: lines.length,
      countedCount: lines.filter((line) => line.countedQty !== null).length,
      varianceCount: lines.filter((line) => line.countedQty !== null && !new Decimal(line.countedQty).equals(line.systemQty)).length,
      createdAt: stockCount.createdAt.toISOString(),
      version: stockCount.version,
    };
  }
}
