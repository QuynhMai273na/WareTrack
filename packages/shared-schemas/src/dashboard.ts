import { z } from 'zod';
import { IsoDateTime, PositionSource, Uuid } from './common';
import { DockDirection, EffectiveLocationStatus, EquipmentStatus, EquipmentType, TruckType, TruckVisitStatus, VisitDirection } from './enums';

export const KpiDto = z.object({
  key: z.string(),
  value: z.number().nullable(),
  unit: z.string(),
  total: z.number().nullable().optional(),
  delta: z.number().nullable().optional(),
  deltaPeriod: z.string().optional(),
  sub: z.record(z.number()).optional(),
  asOf: IsoDateTime,
});
export type KpiDto = z.infer<typeof KpiDto>;

export const SnapshotPosition = z.object({
  locationId: Uuid.nullable(),
  source: PositionSource,
  confirmedAt: IsoDateTime,
});
export type SnapshotPosition = z.infer<typeof SnapshotPosition>;

export const SnapshotDock = z.object({
  locationId: Uuid,
  code: z.string(),
  direction: DockDirection,
  effectiveStatus: EffectiveLocationStatus,
  visitId: Uuid.nullable(),
  version: z.number(),
});
export type SnapshotDock = z.infer<typeof SnapshotDock>;

export const SnapshotSlot = z.object({
  locationId: Uuid,
  code: z.string(),
  locationType: z.string(),
  effectiveStatus: EffectiveLocationStatus,
  occupantType: z.string().nullable(),
  occupantId: Uuid.nullable(),
});
export type SnapshotSlot = z.infer<typeof SnapshotSlot>;

export const SnapshotTruck = z.object({
  visitId: Uuid,
  code: z.string(),
  truckCode: z.string(),
  plate: z.string(),
  carrier: z.string().nullable(),
  truckType: TruckType,
  direction: VisitDirection,
  status: TruckVisitStatus,
  dockLocationId: Uuid.nullable(),
  position: SnapshotPosition.nullable(),
  etaAt: IsoDateTime.nullable(),
  version: z.number(),
});
export type SnapshotTruck = z.infer<typeof SnapshotTruck>;

export const SnapshotForklift = z.object({
  id: Uuid,
  code: z.string(),
  equipmentType: EquipmentType,
  model: z.string().nullable(),
  status: EquipmentStatus,
  taskSummary: z.string().nullable(),
  position: SnapshotPosition.nullable(),
  batteryPct: z.number().nullable(),
  telemetryAt: IsoDateTime.nullable(),
  version: z.number(),
});
export type SnapshotForklift = z.infer<typeof SnapshotForklift>;

export const SnapshotPallet = z.object({
  id: Uuid,
  code: z.string(),
  label: z.string(),
  lifecycle: z.string(),
  stockStatus: z.string().nullable(),
  position: SnapshotPosition.nullable(),
  version: z.number(),
});
export type SnapshotPallet = z.infer<typeof SnapshotPallet>;

export const SnapshotVehicle = z.object({
  stayId: Uuid,
  vin: z.string(),
  label: z.string(),
  status: z.string(),
  condition: z.string(),
  hold: z.boolean(),
  position: SnapshotPosition.nullable(),
  version: z.number(),
});
export type SnapshotVehicle = z.infer<typeof SnapshotVehicle>;

export const SnapshotShipment = z.object({
  id: Uuid,
  code: z.string(),
  direction: z.string(),
  status: z.string(),
  visitId: Uuid.nullable(),
  progress: z.object({ done: z.number(), total: z.number() }),
  version: z.number(),
});
export type SnapshotShipment = z.infer<typeof SnapshotShipment>;

export const SiteSnapshot = z.object({
  site: z.object({ id: Uuid, code: z.string(), name: z.string(), timezone: z.string(), siteType: z.string() }),
  asOfSeq: z.number().int(),
  asOf: IsoDateTime,
  layoutVersionId: Uuid.nullable(),
  kpis: z.array(KpiDto),
  docks: z.array(SnapshotDock),
  slots: z.array(SnapshotSlot),
  trucks: z.array(SnapshotTruck),
  forklifts: z.array(SnapshotForklift),
  pallets: z.array(SnapshotPallet),
  vehicles: z.array(SnapshotVehicle),
  activeShipments: z.array(SnapshotShipment),
});
export type SiteSnapshot = z.infer<typeof SiteSnapshot>;

export const SearchResult = z.object({
  type: z.enum(['site', 'truck', 'forklift', 'pallet', 'shipment', 'vehicle', 'location']),
  id: Uuid,
  code: z.string(),
  label: z.string(),
  siteId: Uuid.nullable(),
  siteCode: z.string().nullable(),
});
export type SearchResult = z.infer<typeof SearchResult>;
