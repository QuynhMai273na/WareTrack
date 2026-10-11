import { z } from 'zod';
import { ExpectedVersion, IsoDateTime, ScanEvidence, Uuid } from './common';
import { ExitReason, TruckType, TruckVisitStatus, VisitDirection } from './enums';

export const TruckDto = z.object({
  id: Uuid,
  code: z.string(),
  plateNumber: z.string(),
  truckType: TruckType,
  carrier: z.object({ id: Uuid, code: z.string(), name: z.string() }).nullable(),
});
export type TruckDto = z.infer<typeof TruckDto>;

export const DriverDto = z.object({
  id: Uuid,
  fullName: z.string(),
  licenseNumber: z.string().nullable(),
  phone: z.string().nullable(),
});
export type DriverDto = z.infer<typeof DriverDto>;

export const VisitDock = z.object({ id: Uuid, code: z.string() });

export const VisitRow = z.object({
  id: Uuid,
  siteId: Uuid,
  code: z.string(),
  status: TruckVisitStatus,
  direction: VisitDirection,
  unscheduled: z.boolean(),
  truck: TruckDto,
  driver: DriverDto.nullable(),
  dock: VisitDock.nullable(),
  appointmentStart: IsoDateTime.nullable(),
  appointmentEnd: IsoDateTime.nullable(),
  etaAt: IsoDateTime.nullable(),
  arrivedAt: IsoDateTime.nullable(),
  verifiedAt: IsoDateTime.nullable(),
  dockedAt: IsoDateTime.nullable(),
  handlingStartedAt: IsoDateTime.nullable(),
  readyAt: IsoDateTime.nullable(),
  exitedAt: IsoDateTime.nullable(),
  exitReason: ExitReason.nullable(),
  actualPlate: z.string().nullable(),
  version: z.number(),
});
export type VisitRow = z.infer<typeof VisitRow>;

export const VisitTimelineEntry = z.object({
  at: IsoDateTime,
  action: z.string(),
  actor: z.string().nullable(),
  note: z.string().nullable(),
});

export const VisitDetail = VisitRow.extend({
  sealIn: z.string().nullable(),
  sealOut: z.string().nullable(),
  rejectReason: z.string().nullable(),
  timeline: z.array(VisitTimelineEntry),
});
export type VisitDetail = z.infer<typeof VisitDetail>;

export const CreateVisitRequest = z
  .object({
    truckId: Uuid,
    driverId: Uuid.optional(),
    direction: VisitDirection,
    appointmentStart: IsoDateTime,
    appointmentEnd: IsoDateTime,
    etaAt: IsoDateTime.optional(),
  })
  .strict()
  .refine((request) => new Date(request.appointmentEnd) > new Date(request.appointmentStart), {
    message: 'appointmentEnd must be after appointmentStart',
    path: ['appointmentEnd'],
  });
export type CreateVisitRequest = z.infer<typeof CreateVisitRequest>;

export const ArriveRequest = z
  .object({
    actualPlate: z.string().min(2).max(20),
    driverId: Uuid.optional(),
    sealIn: z.string().max(40).optional(),
    lateReason: z.string().max(200).optional(),
    expectedVersion: ExpectedVersion,
  })
  .strict();
export type ArriveRequest = z.infer<typeof ArriveRequest>;

export const DocumentCheck = z.object({ key: z.string(), passed: z.boolean(), note: z.string().optional() });

export const VerifyRequest = z
  .object({
    documentChecks: z.array(DocumentCheck),
    expectedVersion: ExpectedVersion,
  })
  .strict();
export type VerifyRequest = z.infer<typeof VerifyRequest>;

export const ReasonRequest = z
  .object({
    reason: z.string().min(3).max(300),
    expectedVersion: ExpectedVersion,
  })
  .strict();
export type ReasonRequest = z.infer<typeof ReasonRequest>;

export const WalkInRequest = z
  .object({
    truckId: Uuid.optional(),
    newTruck: z
      .object({ plateNumber: z.string().min(2).max(20), carrierId: Uuid.optional(), truckType: TruckType })
      .optional(),
    driverId: Uuid.optional(),
    direction: VisitDirection,
    actualPlate: z.string().min(2).max(20),
    reason: z.string().min(3).max(300),
  })
  .strict()
  .refine((request) => !!request.truckId !== !!request.newTruck, { message: 'Provide exactly one of truckId or newTruck', path: ['truckId'] });
export type WalkInRequest = z.infer<typeof WalkInRequest>;

export const AssignDockRequest = z.object({ dockLocationId: Uuid, expectedVersion: ExpectedVersion }).strict();
export type AssignDockRequest = z.infer<typeof AssignDockRequest>;

export const VersionOnlyRequest = z
  .object({ expectedVersion: ExpectedVersion, reason: z.string().max(300).optional() })
  .strict();
export type VersionOnlyRequest = z.infer<typeof VersionOnlyRequest>;

export const ArriveAtDockRequest = z.object({ scan: ScanEvidence, expectedVersion: ExpectedVersion }).strict();
export type ArriveAtDockRequest = z.infer<typeof ArriveAtDockRequest>;

export const GateOutRequest = z
  .object({ sealOut: z.string().max(40).optional(), expectedVersion: ExpectedVersion })
  .strict();
export type GateOutRequest = z.infer<typeof GateOutRequest>;

export const GateLookupResult = z.object({ visits: z.array(VisitRow) });
export type GateLookupResult = z.infer<typeof GateLookupResult>;

/** Checklist giấy tờ gate-in mặc định (DEC-20). */
export const DEFAULT_GATE_DOCUMENT_CHECKLIST = [
  { key: 'PLATE_MATCH', vi: 'Biển số khớp', en: 'Plate matches' },
  { key: 'DRIVER_ID', vi: 'Giấy tờ tài xế', en: 'Driver ID' },
  { key: 'TRANSPORT_ORDER', vi: 'Lệnh vận chuyển', en: 'Transport order' },
] as const;
