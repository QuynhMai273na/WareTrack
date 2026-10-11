import { Inject, Injectable } from '@nestjs/common';
import type { Dock, Location, Zone } from '@prisma/client';
import type { EffectiveLocationStatus, LocationDto, PublishedLayout, SiteSummary } from '@waretrack/shared-schemas';
import { ErrorCode } from '@waretrack/shared-schemas';
import { AuditService } from '../../platform/audit/audit.service';
import { DomainError } from '../../platform/errors/domain-error';
import { LocationLockPort } from '../../platform/locks/location-lock';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { PrismaService, type Tx, TxRunner, updateWithVersion } from '../../platform/prisma/prisma.service';
import { type ActiveOccupancy, OCCUPANCY_READER, type OccupancyReader } from './occupancy-reader.port';
import { isSettingKey, SITE_SETTING_DEFAULTS, SITE_SETTING_SCHEMAS, type SiteSettings } from './site-settings';

type LocationWithRefs = Location & { zone: Zone; dock: Dock | null };

/** Trạng thái hiệu lực = block + occupancy; không lưu cột status riêng (mục 9.3, 9.4). */
export function effectiveStatus(loc: Location, occ: ActiveOccupancy[]): { status: EffectiveLocationStatus; unitsUsed: number } {
  const unitsUsed = occ.reduce((sum, occupancy) => sum + occupancy.unitsUsed, 0);
  if (loc.blockedAt) return { status: loc.locationType === 'DOCK' ? 'OUT_OF_SERVICE' : 'BLOCKED', unitsUsed };
  if (loc.singleOccupancy) {
    if (occ.some((occupancy) => occupancy.kind === 'OCCUPIED')) return { status: 'OCCUPIED', unitsUsed };
    if (occ.some((occupancy) => occupancy.kind === 'RESERVED')) return { status: 'RESERVED', unitsUsed };
    return { status: 'AVAILABLE', unitsUsed };
  }
  return { status: unitsUsed >= Number(loc.capacityUnits) ? 'OCCUPIED' : 'AVAILABLE', unitsUsed };
}

export function toLocationDto(loc: LocationWithRefs, occ: ActiveOccupancy[]): LocationDto {
  const eff = effectiveStatus(loc, occ);
  return {
    id: loc.id,
    siteId: loc.siteId,
    zoneId: loc.zoneId,
    zoneCode: loc.zone.code,
    code: loc.code,
    name: loc.name,
    qrValue: loc.qrValue,
    locationType: loc.locationType,
    capacityUnits: Number(loc.capacityUnits),
    singleOccupancy: loc.singleOccupancy,
    isActive: loc.isActive,
    blockedAt: loc.blockedAt?.toISOString() ?? null,
    blockedReason: loc.blockedReason,
    effectiveStatus: eff.status,
    unitsUsed: eff.unitsUsed,
    dockDirection: loc.dock?.direction ?? null,
    version: loc.version,
  };
}

