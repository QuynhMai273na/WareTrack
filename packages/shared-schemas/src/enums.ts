import { z } from 'zod';

export const SiteType = z.enum(['DEPOT', 'DISTRIBUTION_CENTER', 'CROSS_DOCK', 'COLD_STORE', 'AUTOMATED_DC', 'VEHICLE_YARD', 'MIXED']);
export type SiteType = z.infer<typeof SiteType>;

export const ZoneType = z.enum(['YARD', 'WAREHOUSE', 'STAGING', 'QUARANTINE', 'VEHICLE_STORAGE', 'GATE_AREA', 'CHARGING']);
export type ZoneType = z.infer<typeof ZoneType>;

export const LocationType = z.enum([
  'STORAGE',
  'PARKING_SLOT',
  'DOCK',
  'GATE_LANE',
  'STAGING',
  'QUARANTINE',
  'YARD_SLOT',
  'CHARGER',
]);
export type LocationType = z.infer<typeof LocationType>;

/** Trạng thái hiệu lực của location — dẫn xuất từ block + occupancy (mục 9.3, 9.4). */
export const EffectiveLocationStatus = z.enum(['AVAILABLE', 'RESERVED', 'OCCUPIED', 'BLOCKED', 'OUT_OF_SERVICE']);
export type EffectiveLocationStatus = z.infer<typeof EffectiveLocationStatus>;

export const DockDirection = z.enum(['INBOUND', 'OUTBOUND', 'BOTH']);
export type DockDirection = z.infer<typeof DockDirection>;

export const VisitDirection = z.enum(['INBOUND', 'OUTBOUND', 'BOTH']);
export type VisitDirection = z.infer<typeof VisitDirection>;

export const TruckType = z.enum(['BOX', 'REEFER', 'FLATBED', 'CAR_CARRIER', 'CONTAINER']);
export type TruckType = z.infer<typeof TruckType>;

/** Truck Visit — 11 trạng thái (mục 9.1, DEC-24). */
export const TruckVisitStatus = z.enum([
  'SCHEDULED',
  'AT_GATE',
  'WAITING',
  'DOCK_ASSIGNED',
  'AT_DOCK',
  'HANDLING',
  'READY_TO_LEAVE',
  'EXITED',
  'REJECTED',
  'NO_SHOW',
  'CANCELLED',
]);
export type TruckVisitStatus = z.infer<typeof TruckVisitStatus>;

export const ACTIVE_VISIT_STATUSES: TruckVisitStatus[] = [
  'SCHEDULED',
  'AT_GATE',
  'WAITING',
  'DOCK_ASSIGNED',
  'AT_DOCK',
  'HANDLING',
  'READY_TO_LEAVE',
];

/** Trạng thái được tính là "on site" (BR-32). */
export const ON_SITE_VISIT_STATUSES: TruckVisitStatus[] = [
  'AT_GATE',
  'WAITING',
  'DOCK_ASSIGNED',
  'AT_DOCK',
  'HANDLING',
  'READY_TO_LEAVE',
];

export const ExitReason = z.enum(['COMPLETED', 'ABORTED', 'REJECTED_GOODS', 'EMERGENCY']);
export type ExitReason = z.infer<typeof ExitReason>;

/** Forklift / equipment (mục 9.7, DEC-27). */
export const EquipmentStatus = z.enum(['OFFLINE', 'AVAILABLE', 'ASSIGNED', 'BUSY', 'CHARGING', 'MAINTENANCE']);
export type EquipmentStatus = z.infer<typeof EquipmentStatus>;

export const EquipmentType = z.enum(['FORKLIFT', 'REACH_TRUCK', 'PALLET_JACK', 'TUG']);
export type EquipmentType = z.infer<typeof EquipmentType>;

export const OccupantType = z.enum(['TRUCK_VISIT', 'VEHICLE_STAY', 'HANDLING_UNIT', 'EQUIPMENT']);
export type OccupantType = z.infer<typeof OccupantType>;
