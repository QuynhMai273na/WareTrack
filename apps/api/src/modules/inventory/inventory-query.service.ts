import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, type InventoryBalance, type Location, type Lot, type Sku, type HandlingUnit } from '@prisma/client';
import type { AdjustmentDto, AvailabilityDto, BalanceDto, HandlingUnitDetail, HuHistoryEntry, InventoryTxDto, SkuDto } from '@waretrack/shared-schemas';
import { DomainError } from '../../platform/errors/domain-error';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { DashboardContributors } from '../dashboard/contributors';
import { InventoryEvents } from './inventory-events.service';

const Decimal = Prisma.Decimal;
const f3 = (amount: Prisma.Decimal | number | string) => new Decimal(amount).toFixed(3);

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
      const balances = await tx.inventoryBalance.findMany({ where: { handlingUnitId: { in: hus.map((handlingUnit) => handlingUnit.id) }, qtyOnHand: { gt: 0 } }, orderBy: { qtyOnHand: 'desc' } });
      const skus = new Map((await tx.sku.findMany({ where: { id: { in: [...new Set(balances.map((balance) => balance.skuId))] } } })).map((sku) => [sku.id, sku.name]));
      const first = new Map<string, InventoryBalance>();
      for (const balance of balances) if (balance.handlingUnitId && !first.has(balance.handlingUnitId)) first.set(balance.handlingUnitId, balance);
      return {
        pallets: hus.map((handlingUnit) => {
          const firstBalance = first.get(handlingUnit.id);
          return {
            id: handlingUnit.id,
            code: handlingUnit.code,
            label: firstBalance ? (skus.get(firstBalance.skuId) ?? '') : 'Empty pallet',
            lifecycle: handlingUnit.lifecycle,
            stockStatus: firstBalance?.stockStatus ?? null,
            position: { locationId: handlingUnit.locationId, source: handlingUnit.positionSource ?? 'CONFIRMED_MANUAL', confirmedAt: (handlingUnit.positionConfirmedAt ?? handlingUnit.updatedAt).toISOString() },
            version: handlingUnit.version,
          };
        }),
      };
    });
    // K-01 Stock on hand (pallets) — mẫu số = vị trí pallet (DEC-13); delta = pallet nhận hôm nay
    this.contributors.addKpis(async (siteId, { todayStart, now }) => {
      const onHand = await this.prisma.handlingUnit.count({ where: { siteId, lifecycle: { in: ['RECEIVING', 'IN_STOCK', 'PICKED', 'STAGED', 'LOADED'] } } });
      const receivedToday = await this.prisma.handlingUnit.count({ where: { siteId, createdAt: { gte: todayStart } } });
      const storage = await this.prisma.location.findMany({ where: { siteId, locationType: 'STORAGE', deletedAt: null, isActive: true, blockedAt: null } });
      const capacity = storage.reduce((sum, location) => sum + Number(location.capacityUnits), 0);
      return [{ key: 'STOCK_ON_HAND_PALLETS', value: onHand, unit: 'pallets', total: capacity, delta: receivedToday, deltaPeriod: 'today', asOf: now.toISOString() }];
    });
  }

  skuDto(sku: Sku): SkuDto {
    return {
      id: sku.id,
      code: sku.code,
      name: sku.name,
      category: sku.category,
      baseUom: sku.baseUom,
      uomDecimals: sku.uomDecimals,
      lotTracked: sku.lotTracked,
      serialTracked: sku.serialTracked,
      expiryTracked: sku.expiryTracked,
      qcRequired: sku.qcRequired,
      allocationStrategy: sku.allocationStrategy,
      unitWeightKg: sku.unitWeightKg ? f3(sku.unitWeightKg) : null,
      lowStockThreshold: sku.lowStockThreshold ? f3(sku.lowStockThreshold) : null,
      version: sku.version,
    };
  }

  private async withRefs(balances: InventoryBalance[]): Promise<BalanceRefs[]> {
    const [skus, lots, locs, hus] = await Promise.all([
      this.prisma.sku.findMany({ where: { id: { in: [...new Set(balances.map((balance) => balance.skuId))] } } }),
      this.prisma.lot.findMany({ where: { id: { in: balances.map((balance) => balance.lotId).filter((lotId): lotId is string => !!lotId) } } }),
      this.prisma.location.findMany({ where: { id: { in: [...new Set(balances.map((balance) => balance.locationId))] } } }),
      this.prisma.handlingUnit.findMany({ where: { id: { in: balances.map((balance) => balance.handlingUnitId).filter((handlingUnitId): handlingUnitId is string => !!handlingUnitId) } } }),
    ]);
    const mapById = <T extends { id: string }>(xs: T[]) => new Map(xs.map((record) => [record.id, record]));
    const ms = mapById(skus), ml = mapById(lots), mloc = mapById(locs), mh = mapById(hus);
    return balances.map((balance) => ({ ...balance, sku: ms.get(balance.skuId)!, lot: balance.lotId ? (ml.get(balance.lotId) ?? null) : null, location: mloc.get(balance.locationId)!, hu: balance.handlingUnitId ? (mh.get(balance.handlingUnitId) ?? null) : null }));
  }

  balanceDto(balance: BalanceRefs): BalanceDto {
    const available = balance.stockStatus === 'AVAILABLE' ? new Decimal(balance.qtyOnHand).minus(balance.qtyReserved) : new Decimal(0);
    return {
      id: balance.id,
      sku: { id: balance.sku.id, code: balance.sku.code, name: balance.sku.name, baseUom: balance.sku.baseUom },
      lot: balance.lot ? { id: balance.lot.id, lotNumber: balance.lot.lotNumber, expiresOn: balance.lot.expiresOn?.toISOString().slice(0, 10) ?? null } : null,
      location: { id: balance.location.id, code: balance.location.code, type: balance.location.locationType },
      handlingUnit: balance.hu ? { id: balance.hu.id, code: balance.hu.code } : null,
      stockStatus: balance.stockStatus,
      qtyOnHand: f3(balance.qtyOnHand),
      qtyReserved: f3(balance.qtyReserved),
      qtyAvailable: available.toFixed(3),
      receivedAt: balance.receivedAt.toISOString(),
      version: balance.version,
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
    const searchText = filter.q?.toLowerCase();
    return refs.filter((balance) => !searchText || [balance.sku.code, balance.sku.name, balance.location.code, balance.hu?.code ?? '', balance.lot?.lotNumber ?? ''].some((field) => field.toLowerCase().includes(searchText))).map((balance) => this.balanceDto(balance));
  }

  async balance(siteId: string, id: string): Promise<BalanceDto> {
    const balance = await this.prisma.inventoryBalance.findFirst({ where: { id, siteId } });
    if (!balance) throw DomainError.notFound('Balance');
    return this.balanceDto((await this.withRefs([balance]))[0]);
  }

  /** Available theo SKU + cờ low stock (site inspector "Inventory" như video). */
  async availability(siteId: string): Promise<AvailabilityDto[]> {
    const rows = await this.prisma.inventoryBalance.groupBy({ by: ['skuId', 'stockStatus'], where: { siteId, qtyOnHand: { gt: 0 } }, _sum: { qtyOnHand: true, qtyReserved: true } });
    const skus = await this.prisma.sku.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.skuId))] } }, orderBy: { name: 'asc' } });
    return skus.map((sku) => {
      const mine = rows.filter((row) => row.skuId === sku.id);
      const onHand = mine.reduce((acc, row) => acc.plus(row._sum.qtyOnHand ?? 0), new Decimal(0));
      const avail = mine.find((row) => row.stockStatus === 'AVAILABLE');
      const reserved = new Decimal(avail?._sum.qtyReserved ?? 0);
      const available = new Decimal(avail?._sum.qtyOnHand ?? 0).minus(reserved);
      return {
        sku: { id: sku.id, code: sku.code, name: sku.name, baseUom: sku.baseUom },
        onHand: onHand.toFixed(3),
        reserved: reserved.toFixed(3),
        available: available.toFixed(3),
        byStatus: Object.fromEntries(mine.map((row) => [row.stockStatus, f3(row._sum.qtyOnHand ?? 0)])),
        lowStock: sku.lowStockThreshold ? available.lt(sku.lowStockThreshold) : false,
        lowStockThreshold: sku.lowStockThreshold ? f3(sku.lowStockThreshold) : null,
      };
    });
  }

  async transactions(siteId: string, filter: { skuId?: string; huId?: string; type?: string; limit?: number }): Promise<InventoryTxDto[]> {
    const rows = await this.prisma.inventoryTransaction.findMany({
      where: { siteId, ...(filter.skuId ? { skuId: filter.skuId } : {}), ...(filter.huId ? { handlingUnitId: filter.huId } : {}), ...(filter.type ? { txType: filter.type as InventoryTxDto['txType'] } : {}) },
      orderBy: { id: 'desc' },
      take: Math.min(filter.limit ?? 200, 500),
    });
    const ids = (xs: Array<string | null>) => [...new Set(xs.filter((id): id is string => !!id))];
    const [skus, lots, hus, locs, users, reversals] = await Promise.all([
      this.prisma.sku.findMany({ where: { id: { in: ids(rows.map((row) => row.skuId)) } } }),
      this.prisma.lot.findMany({ where: { id: { in: ids(rows.map((row) => row.lotId)) } } }),
      this.prisma.handlingUnit.findMany({ where: { id: { in: ids(rows.map((row) => row.handlingUnitId)) } } }),
      this.prisma.location.findMany({ where: { id: { in: ids(rows.flatMap((row) => [row.fromLocationId, row.toLocationId])) } } }),
      this.prisma.user.findMany({ where: { id: { in: ids(rows.map((row) => row.actorId)) } } }),
      this.prisma.inventoryTransaction.findMany({ where: { reversesTxId: { in: rows.map((row) => row.id) } }, select: { id: true, reversesTxId: true } }),
    ]);
    const mapBy = <T extends { id: string }>(xs: T[]) => new Map(xs.map((record) => [record.id, record]));
    const ms = mapBy(skus), ml = mapBy(lots), mh = mapBy(hus), mloc = mapBy(locs), mu = mapBy(users);
    const reversedBy = new Map(reversals.map((reversal) => [String(reversal.reversesTxId), String(reversal.id)]));
    return rows.map((row) => ({
      id: String(row.id),
      txType: row.txType,
      sku: { id: row.skuId, code: ms.get(row.skuId)?.code ?? '' },
      lotNumber: row.lotId ? (ml.get(row.lotId)?.lotNumber ?? null) : null,
      handlingUnitCode: row.handlingUnitId ? (mh.get(row.handlingUnitId)?.code ?? null) : null,
      fromLocation: row.fromLocationId ? (mloc.get(row.fromLocationId)?.code ?? null) : null,
      toLocation: row.toLocationId ? (mloc.get(row.toLocationId)?.code ?? null) : null,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      quantity: f3(row.quantity),
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      reversesTxId: row.reversesTxId ? String(row.reversesTxId) : null,
      reversedByTxId: reversedBy.get(String(row.id)) ?? null,
      actor: row.actorId ? (mu.get(row.actorId)?.fullName ?? null) : 'System',
      occurredAt: row.occurredAt.toISOString(),
    }));
  }

  async pallets(siteId: string, filter: { lifecycle?: string; q?: string }) {
    const hus = await this.prisma.handlingUnit.findMany({
      where: { siteId, ...(filter.lifecycle ? { lifecycle: { in: filter.lifecycle.split(',') as HandlingUnit['lifecycle'][] } } : { lifecycle: { notIn: ['DISPATCHED', 'EMPTY'] } }), ...(filter.q ? { code: { contains: filter.q, mode: 'insensitive' as const } } : {}) },
      orderBy: { code: 'asc' },
      take: 500,
    });
    const snaps = await Promise.all(hus.map((handlingUnit) => this.events.palletSnapshot(this.prisma, handlingUnit.id)));
    const locs = new Map((await this.prisma.location.findMany({ where: { id: { in: hus.map((handlingUnit) => handlingUnit.locationId).filter((locationId): locationId is string => !!locationId) } } })).map((location) => [location.id, location.code]));
    return snaps.filter(Boolean).map((snapshot) => ({ ...snapshot!, locationCode: snapshot!.position?.locationId ? (locs.get(snapshot!.position.locationId) ?? null) : null }));
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
      contents: balances.map((balance) => ({
        balanceId: balance.id,
        sku: { id: balance.sku.id, code: balance.sku.code, name: balance.sku.name, baseUom: balance.sku.baseUom, category: (balance.sku as { category?: string | null }).category ?? null },
        lotNumber: balance.lot?.lotNumber ?? null,
        receivedAt: balance.receivedAt?.toISOString() ?? null,
        expiresOn: balance.lot?.expiresOn?.toISOString().slice(0, 10) ?? null,
        stockStatus: balance.stockStatus,
        qtyOnHand: f3(balance.qtyOnHand),
        qtyReserved: f3(balance.qtyReserved),
      })),
      version: hu.version,
    };
  }

  /** Lịch sử pallet = ledger + movement (AC-08). */
  async palletHistory(siteId: string, huId: string): Promise<HuHistoryEntry[]> {
    const ledger = await this.transactions(siteId, { huId, limit: 200 });
    const moves = await this.prisma.movementRecord.findMany({ where: { subjectType: 'HANDLING_UNIT', subjectId: huId }, orderBy: { occurredAt: 'desc' } });
    const locs = new Map((await this.prisma.location.findMany({ where: { id: { in: moves.flatMap((move) => [move.fromLocationId, move.toLocationId]).filter((locationId): locationId is string => !!locationId) } } })).map((location) => [location.id, location.code]));
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: moves.map((move) => move.actorId).filter((actorId): actorId is string => !!actorId) } } })).map((user) => [user.id, user.fullName]));
    return [
      ...ledger.map((ledgerEntry) => ({ at: ledgerEntry.occurredAt, kind: 'LEDGER' as const, description: `${ledgerEntry.txType} ${ledgerEntry.quantity} ${ledgerEntry.sku.code}${ledgerEntry.lotNumber ? ` · ${ledgerEntry.lotNumber}` : ''}`, from: ledgerEntry.fromLocation, to: ledgerEntry.toLocation, source: null, actor: ledgerEntry.actor })),
      ...moves.map((move) => ({
        at: move.occurredAt.toISOString(),
        kind: 'MOVEMENT' as const,
        description: move.reason,
        from: move.fromLocationId ? (locs.get(move.fromLocationId) ?? null) : null,
        to: move.toLocationId ? (locs.get(move.toLocationId) ?? null) : null,
        source: move.positionSource,
        actor: move.actorId ? (users.get(move.actorId) ?? null) : 'System',
      })),
    ].sort((left, right) => right.at.localeCompare(left.at));
  }

  async adjustments(siteId: string, status?: string): Promise<AdjustmentDto[]> {
    const rows = await this.prisma.stockAdjustment.findMany({ where: { siteId, ...(status ? { status: status as AdjustmentDto['status'] } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
    const balances = new Map(
      (await this.withRefs(await this.prisma.inventoryBalance.findMany({ where: { id: { in: rows.map((row) => row.balanceId) } } }))).map((balance) => [balance.id, this.balanceDto(balance)]),
    );
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: rows.flatMap((row) => [row.requestedById, row.approvedById]).filter((userId): userId is string => !!userId) } } })).map((user) => [user.id, user]));
    return rows
      .filter((row) => balances.has(row.balanceId))
      .map((row) => ({
        id: row.id,
        code: row.code,
        balance: balances.get(row.balanceId)!,
        qtyDelta: new Decimal(row.qtyDelta).toFixed(3),
        reasonCode: row.reasonCode,
        note: row.note,
        status: row.status,
        requiresManager: row.requiresManager,
        requestedBy: { id: row.requestedById, fullName: users.get(row.requestedById)?.fullName ?? '' },
        approvedBy: row.approvedById ? { id: row.approvedById, fullName: users.get(row.approvedById)?.fullName ?? '' } : null,
        decidedAt: row.decidedAt?.toISOString() ?? null,
        decisionNote: row.decisionNote,
        createdAt: row.createdAt.toISOString(),
        version: row.version,
      }));
  }
}