@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TxRunner,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly locks: LocationLockPort,
    @Inject(OCCUPANCY_READER) private readonly occupancy: OccupancyReader,
  ) {}

  async listSites(siteIds: string[]): Promise<SiteSummary[]> {
    const sites = await this.prisma.site.findMany({ where: { id: { in: siteIds }, deletedAt: null }, orderBy: { code: 'asc' } });
    return Promise.all(sites.map(async (site) => ({ ...this.siteBase(site), fill: await this.fill(site.id) })));
  }

  async getSite(siteId: string) {
    const site = await this.prisma.site.findFirst({ where: { id: siteId, deletedAt: null } });
    if (!site) throw DomainError.notFound('Site');
    return { ...this.siteBase(site), fill: await this.fill(siteId) };
  }

  private siteBase(site: { id: string; code: string; name: string; siteType: SiteSummary['siteType']; timezone: string; addressLine: string | null; operationalStatus: string; mapX: number; mapZ: number }) {
    return { id: site.id, code: site.code, name: site.name, siteType: site.siteType, timezone: site.timezone, addressLine: site.addressLine, operationalStatus: site.operationalStatus, map: { x: site.mapX, z: site.mapZ } };
  }

  /** Site fill (DEC-13): vị trí pallet cho kho, ô đỗ cho bãi xe, dock riêng — không cộng gộp đơn vị (BR-31). */
  private async fill(siteId: string) {
    const locations = await this.prisma.location.findMany({
      where: { siteId, deletedAt: null, isActive: true, locationType: { in: ['STORAGE', 'PARKING_SLOT', 'DOCK'] } },
    });
    const occ = await this.occupancy.activeByLocations(siteId);
    let palletPositionsUsed = 0, palletPositionsTotal = 0, slotsUsed = 0, slotsTotal = 0, docksOccupied = 0, docksTotal = 0;
    for (const location of locations) {
      const occupancies = occ.get(location.id) ?? [];
      if (location.locationType === 'STORAGE') {
        if (!location.blockedAt) palletPositionsTotal += Number(location.capacityUnits);
        palletPositionsUsed += occupancies.filter((occupancy) => occupancy.kind === 'OCCUPIED').reduce((sum, occupancy) => sum + occupancy.unitsUsed, 0);
      } else if (location.locationType === 'PARKING_SLOT') {
        if (!location.blockedAt) slotsTotal += 1;
        if (occupancies.length > 0) slotsUsed += 1;
      } else {
        if (!location.blockedAt) docksTotal += 1;
        if (occupancies.some((occupancy) => occupancy.kind === 'OCCUPIED')) docksOccupied += 1;
      }
    }
    const inbound = await this.prisma.truckVisit.count({ where: { siteId, status: 'SCHEDULED', etaAt: { lte: new Date(Date.now() + 2 * 3600_000) } } });
    return { palletPositionsUsed, palletPositionsTotal, slotsUsed, slotsTotal, docksOccupied, docksTotal, inbound };
  }

  async listZones(siteId: string) {
    const zones = await this.prisma.zone.findMany({ where: { siteId, deletedAt: null }, orderBy: { code: 'asc' } });
    return zones.map((zone) => ({ id: zone.id, code: zone.code, name: zone.name, zoneType: zone.zoneType }));
  }

  async listLocations(siteId: string, filter: { zoneId?: string; type?: string; q?: string }): Promise<LocationDto[]> {
    const locations = await this.prisma.location.findMany({
      where: {
        siteId,
        deletedAt: null,
        ...(filter.zoneId ? { zoneId: filter.zoneId } : {}),
        ...(filter.type ? { locationType: { in: filter.type.split(',') as Location['locationType'][] } } : {}),
        ...(filter.q ? { code: { contains: filter.q, mode: 'insensitive' as const } } : {}),
      },
      include: { zone: true, dock: true },
      orderBy: { code: 'asc' },
    });
    const occ = await this.occupancy.activeByLocations(siteId);
    return locations.map((location) => toLocationDto(location, occ.get(location.id) ?? []));
  }

  async getLocation(siteId: string, locationId: string): Promise<LocationDto> {
    const loc = await this.prisma.location.findFirst({ where: { id: locationId, siteId, deletedAt: null }, include: { zone: true, dock: true } });
    if (!loc) throw DomainError.notFound('Location');
    const occ = await this.occupancy.activeByLocations(siteId, [loc.id]);
    return toLocationDto(loc, occ.get(loc.id) ?? []);
  }

  async resolveQr(siteId: string, qr: string): Promise<LocationDto> {
    const loc = await this.prisma.location.findFirst({ where: { qrValue: qr, siteId, deletedAt: null } });
    if (!loc) throw DomainError.notFound('Location');
    return this.getLocation(siteId, loc.id);
  }

  /** Block location (FR-02.05, BR-16): chỉ khi không còn occupancy active. */
  async block(siteId: string, locationId: string, reason: string): Promise<LocationDto> {
    await this.tx.run(async (tx) => {
      await this.locks.lockForUpdate(tx, [locationId]);
      const loc = await this.requireLocation(tx, siteId, locationId);
      if (loc.blockedAt) throw DomainError.invalidTransition('Location', 'BLOCKED', 'BLOCKED');
      const occ = (await this.occupancy.activeByLocations(siteId, [locationId], tx)).get(locationId) ?? [];
      if (occ.length > 0) throw DomainError.rule(ErrorCode.LOCATION_NOT_EMPTY, 'Location still has an active occupant or reservation');
      await updateWithVersion(tx.location, { id: locationId }, loc.version, { blockedAt: new Date(), blockedReason: reason });
      await this.audit.record(tx, { siteId, action: 'LOCATION_BLOCKED', entityType: 'Location', entityId: locationId, reason });
      await this.emitLocationStatus(tx, siteId, locationId);
    });
    return this.getLocation(siteId, locationId);
  }

  async unblock(siteId: string, locationId: string, reason?: string): Promise<LocationDto> {
    await this.tx.run(async (tx) => {
      await this.locks.lockForUpdate(tx, [locationId]);
      const loc = await this.requireLocation(tx, siteId, locationId);
      if (!loc.blockedAt) throw DomainError.invalidTransition('Location', 'AVAILABLE', 'AVAILABLE');
      await updateWithVersion(tx.location, { id: locationId }, loc.version, { blockedAt: null, blockedReason: null });
      await this.audit.record(tx, { siteId, action: 'LOCATION_UNBLOCKED', entityType: 'Location', entityId: locationId, reason: reason ?? null });
      await this.emitLocationStatus(tx, siteId, locationId);
    });
    return this.getLocation(siteId, locationId);
  }

  /**
   * Phát dock.status_changed / slot.status_changed với trạng thái hiệu lực hiện tại.
   * Gọi trong transaction bởi bất kỳ lệnh nào làm đổi block hoặc occupancy của location.
   */
  async emitLocationStatus(tx: Tx, siteId: string, locationId: string): Promise<void> {
    const loc = await tx.location.findUniqueOrThrow({ where: { id: locationId }, include: { zone: true, dock: true } });
    if (!['DOCK', 'PARKING_SLOT', 'YARD_SLOT'].includes(loc.locationType)) return;
    const occ = (await this.occupancy.activeByLocations(siteId, [locationId], tx)).get(locationId) ?? [];
    const eff = effectiveStatus(loc, occ);
    const current = occ.find((occupancy) => occupancy.kind === 'OCCUPIED') ?? occ[0];
    await this.outbox.publish(tx, {
      siteId,
      type: loc.locationType === 'DOCK' ? 'dock.status_changed' : 'slot.status_changed',
      aggregateType: 'Location',
      aggregateId: loc.id,
      aggregateVersion: loc.version,
      data: {
        locationId: loc.id,
        code: loc.code,
        locationType: loc.locationType,
        direction: loc.dock?.direction ?? null,
        effectiveStatus: eff.status,
        occupantType: current?.occupantType ?? null,
        occupantId: current?.occupantId ?? null,
        visitId: current?.occupantType === 'TRUCK_VISIT' ? current.occupantId : null,
        locationVersion: loc.version,
      },
    });
  }

  /** LocationFreezePort (mục 13.2): khóa location trong đợt kiểm kê (DEC-16). */
  async freeze(tx: Tx, siteId: string, locationIds: string[], countId: string): Promise<void> {
    if (locationIds.length === 0) return;
    await this.locks.lockForUpdate(tx, locationIds);
    const frozen = await tx.location.findMany({ where: { id: { in: locationIds }, frozenByCountId: { not: null } } });
    if (frozen.length > 0) throw DomainError.rule(ErrorCode.LOCATION_FROZEN, `Location ${frozen[0].code} is already frozen by another count`);
    await tx.location.updateMany({ where: { id: { in: locationIds }, siteId }, data: { frozenByCountId: countId, version: { increment: 1 } } });
  }

  async unfreeze(tx: Tx, countId: string): Promise<void> {
    await tx.location.updateMany({ where: { frozenByCountId: countId }, data: { frozenByCountId: null, version: { increment: 1 } } });
  }

  async assertNotFrozen(tx: Tx, locationId: string): Promise<void> {
    const loc = await tx.location.findUnique({ where: { id: locationId } });
    if (loc?.frozenByCountId) throw DomainError.rule(ErrorCode.LOCATION_FROZEN, `Location ${loc.code} is frozen for stocktaking`);
  }

  async requireLocation(tx: Tx, siteId: string, locationId: string) {
    const loc = await tx.location.findFirst({ where: { id: locationId, siteId, deletedAt: null }, include: { dock: true } });
    if (!loc) throw DomainError.notFound('Location');
    return loc;
  }

  async publishedLayout(siteId: string): Promise<PublishedLayout> {
    const layout = await this.prisma.layoutVersion.findFirst({ where: { siteId, status: 'PUBLISHED' }, include: { objects: true } });
    if (!layout) throw DomainError.notFound('Published layout');
    return {
      versionId: layout.id,
      versionNo: layout.versionNo,
      modelUrl: null,
      bounds: { minX: layout.boundsMinX, minZ: layout.boundsMinZ, maxX: layout.boundsMaxX, maxZ: layout.boundsMaxZ },
      objects: layout.objects.map((layoutObject) => ({
        id: layoutObject.id,
        targetType: layoutObject.targetType,
        targetId: layoutObject.targetId,
        meshRef: layoutObject.meshRef,
        posX: layoutObject.posX,
        posY: layoutObject.posY,
        posZ: layoutObject.posZ,
        rotY: layoutObject.rotY,
        sizeX: layoutObject.sizeX,
        sizeY: layoutObject.sizeY,
        sizeZ: layoutObject.sizeZ,
        props: (layoutObject.props as Record<string, unknown> | null) ?? null,
      })),
    };
  }

  async settings(siteId: string, tx?: Tx): Promise<SiteSettings> {
    const rows = await (tx ?? this.prisma).siteSetting.findMany({ where: { siteId } });
    const merged: Record<string, unknown> = { ...SITE_SETTING_DEFAULTS };
    for (const row of rows) if (isSettingKey(row.key)) merged[row.key] = row.value;
    return merged as SiteSettings;
  }

  async putSetting(siteId: string, key: string, value: unknown) {
    if (!isSettingKey(key)) throw DomainError.notFound('Setting');
    const parsed = SITE_SETTING_SCHEMAS[key].safeParse(value);
    if (!parsed.success) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, parsed.error.issues.map((issue) => issue.message).join('; '));
    await this.tx.run(async (tx) => {
      await tx.siteSetting.upsert({
        where: { siteId_key: { siteId, key } },
        create: { siteId, key, value: parsed.data as object },
        update: { value: parsed.data as object },
      });
      await this.audit.record(tx, { siteId, action: 'SITE_SETTING_CHANGED', entityType: 'SiteSetting', entityId: `${siteId}:${key}`, diff: { after: { [key]: parsed.data } } });
    });
    return { key, value: parsed.data };
  }
}
