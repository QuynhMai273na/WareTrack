import { Global, Injectable, Module } from '@nestjs/common';
import type { OccupantType, PositionSource } from '@prisma/client';
import { ErrorCode } from '@waretrack/shared-schemas';
import { DomainError } from '../../platform/errors/domain-error';
import { PrismaService, type Tx } from '../../platform/prisma/prisma.service';
import { type ActiveOccupancy, OCCUPANCY_READER, type OccupancyReader } from '../sites/occupancy-reader.port';

export interface ReserveInput {
  siteId: string;
  locationId: string;
  occupantType: OccupantType;
  occupantId: string;
  unitsUsed?: number;
  expiresAt?: Date | null;
}

/**
 * Occupancy của mọi location (dock, ô đỗ, yard slot, sức chứa storage) — chủ sở hữu duy nhất (mục 13.2 Yard).
 * Caller PHẢI đã khóa location bằng LocationLockPort trong cùng transaction.
 * Partial unique index BR-01 / BR-12 là chốt chặn cuối ở DB.
 */
@Injectable()
export class OccupancyService implements OccupancyReader {
  constructor(private readonly prisma: PrismaService) {}

  async reserve(tx: Tx, input: ReserveInput) {
    const loc = await this.loadForWrite(tx, input.siteId, input.locationId);
    const units = input.unitsUsed ?? 1;
    await this.assertRoom(tx, loc, units);
    return tx.locationOccupancy.create({
      data: {
        siteId: input.siteId,
        locationId: loc.id,
        occupantType: input.occupantType,
        occupantId: input.occupantId,
        kind: 'RESERVED',
        singleOccupancy: loc.singleOccupancy,
        unitsUsed: units,
        expiresAt: input.expiresAt ?? null,
      },
    });
  }

  /** Chiếm trực tiếp (không qua giữ chỗ) — ví dụ xác nhận tại vị trí thực tế. */
  async occupyDirect(tx: Tx, input: ReserveInput, source: PositionSource) {
    const loc = await this.loadForWrite(tx, input.siteId, input.locationId);
    const units = input.unitsUsed ?? 1;
    await this.assertRoom(tx, loc, units);
    return tx.locationOccupancy.create({
      data: {
        siteId: input.siteId,
        locationId: loc.id,
        occupantType: input.occupantType,
        occupantId: input.occupantId,
        kind: 'OCCUPIED',
        singleOccupancy: loc.singleOccupancy,
        unitsUsed: units,
        occupiedAt: new Date(),
        positionSource: source,
      },
    });
  }

  /** RESERVED → OCCUPIED (xác nhận vật lý). */
  async occupy(tx: Tx, occupancyId: string, source: PositionSource) {
    const res = await tx.locationOccupancy.updateMany({
      where: { id: occupancyId, kind: 'RESERVED', releasedAt: null },
      data: { kind: 'OCCUPIED', occupiedAt: new Date(), positionSource: source, expiresAt: null },
    });
    if (res.count === 0) throw DomainError.concurrent();
  }

  async release(tx: Tx, occupancyId: string) {
    await tx.locationOccupancy.updateMany({ where: { id: occupancyId, releasedAt: null }, data: { releasedAt: new Date() } });
  }

  /** Giải phóng mọi occupancy active của một đối tượng; trả về location bị ảnh hưởng. */
  async releaseAllFor(tx: Tx, occupantType: OccupantType, occupantId: string): Promise<string[]> {
    const active = await tx.locationOccupancy.findMany({ where: { occupantType, occupantId, releasedAt: null } });
    if (active.length === 0) return [];
    await tx.locationOccupancy.updateMany({ where: { id: { in: active.map((a) => a.id) } }, data: { releasedAt: new Date() } });
    return active.map((a) => a.locationId);
  }

  async activeByOccupant(occupantType: OccupantType, occupantId: string, tx?: Tx) {
    return (tx ?? this.prisma).locationOccupancy.findMany({ where: { occupantType, occupantId, releasedAt: null }, orderBy: { startedAt: 'asc' } });
  }

  async activeByLocations(siteId: string, locationIds?: string[], tx?: Tx): Promise<Map<string, ActiveOccupancy[]>> {
    const rows = await (tx ?? this.prisma).locationOccupancy.findMany({
      where: { siteId, releasedAt: null, ...(locationIds ? { locationId: { in: locationIds } } : {}) },
    });
    const map = new Map<string, ActiveOccupancy[]>();
    for (const r of rows) {
      const list = map.get(r.locationId) ?? [];
      list.push({ id: r.id, locationId: r.locationId, kind: r.kind, occupantType: r.occupantType, occupantId: r.occupantId, unitsUsed: Number(r.unitsUsed) });
      map.set(r.locationId, list);
    }
    return map;
  }

  private async loadForWrite(tx: Tx, siteId: string, locationId: string) {
    const loc = await tx.location.findFirst({ where: { id: locationId, siteId, deletedAt: null } });
    if (!loc || !loc.isActive) throw DomainError.notFound('Location');
    if (loc.blockedAt) throw DomainError.rule(ErrorCode.LOCATION_BLOCKED, `Location ${loc.code} is blocked`, { reason: loc.blockedReason });
    return loc;
  }

  private async assertRoom(tx: Tx, loc: { id: string; code: string; singleOccupancy: boolean; capacityUnits: unknown }, units: number) {
    const active = await tx.locationOccupancy.findMany({ where: { locationId: loc.id, releasedAt: null } });
    if (loc.singleOccupancy) {
      if (active.length > 0) {
        throw DomainError.conflict(ErrorCode.LOCATION_OCCUPIED, `Location ${loc.code} is already occupied or reserved`, {
          locationCode: loc.code,
          occupantType: active[0].occupantType,
          occupantId: active[0].occupantId,
        });
      }
      return;
    }
    const used = active.reduce((s, a) => s + Number(a.unitsUsed), 0);
    if (used + units > Number(loc.capacityUnits)) {
      throw DomainError.rule('LOCATION_CAPACITY_EXCEEDED', `Location ${loc.code} has no free capacity`, { used, capacity: Number(loc.capacityUnits) });
    }
  }
}

@Global()
@Module({
  providers: [OccupancyService, { provide: OCCUPANCY_READER, useExisting: OccupancyService }],
  exports: [OccupancyService, OCCUPANCY_READER],
})
export class OccupancyModule {}
