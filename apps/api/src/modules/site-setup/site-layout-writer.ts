import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PublishBlueprintResult } from '@waretrack/shared-schemas';
import { ErrorCode } from '@waretrack/shared-schemas';
import { uuidv7 } from 'uuidv7';
import { DomainError } from '../../platform/errors/domain-error';
import { OutboxService } from '../../platform/outbox/outbox.service';
import type { Tx } from '../../platform/prisma/prisma.service';
import type { LocationSpec, SiteLayoutSpec } from './layout/layout-spec';

const locationQrValue = (siteCode: string, locationCode: string) => `WT:LOC:${siteCode}:${locationCode}`;

/** Các object vẽ 3D của một layout version — cùng cấu trúc với seed demo để scene đọc giống nhau. */
export function layoutObjectRows(layoutVersionId: string, spec: SiteLayoutSpec, zoneIds: Map<string, string>, locationIds: Map<string, string>): Prisma.LayoutObjectCreateManyInput[] {
  return [
    ...spec.zones
      .filter((zone) => zone.color !== 'transparent')
      .map((zone) => ({
        layoutVersionId,
        targetType: 'ZONE' as const,
        targetId: zoneIds.get(zone.code)!,
        posX: zone.rect.x + zone.rect.w / 2,
        posZ: zone.rect.z + zone.rect.d / 2,
        sizeX: zone.rect.w,
        sizeY: 0.02,
        sizeZ: zone.rect.d,
        props: { color: zone.color, name: zone.name, zoneType: zone.zoneType },
      })),
    ...spec.locations
      .filter((location) => !location.noLayout)
      .map((location) => ({
        layoutVersionId,
        targetType: 'LOCATION' as const,
        targetId: locationIds.get(location.code)!,
        meshRef: `LOC:${location.code}`,
        posX: location.pos.x,
        posZ: location.pos.z,
        rotY: location.pos.rotY,
        sizeX: location.size.x,
        sizeY: 0.05,
        sizeZ: location.size.z,
        props: { code: location.code, locationType: location.type, label: location.label ?? location.code, display: location.display ?? null, levels: location.levels ?? null, bays: location.bays ?? null },
      })),
    ...spec.buildings.map((building) => ({
      layoutVersionId,
      targetType: 'BUILDING' as const,
      posX: building.rect.x + building.rect.w / 2,
      posZ: building.rect.z + building.rect.d / 2,
      sizeX: building.rect.w,
      sizeY: building.height,
      sizeZ: building.rect.d,
      props: { label: building.label, roofColor: building.roofColor, wallColor: building.wallColor, code: building.code, style: (building.style ?? null) as unknown as Prisma.InputJsonValue },
    })),
    ...spec.decor.map((decor) => ({
      layoutVersionId,
      targetType: 'DECOR' as const,
      posX: decor.x,
      posZ: decor.z,
      rotY: decor.rotY ?? 0,
      sizeX: decor.w ?? 1,
      sizeY: decor.h ?? 1,
      sizeZ: decor.d ?? 1,
      props: { kind: decor.kind, color: decor.color ?? null, label: decor.label ?? null, ...(decor.props ?? {}) } as Prisma.InputJsonValue,
    })),
  ];
}

/**
 * Ghi một layout đã biên dịch thành phiên bản PUBLISHED mới của site.
 * - Location giữ nguyên id theo mã (tồn kho, lịch sử, QR dán ngoài hiện trường vẫn đúng);
 * - Location bị bỏ khỏi bản thiết kế chỉ được rút khi trống (không có hàng, không có xe/pallet chiếm chỗ);
 * - Phiên bản PUBLISHED trước chuyển ARCHIVED, client nhận event layout.published để tải lại scene.
 */
@Injectable()
export class SiteLayoutWriter {
  constructor(private readonly outbox: OutboxService) {}

  async publish(tx: Tx, site: { id: string; code: string }, spec: SiteLayoutSpec, publishedById: string | null): Promise<PublishBlueprintResult> {
    const zoneIds = await this.syncZones(tx, site.id, spec);
    const { locationIds, created, updated, retired } = await this.syncLocations(tx, site, spec, zoneIds);

    const latest = await tx.layoutVersion.findFirst({ where: { siteId: site.id }, orderBy: { versionNo: 'desc' } });
    const versionNo = (latest?.versionNo ?? 0) + 1;
    await tx.layoutVersion.updateMany({ where: { siteId: site.id, status: 'PUBLISHED' }, data: { status: 'ARCHIVED' } });
    const layoutVersion = await tx.layoutVersion.create({
      data: {
        siteId: site.id,
        versionNo,
        status: 'PUBLISHED',
        boundsMinX: spec.bounds.minX,
        boundsMinZ: spec.bounds.minZ,
        boundsMaxX: spec.bounds.maxX,
        boundsMaxZ: spec.bounds.maxZ,
        publishedAt: new Date(),
        publishedById,
      },
    });
    await tx.layoutObject.createMany({ data: layoutObjectRows(layoutVersion.id, spec, zoneIds, locationIds) });
    await this.outbox.publish(tx, {
      siteId: site.id,
      type: 'layout.published',
      aggregateType: 'LayoutVersion',
      aggregateId: layoutVersion.id,
      aggregateVersion: versionNo,
      data: { versionId: layoutVersion.id, versionNo },
    });
    return { versionNo, locationsCreated: created, locationsUpdated: updated, locationsRetired: retired };
  }

