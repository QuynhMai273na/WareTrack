import { Injectable } from '@nestjs/common';
import { Prisma, type Location, type Sku } from '@prisma/client';
import type { OpeningStockRequest, OpeningStockResult, OpeningStockRow, OpeningStockRowResult } from '@waretrack/shared-schemas';
import { AuditService } from '../../platform/audit/audit.service';
import { CodeGenerator } from '../../platform/codes/code-generator';
import { LocationLockPort } from '../../platform/locks/location-lock';
import { PrismaService, type Tx, TxRunner } from '../../platform/prisma/prisma.service';
import { MovementService } from '../operations/movement.service';
import { OccupancyService } from '../yard/occupancy.service';
import { InventoryEvents } from './inventory-events.service';
import { LedgerService } from './ledger.service';

/** Loại vị trí được nhận tồn đầu kỳ (không nhận vào dock, cổng, ô xe tải…). */
const STOCKABLE_LOCATION_TYPES = new Set(['STORAGE', 'STAGING', 'QUARANTINE']);

interface ValidatedRow {
  rowNumber: number;
  row: OpeningStockRow;
  sku: Sku;
  location: Location;
}

/**
 * Nhập tồn kho đầu kỳ khi đưa site thật vào hệ thống (thay cho seed demo).
 * Mỗi dòng = một pallet: tạo pallet + lot, ghi sổ cái RECEIPT (tham chiếu OPENING_STOCK), chiếm chỗ vị trí, lịch sử di chuyển.
 * Toàn bộ file được kiểm tra trước; có bất kỳ lỗi nào thì không ghi gì (tất cả hoặc không).
 */
