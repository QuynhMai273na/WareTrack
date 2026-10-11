import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, type InventoryBalance, type Location, type Lot, type Sku, type HandlingUnit } from '@prisma/client';
import type { AdjustmentDto, AvailabilityDto, BalanceDto, HandlingUnitDetail, HuHistoryEntry, InventoryTxDto, SkuDto } from '@waretrack/shared-schemas';
import { DomainError } from '../../platform/errors/domain-error';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { DashboardContributors } from '../dashboard/contributors';
import { InventoryEvents } from './inventory-events.service';

const D = Prisma.Decimal;
const f3 = (v: Prisma.Decimal | number | string) => new D(v).toFixed(3);

type BalanceRefs = InventoryBalance & { sku: Sku; lot: Lot | null; location: Location; hu: HandlingUnit | null };

/** InventoryQueryPort (mục 13.2) + đóng góp snapshot/KPI cho Dashboard. */
@Injectable()
export class InventoryQueryService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contributors: DashboardContributors,
    private readonly events: InventoryEvents,
  ) {}

  onModuleInit() {
    // Pallet đang ở site → scene 3D (mục 18.3)
    this.contributors.addSnapshot(async (tx, siteId) => {
      const hus = await tx.handlingUnit.findMany({ where: { siteId, lifecycle: { notIn: ['DISPATCHED', 'EMPTY'] }, locationId: { not: null } } });
      const balances = await tx.inventoryBalance.findMany({ where: { handlingUnitId: { in: hus.map((h) => h.id) }, qtyOnHand: { gt: 0 } }, orderBy: { qtyOnHand: 'desc' } });
      const skus = new Map((await tx.sku.findMany({ where: { id: { in: [...new Set(balances.map((b) => b.skuId))] } } })).map((s) => [s.id, s.name]));
      const first = new Map<string, InventoryBalance>();
      for (const b of balances) if (b.handlingUnitId && !first.has(b.handlingUnitId)) first.set(b.handlingUnitId, b);
      return {
        pallets: hus.map((h) => {
          const b = first.get(h.id);
          return {
            id: h.id,
            code: h.code,
            label: b ? (skus.get(b.skuId) ?? '') : 'Empty pallet',
            lifecycle: h.lifecycle,
            stockStatus: b?.stockStatus ?? null,
            position: { locationId: h.locationId, source: h.positionSource ?? 'CONFIRMED_MANUAL', confirmedAt: (h.positionConfirmedAt ?? h.updatedAt).toISOString() },
            version: h.version,
          };
        }),
      };
    });
    // K-01 Stock on hand (pallets) — mẫu số = vị trí pallet (DEC-13); delta = pallet nhận hôm nay
    this.contributors.addKpis(async (siteId, { todayStart, now }) => {
      const onHand = await this.prisma.handlingUnit.count({ where: { siteId, lifecycle: { in: ['RECEIVING', 'IN_STOCK', 'PICKED', 'STAGED', 'LOADED'] } } });
      const receivedToday = await this.prisma.handlingUnit.count({ where: { siteId, createdAt: { gte: todayStart } } });
      const storage = await this.prisma.location.findMany({ where: { siteId, locationType: 'STORAGE', deletedAt: null, isActive: true, blockedAt: null } });
      const capacity = storage.reduce((s, l) => s + Number(l.capacityUnits), 0);
      return [{ key: 'STOCK_ON_HAND_PALLETS', value: onHand, unit: 'pallets', total: capacity, delta: receivedToday, deltaPeriod: 'today', asOf: now.toISOString() }];
    });
  }

  skuDto(s: Sku): SkuDto {
    return {
      id: s.id,
      code: s.code,
      name: s.name,
      category: s.category,
      baseUom: s.baseUom,
      uomDecimals: s.uomDecimals,
      lotTracked: s.lotTracked,
      serialTracked: s.serialTracked,
      expiryTracked: s.expiryTracked,
      qcRequired: s.qcRequired,
      allocationStrategy: s.allocationStrategy,
      unitWeightKg: s.unitWeightKg ? f3(s.unitWeightKg) : null,
      lowStockThreshold: s.lowStockThreshold ? f3(s.lowStockThreshold) : null,
      version: s.version,
    };
  }

  private async withRefs(balances: InventoryBalance[]): Promise<BalanceRefs[]> {
    const [skus, lots, locs, hus] = await Promise.all([
      this.prisma.sku.findMany({ where: { id: { in: [...new Set(balances.map((b) => b.skuId))] } } }),
      this.prisma.lot.findMany({ where: { id: { in: balances.map((b) => b.lotId).filter((x): x is string => !!x) } } }),
      this.prisma.location.findMany({ where: { id: { in: [...new Set(balances.map((b) => b.locationId))] } } }),
      this.prisma.handlingUnit.findMany({ where: { id: { in: balances.map((b) => b.handlingUnitId).filter((x): x is string => !!x) } } }),
    ]);
    const m = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));
    const ms = m(skus), ml = m(lots), mloc = m(locs), mh = m(hus);
    return balances.map((b) => ({ ...b, sku: ms.get(b.skuId)!, lot: b.lotId ? (ml.get(b.lotId) ?? null) : null, location: mloc.get(b.locationId)!, hu: b.handlingUnitId ? (mh.get(b.handlingUnitId) ?? null) : null }));
  }

  balanceDto(b: BalanceRefs): BalanceDto {
    const available = b.stockStatus === 'AVAILABLE' ? new D(b.qtyOnHand).minus(b.qtyReserved) : new D(0);
    return {
      id: b.id,
      sku: { id: b.sku.id, code: b.sku.code, name: b.sku.name, baseUom: b.sku.baseUom },
      lot: b.lot ? { id: b.lot.id, lotNumber: b.lot.lotNumber, expiresOn: b.lot.expiresOn?.toISOString().slice(0, 10) ?? null } : null,
      location: { id: b.location.id, code: b.location.code, type: b.location.locationType },
      handlingUnit: b.hu ? { id: b.hu.id, code: b.hu.code } : null,
      stockStatus: b.stockStatus,
      qtyOnHand: f3(b.qtyOnHand),
      qtyReserved: f3(b.qtyReserved),
      qtyAvailable: available.toFixed(3),
      receivedAt: b.receivedAt.toISOString(),
      version: b.version,
    };
  }

  async balances(siteId: string, filter: { skuId?: string; locationId?: string; huId?: string; status?: string; q?: string }): Promise<BalanceDto[]> {
    const rows = await this.prisma.inventoryBalance.findMany({
      where: {
        siteId,
        qtyOnHand: { gt: 0 },
        ...(filter.skuId ? { skuId: filter.skuId } : {}),
        ...(filter.locationId ? { locationId: filter.locationId } : {}),
        ...(filter.huId ? { handlingUnitId: filter.huId } : {}),
        ...(filter.status ? { stockStatus: filter.status as InventoryBalance['stockStatus'] } : {}),
      },
      orderBy: [{ skuId: 'asc' }, { receivedAt: 'asc' }],
      take: 1000,
    });
    const refs = await this.withRefs(rows);
    const q = filter.q?.toLowerCase();
    return refs.filter((b) => !q || [b.sku.code, b.sku.name, b.location.code, b.hu?.code ?? '', b.lot?.lotNumber ?? ''].some((s) => s.toLowerCase().includes(q))).map((b) => this.balanceDto(b));
  }

  async balance(siteId: string, id: string): Promise<BalanceDto> {
    const b = await this.prisma.inventoryBalance.findFirst({ where: { id, siteId } });
    if (!b) throw DomainError.notFound('Balance');
    return this.balanceDto((await this.withRefs([b]))[0]);
  }

  /** Available theo SKU + cờ low stock (site inspector "Inventory" như video). */
  async availability(siteId: string): Promise<AvailabilityDto[]> {
    const rows = await this.prisma.inventoryBalance.groupBy({ by: ['skuId', 'stockStatus'], where: { siteId, qtyOnHand: { gt: 0 } }, _sum: { qtyOnHand: true, qtyReserved: true } });
    const skus = await this.prisma.sku.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.skuId))] } }, orderBy: { name: 'asc' } });
    return skus.map((s) => {
      const mine = rows.filter((r) => r.skuId === s.id);
      const onHand = mine.reduce((acc, r) => acc.plus(r._sum.qtyOnHand ?? 0), new D(0));
      const avail = mine.find((r) => r.stockStatus === 'AVAILABLE');
      const reserved = new D(avail?._sum.qtyReserved ?? 0);
      const available = new D(avail?._sum.qtyOnHand ?? 0).minus(reserved);
      return {
        sku: { id: s.id, code: s.code, name: s.name, baseUom: s.baseUom },
        onHand: onHand.toFixed(3),
        reserved: reserved.toFixed(3),
        available: available.toFixed(3),
        byStatus: Object.fromEntries(mine.map((r) => [r.stockStatus, f3(r._sum.qtyOnHand ?? 0)])),
        lowStock: s.lowStockThreshold ? available.lt(s.lowStockThreshold) : false,
        lowStockThreshold: s.lowStockThreshold ? f3(s.lowStockThreshold) : null,
      };
    });
  }

  async transactions(siteId: string, filter: { skuId?: string; huId?: string; type?: string; limit?: number }): Promise<InventoryTxDto[]> {
    const rows = await this.prisma.inventoryTransaction.findMany({
      where: { siteId, ...(filter.skuId ? { skuId: filter.skuId } : {}), ...(filter.huId ? { handlingUnitId: filter.huId } : {}), ...(filter.type ? { txType: filter.type as InventoryTxDto['txType'] } : {}) },
      orderBy: { id: 'desc' },
      take: Math.min(filter.limit ?? 200, 500),
    });
    const ids = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => !!x))];
    const [skus, lots, hus, locs, users, reversals] = await Promise.all([
      this.prisma.sku.findMany({ where: { id: { in: ids(rows.map((r) => r.skuId)) } } }),
      this.prisma.lot.findMany({ where: { id: { in: ids(rows.map((r) => r.lotId)) } } }),
      this.prisma.handlingUnit.findMany({ where: { id: { in: ids(rows.map((r) => r.handlingUnitId)) } } }),
      this.prisma.location.findMany({ where: { id: { in: ids(rows.flatMap((r) => [r.fromLocationId, r.toLocationId])) } } }),
      this.prisma.user.findMany({ where: { id: { in: ids(rows.map((r) => r.actorId)) } } }),
      this.prisma.inventoryTransaction.findMany({ where: { reversesTxId: { in: rows.map((r) => r.id) } }, select: { id: true, reversesTxId: true } }),
    ]);
    const mapBy = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));
    const ms = mapBy(skus), ml = mapBy(lots), mh = mapBy(hus), mloc = mapBy(locs), mu = mapBy(users);
    const reversedBy = new Map(reversals.map((r) => [String(r.reversesTxId), String(r.id)]));
    return rows.map((r) => ({
      id: String(r.id),
      txType: r.txType,
      sku: { id: r.skuId, code: ms.get(r.skuId)?.code ?? '' },
      lotNumber: r.lotId ? (ml.get(r.lotId)?.lotNumber ?? null) : null,
      handlingUnitCode: r.handlingUnitId ? (mh.get(r.handlingUnitId)?.code ?? null) : null,
      fromLocation: r.fromLocationId ? (mloc.get(r.fromLocationId)?.code ?? null) : null,
      toLocation: r.toLocationId ? (mloc.get(r.toLocationId)?.code ?? null) : null,
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      quantity: f3(r.quantity),
      referenceType: r.referenceType,
      referenceId: r.referenceId,
      reversesTxId: r.reversesTxId ? String(r.reversesTxId) : null,
      reversedByTxId: reversedBy.get(String(r.id)) ?? null,
      actor: r.actorId ? (mu.get(r.actorId)?.fullName ?? null) : 'System',
      occurredAt: r.occurredAt.toISOString(),
    }));
  }

  async pallets(siteId: string, filter: { lifecycle?: string; q?: string }) {
    const hus = await this.prisma.handlingUnit.findMany({
      where: { siteId, ...(filter.lifecycle ? { lifecycle: { in: filter.lifecycle.split(',') as HandlingUnit['lifecycle'][] } } : { lifecycle: { notIn: ['DISPATCHED', 'EMPTY'] } }), ...(filter.q ? { code: { contains: filter.q, mode: 'insensitive' as const } } : {}) },
      orderBy: { code: 'asc' },
      take: 500,
    });
    const snaps = await Promise.all(hus.map((h) => this.events.palletSnapshot(this.prisma, h.id)));
    const locs = new Map((await this.prisma.location.findMany({ where: { id: { in: hus.map((h) => h.locationId).filter((x): x is string => !!x) } } })).map((l) => [l.id, l.code]));
    return snaps.filter(Boolean).map((s) => ({ ...s!, locationCode: s!.position?.locationId ? (locs.get(s!.position.locationId) ?? null) : null }));
  }

  async pallet(siteId: string, huId: string): Promise<HandlingUnitDetail> {
    const hu = await this.prisma.handlingUnit.findFirst({ where: { id: huId, siteId } });
    if (!hu) throw DomainError.notFound('Pallet');
    const balances = await this.withRefs(await this.prisma.inventoryBalance.findMany({ where: { handlingUnitId: hu.id, qtyOnHand: { gt: 0 } } }));
    const loc = hu.locationId ? await this.prisma.location.findUnique({ where: { id: hu.locationId } }) : null;
    return {
      id: hu.id,
      code: hu.code,
      sscc: hu.sscc,
      lifecycle: hu.lifecycle,
      location: loc ? { id: loc.id, code: loc.code, type: loc.locationType, name: loc.name } : null,
      position: hu.positionSource ? { source: hu.positionSource, confirmedAt: (hu.positionConfirmedAt ?? hu.updatedAt).toISOString() } : null,
      grossWeightKg: hu.grossWeightKg !== null ? Number(hu.grossWeightKg) : null,
      contents: balances.map((b) => ({
        balanceId: b.id,
        sku: { id: b.sku.id, code: b.sku.code, name: b.sku.name, baseUom: b.sku.baseUom, category: (b.sku as { category?: string | null }).category ?? null },
        lotNumber: b.lot?.lotNumber ?? null,
        receivedAt: b.receivedAt?.toISOString() ?? null,
        expiresOn: b.lot?.expiresOn?.toISOString().slice(0, 10) ?? null,
        stockStatus: b.stockStatus,
        qtyOnHand: f3(b.qtyOnHand),
        qtyReserved: f3(b.qtyReserved),
      })),
      version: hu.version,
    };
  }

  /** Lịch sử pallet = ledger + movement (AC-08). */
  async palletHistory(siteId: string, huId: string): Promise<HuHistoryEntry[]> {
    const ledger = await this.transactions(siteId, { huId, limit: 200 });
    const moves = await this.prisma.movementRecord.findMany({ where: { subjectType: 'HANDLING_UNIT', subjectId: huId }, orderBy: { occurredAt: 'desc' } });
    const locs = new Map((await this.prisma.location.findMany({ where: { id: { in: moves.flatMap((m) => [m.fromLocationId, m.toLocationId]).filter((x): x is string => !!x) } } })).map((l) => [l.id, l.code]));
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: moves.map((m) => m.actorId).filter((x): x is string => !!x) } } })).map((u) => [u.id, u.fullName]));
    return [
      ...ledger.map((t) => ({ at: t.occurredAt, kind: 'LEDGER' as const, description: `${t.txType} ${t.quantity} ${t.sku.code}${t.lotNumber ? ` · ${t.lotNumber}` : ''}`, from: t.fromLocation, to: t.toLocation, source: null, actor: t.actor })),
      ...moves.map((m) => ({
        at: m.occurredAt.toISOString(),
        kind: 'MOVEMENT' as const,
        description: m.reason,
        from: m.fromLocationId ? (locs.get(m.fromLocationId) ?? null) : null,
        to: m.toLocationId ? (locs.get(m.toLocationId) ?? null) : null,
        source: m.positionSource,
        actor: m.actorId ? (users.get(m.actorId) ?? null) : 'System',
      })),
    ].sort((a, b) => b.at.localeCompare(a.at));
  }

  async adjustments(siteId: string, status?: string): Promise<AdjustmentDto[]> {
    const rows = await this.prisma.stockAdjustment.findMany({ where: { siteId, ...(status ? { status: status as AdjustmentDto['status'] } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
    const balances = new Map(
      (await this.withRefs(await this.prisma.inventoryBalance.findMany({ where: { id: { in: rows.map((r) => r.balanceId) } } }))).map((b) => [b.id, this.balanceDto(b)]),
    );
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: rows.flatMap((r) => [r.requestedById, r.approvedById]).filter((x): x is string => !!x) } } })).map((u) => [u.id, u]));
    return rows
      .filter((r) => balances.has(r.balanceId))
      .map((r) => ({
        id: r.id,
        code: r.code,
        balance: balances.get(r.balanceId)!,
        qtyDelta: new D(r.qtyDelta).toFixed(3),
        reasonCode: r.reasonCode,
        note: r.note,
        status: r.status,
        requiresManager: r.requiresManager,
        requestedBy: { id: r.requestedById, fullName: users.get(r.requestedById)?.fullName ?? '' },
        approvedBy: r.approvedById ? { id: r.approvedById, fullName: users.get(r.approvedById)?.fullName ?? '' } : null,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        decisionNote: r.decisionNote,
        createdAt: r.createdAt.toISOString(),
        version: r.version,
      }));
  }
}