  private async syncZones(tx: Tx, siteId: string, spec: SiteLayoutSpec) {
    const existing = await tx.zone.findMany({ where: { siteId } });
    const zoneIds = new Map(existing.map((zone) => [zone.code, zone.id]));
    for (const zoneSpec of spec.zones) {
      const current = existing.find((zone) => zone.code === zoneSpec.code);
      if (current) {
        if (current.deletedAt || current.name !== zoneSpec.name || current.zoneType !== zoneSpec.zoneType) {
          await tx.zone.update({ where: { id: current.id }, data: { name: zoneSpec.name, zoneType: zoneSpec.zoneType, deletedAt: null, version: { increment: 1 } } });
        }
      } else {
        const createdZone = await tx.zone.create({ data: { siteId, code: zoneSpec.code, name: zoneSpec.name, zoneType: zoneSpec.zoneType } });
        zoneIds.set(zoneSpec.code, createdZone.id);
      }
    }
    return zoneIds;
  }

  private async syncLocations(tx: Tx, site: { id: string; code: string }, spec: SiteLayoutSpec, zoneIds: Map<string, string>) {
    const duplicateCodes = spec.locations.map((location) => location.code).filter((code, index, all) => all.indexOf(code) !== index);
    if (duplicateCodes.length) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, `Duplicate location codes: ${[...new Set(duplicateCodes)].join(', ')}`);

    const existing = await tx.location.findMany({ where: { siteId: site.id }, include: { dock: true } });
    const existingByCode = new Map(existing.map((location) => [location.code, location]));
    const wantedCodes = new Set(spec.locations.map((location) => location.code));
    const locationIds = new Map<string, string>();
    let created = 0;
    let updated = 0;

    const newRows: Prisma.LocationCreateManyInput[] = [];
    const newDocks: Prisma.DockCreateManyInput[] = [];
    for (const locationSpec of spec.locations) {
      const current = existingByCode.get(locationSpec.code);
      const fields = this.locationFields(locationSpec, zoneIds);
      if (!current) {
        const id = uuidv7();
        newRows.push({ id, siteId: site.id, code: locationSpec.code, qrValue: locationQrValue(site.code, locationSpec.code), ...fields });
        if (locationSpec.type === 'DOCK') newDocks.push({ locationId: id, siteId: site.id, ...this.dockFields(locationSpec) });
        locationIds.set(locationSpec.code, id);
        created++;
        continue;
      }
      locationIds.set(locationSpec.code, current.id);
      if (current.locationType !== locationSpec.type && (await this.isInUse(tx, current.id))) {
        throw DomainError.rule('LOCATION_IN_USE', `${current.code} holds stock or a vehicle — empty it before changing its type`, { location: current.code });
      }
      await tx.location.update({ where: { id: current.id }, data: { ...fields, isActive: true, deletedAt: null, version: { increment: 1 } } });
      if (locationSpec.type === 'DOCK') {
        await tx.dock.upsert({ where: { locationId: current.id }, create: { locationId: current.id, siteId: site.id, ...this.dockFields(locationSpec) }, update: this.dockFields(locationSpec) });
      }
      updated++;
    }
    if (newRows.length) await tx.location.createMany({ data: newRows });
    if (newDocks.length) await tx.dock.createMany({ data: newDocks });

    let retired = 0;
    for (const location of existing) {
      if (wantedCodes.has(location.code) || location.deletedAt) continue;
      if (await this.isInUse(tx, location.id)) {
        throw DomainError.rule('LOCATION_IN_USE', `${location.code} holds stock or a vehicle — empty it before removing it from the layout`, { location: location.code });
      }
      await tx.location.update({ where: { id: location.id }, data: { isActive: false, deletedAt: new Date(), version: { increment: 1 } } });
      retired++;
    }
    return { locationIds, created, updated, retired };
  }

  private locationFields(locationSpec: LocationSpec, zoneIds: Map<string, string>) {
    return {
      zoneId: zoneIds.get(locationSpec.zone)!,
      name: locationSpec.label ?? null,
      locationType: locationSpec.type,
      capacityUnits: locationSpec.capacity,
      singleOccupancy: locationSpec.single,
      lengthM: locationSpec.lengthM ?? null,
      widthM: locationSpec.widthM ?? null,
    };
  }

  private dockFields(locationSpec: LocationSpec) {
    return { direction: locationSpec.dockDirection ?? 'BOTH', doorNumber: locationSpec.doorNumber ?? null, maxTruckLengthM: locationSpec.lengthM ?? null };
  }

  /** Location đang được dùng: có xe/pallet chiếm chỗ hoặc còn tồn kho. */
  private async isInUse(tx: Tx, locationId: string) {
    const activeOccupancy = await tx.locationOccupancy.count({ where: { locationId, releasedAt: null } });
    if (activeOccupancy > 0) return true;
    const stockedBalances = await tx.inventoryBalance.count({ where: { locationId, qtyOnHand: { gt: 0 } } });
    return stockedBalances > 0;
  }
}