@Injectable()
export class OpeningStockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TxRunner,
    private readonly ledger: LedgerService,
    private readonly events: InventoryEvents,
    private readonly occupancy: OccupancyService,
    private readonly locks: LocationLockPort,
    private readonly movements: MovementService,
    private readonly codes: CodeGenerator,
    private readonly audit: AuditService,
  ) {}

  async import(siteId: string, request: OpeningStockRequest): Promise<OpeningStockResult> {
    const { results, validRows } = await this.validate(siteId, request.rows);
    const errorCount = results.filter((result) => result.status === 'ERROR').length;
    if (request.dryRun || errorCount > 0) return { dryRun: request.dryRun, importedPallets: 0, errorCount, rows: results };

    const importId = `opening:${siteId}:${Date.now()}`;
    await this.tx.run(
      async (tx) => {
        await this.locks.lockForUpdate(tx, [...new Set(validRows.map((validRow) => validRow.location.id))]);
        const lotIds = new Map<string, string>();
        for (const validRow of validRows) {
          const palletCode = validRow.row.palletCode?.toUpperCase() ?? (await this.codes.prefixed(tx, 'PAL', 6));
          const lotId = await this.lotFor(tx, validRow, lotIds);
          const pallet = await tx.handlingUnit.create({
            data: { siteId, code: palletCode, lifecycle: 'IN_STOCK', locationId: validRow.location.id, positionSource: 'CONFIRMED_MANUAL', positionConfirmedAt: new Date() },
          });
          const posted = await this.ledger.post(tx, {
            siteId,
            txType: 'RECEIPT',
            idempotencyKey: `${importId}:${validRow.rowNumber}`,
            skuId: validRow.sku.id,
            lotId,
            handlingUnitId: pallet.id,
            toLocationId: validRow.location.id,
            toStatus: 'AVAILABLE',
            quantity: validRow.row.quantity,
            referenceType: 'OPENING_STOCK',
            referenceId: pallet.id,
          });
          await this.occupancy.occupyDirect(tx, { siteId, locationId: validRow.location.id, occupantType: 'HANDLING_UNIT', occupantId: pallet.id }, 'CONFIRMED_MANUAL');
          await this.movements.record(tx, { siteId, subjectType: 'HANDLING_UNIT', subjectId: pallet.id, fromLocationId: null, toLocationId: validRow.location.id, positionSource: 'CONFIRMED_MANUAL', reason: 'Opening stock' });
          await this.events.inventoryUpdated(tx, siteId, posted.changes, [posted.tx.id]);
          await this.events.palletMoved(tx, siteId, pallet.id, null, validRow.location.id);
          const result = results.find((candidate) => candidate.rowNumber === validRow.rowNumber)!;
          result.palletCode = palletCode;
        }
        await this.audit.record(tx, { siteId, action: 'OPENING_STOCK_IMPORTED', entityType: 'Site', entityId: siteId, diff: { after: { pallets: validRows.length } } });
      },
      { timeoutMs: Math.max(20_000, validRows.length * 60) },
    );
    return { dryRun: false, importedPallets: validRows.length, errorCount: 0, rows: results };
  }

  private async validate(siteId: string, rows: OpeningStockRow[]) {
    const skuCodes = [...new Set(rows.map((row) => row.skuCode.trim().toUpperCase()))];
    const locationCodes = [...new Set(rows.map((row) => row.locationCode.trim()))];
    const palletCodes = rows.map((row) => row.palletCode?.toUpperCase()).filter((code): code is string => !!code);

    const skus = await this.prisma.sku.findMany({ where: { deletedAt: null, code: { in: skuCodes, mode: 'insensitive' } } });
    const locations = await this.prisma.location.findMany({ where: { siteId, deletedAt: null, code: { in: locationCodes, mode: 'insensitive' } } });
    const existingPallets = palletCodes.length ? await this.prisma.handlingUnit.findMany({ where: { code: { in: palletCodes } }, select: { code: true } }) : [];
    const occupancyByLocation = await this.prisma.locationOccupancy.groupBy({
      by: ['locationId'],
      where: { releasedAt: null, locationId: { in: locations.map((location) => location.id) } },
      _sum: { unitsUsed: true },
    });

    const skuByCode = new Map(skus.map((sku) => [sku.code.toUpperCase(), sku]));
    const locationByCode = new Map(locations.map((location) => [location.code.toUpperCase(), location]));
    const takenPalletCodes = new Set(existingPallets.map((pallet) => pallet.code));
    const usedUnits = new Map(occupancyByLocation.map((usage) => [usage.locationId, Number(usage._sum.unitsUsed ?? 0)]));
    const seenPalletCodes = new Set<string>();

    const results: OpeningStockRowResult[] = [];
    const validRows: ValidatedRow[] = [];
    rows.forEach((row, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const problems: string[] = [];
      const sku = skuByCode.get(row.skuCode.trim().toUpperCase());
      const location = locationByCode.get(row.locationCode.trim().toUpperCase());
      if (!sku) problems.push(`Unknown SKU ${row.skuCode}`);
      if (!location) problems.push(`Unknown location ${row.locationCode}`);
      else if (!STOCKABLE_LOCATION_TYPES.has(location.locationType)) problems.push(`${location.code} is a ${location.locationType.toLowerCase()} and cannot hold stock`);
      else if (location.blockedAt) problems.push(`${location.code} is blocked`);
      const quantity = new Prisma.Decimal(row.quantity);
      if (quantity.lte(0)) problems.push('Quantity must be greater than zero');
      if (sku) {
        if (quantity.decimalPlaces() > sku.uomDecimals) problems.push(`${sku.code} allows ${sku.uomDecimals} decimal places`);
        if (sku.lotTracked && !row.lotNumber) problems.push(`${sku.code} requires a lot number`);
        if (sku.expiryTracked && !row.expiresOn) problems.push(`${sku.code} requires an expiry date`);
      }
      const palletCode = row.palletCode?.toUpperCase();
      if (palletCode) {
        if (takenPalletCodes.has(palletCode)) problems.push(`Pallet ${palletCode} already exists`);
        else if (seenPalletCodes.has(palletCode)) problems.push(`Pallet ${palletCode} appears twice in the file`);
        seenPalletCodes.add(palletCode);
      }
      if (location && STOCKABLE_LOCATION_TYPES.has(location.locationType)) {
        const used = usedUnits.get(location.id) ?? 0;
        if (used + 1 > Number(location.capacityUnits)) problems.push(`${location.code} is full (${used}/${Number(location.capacityUnits)} pallets)`);
        else usedUnits.set(location.id, used + 1);
      }
      if (problems.length || !sku || !location) {
        results.push({ rowNumber, status: 'ERROR', message: problems.join('; '), palletCode: palletCode ?? null });
        return;
      }
      results.push({ rowNumber, status: 'OK', message: null, palletCode: palletCode ?? null });
      validRows.push({ rowNumber, row, sku, location });
    });
    return { results, validRows };
  }

  private async lotFor(tx: Tx, validRow: ValidatedRow, cache: Map<string, string>): Promise<string | null> {
    const lotNumber = validRow.row.lotNumber?.trim();
    if (!lotNumber) return null;
    const cacheKey = `${validRow.sku.id}:${lotNumber}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const lot = await tx.lot.upsert({
      where: { skuId_lotNumber: { skuId: validRow.sku.id, lotNumber } },
      create: { skuId: validRow.sku.id, lotNumber, expiresOn: validRow.row.expiresOn ? new Date(`${validRow.row.expiresOn}T00:00:00Z`) : null },
      update: {},
    });
    cache.set(cacheKey, lot.id);
    return lot.id;
  }
}
