import { z } from 'zod';
import { IsoDateTime, Uuid } from './common';
import { DockDirection, EffectiveLocationStatus, LocationType, SiteType, ZoneType } from './enums';

export const SiteSummary = z.object({
  id: Uuid,
  code: z.string(),
  name: z.string(),
  siteType: SiteType,
  timezone: z.string(),
  addressLine: z.string().nullable(),
  operationalStatus: z.string(),
  /** Gốc tọa độ của site trên bản đồ mạng lưới chung (mét). */
  map: z.object({ x: z.number(), z: z.number() }).optional(),
  fill: z
    .object({
      palletPositionsUsed: z.number(),
      palletPositionsTotal: z.number(),
      slotsUsed: z.number(),
      slotsTotal: z.number(),
      docksOccupied: z.number(),
      docksTotal: z.number(),
      inbound: z.number().optional(),
    })
    .optional(),
});
export type SiteSummary = z.infer<typeof SiteSummary>;

export const ZoneDto = z.object({
  id: Uuid,
  code: z.string(),
  name: z.string(),
  zoneType: ZoneType,
});
export type ZoneDto = z.infer<typeof ZoneDto>;

export const LocationDto = z.object({
  id: Uuid,
  siteId: Uuid,
  zoneId: Uuid,
  zoneCode: z.string(),
  code: z.string(),
  qrValue: z.string(),
  locationType: LocationType,
  capacityUnits: z.number(),
  singleOccupancy: z.boolean(),
  isActive: z.boolean(),
  blockedAt: IsoDateTime.nullable(),
  blockedReason: z.string().nullable(),
  effectiveStatus: EffectiveLocationStatus,
  unitsUsed: z.number(),
  dockDirection: DockDirection.nullable(),
  version: z.number(),
});
export type LocationDto = z.infer<typeof LocationDto>;

export const BlockLocationRequest = z.object({ reason: z.string().min(3).max(200) }).strict();
export const UnblockLocationRequest = z.object({ reason: z.string().max(200).optional() }).strict();

/** Đối tượng layout 3D (mục 18.1, 18.2) — tọa độ site-local, mét, Y-up. */
export const LayoutObjectDto = z.object({
  id: Uuid,
  targetType: z.enum(['ZONE', 'LOCATION', 'BUILDING', 'DECOR']),
  targetId: Uuid.nullable(),
  meshRef: z.string().nullable(),
  posX: z.number(),
  posY: z.number(),
  posZ: z.number(),
  rotY: z.number(),
  sizeX: z.number(),
  sizeY: z.number(),
  sizeZ: z.number(),
  props: z.record(z.unknown()).nullable(),
});
export type LayoutObjectDto = z.infer<typeof LayoutObjectDto>;

export const PublishedLayout = z.object({
  versionId: Uuid,
  versionNo: z.number(),
  modelUrl: z.string().nullable(),
  bounds: z.object({ minX: z.number(), minZ: z.number(), maxX: z.number(), maxZ: z.number() }),
  objects: z.array(LayoutObjectDto),
});
export type PublishedLayout = z.infer<typeof PublishedLayout>;
