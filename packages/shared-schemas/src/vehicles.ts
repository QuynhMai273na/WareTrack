import { z } from 'zod';
import { ExpectedVersion, IsoDateTime, PositionSource, ScanEvidence, Uuid } from './common';

/** VIN: 17 ký tự, không I/O/Q (FR-03.06, DEC-22). */
export const Vin = z
  .string()
  .transform((v) => v.trim().toUpperCase())
  .pipe(z.string().regex(/^[A-HJ-NPR-Z0-9]{17}$/, 'VIN must be 17 characters without I, O, Q'));

const TRANSLIT: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** Check digit vị trí 9 (chuẩn Bắc Mỹ) — sai chỉ cảnh báo, không chặn (DEC-22). */
export function vinCheckDigit(vin: string): string {
  const sum = vin
    .toUpperCase()
    .split('')
    .reduce((s, ch, i) => s + (/\d/.test(ch) ? Number(ch) : (TRANSLIT[ch] ?? 0)) * WEIGHTS[i], 0);
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}

export function vinCheckDigitValid(vin: string): boolean {
  return vin.length === 17 && vin[8].toUpperCase() === vinCheckDigit(vin);
}

export const VehicleStayStatus = z.enum(['EXPECTED', 'RECEIVED', 'INSPECTED', 'ALLOCATED', 'STORED', 'RELEASE_REQUESTED', 'RELEASED', 'EXITED', 'CANCELLED']);
export type VehicleStayStatus = z.infer<typeof VehicleStayStatus>;

export const VehicleCondition = z.enum(['OK', 'MINOR_DAMAGE', 'MAJOR_DAMAGE', 'NEEDS_SERVICE']);
export type VehicleCondition = z.infer<typeof VehicleCondition>;

export const VehicleStayDto = z.object({
  id: Uuid,
  siteId: Uuid,
  vehicle: z.object({ id: Uuid, vin: z.string(), make: z.string().nullable(), model: z.string().nullable(), modelYear: z.number().nullable(), color: z.string().nullable(), plateNumber: z.string().nullable() }),
  owner: z.object({ id: Uuid, name: z.string() }).nullable(),
  status: VehicleStayStatus,
  conditionStatus: VehicleCondition,
  holdFlag: z.boolean(),
  holdReason: z.string().nullable(),
  odometerKm: z.number().nullable(),
  fuelOrBatteryPct: z.number().nullable(),
  keyTag: z.string().nullable(),
  position: z.object({ location: z.object({ id: Uuid, code: z.string(), type: z.string() }).nullable(), kind: z.enum(['RESERVED', 'OCCUPIED']).nullable(), source: PositionSource.nullable(), confirmedAt: IsoDateTime.nullable() }),
  releaseRequest: z.object({ id: Uuid, status: z.string(), reason: z.string(), recipientName: z.string(), requestedBy: z.string(), version: z.number() }).nullable(),
  expectedAt: IsoDateTime.nullable(),
  receivedAt: IsoDateTime.nullable(),
  storedAt: IsoDateTime.nullable(),
  releasedAt: IsoDateTime.nullable(),
  exitedAt: IsoDateTime.nullable(),
  openTask: z.object({ id: Uuid, code: z.string(), status: z.string(), toCode: z.string().nullable() }).nullable(),
  version: z.number(),
});
export type VehicleStayDto = z.infer<typeof VehicleStayDto>;

export const VehicleHistoryEntry = z.object({ at: IsoDateTime, action: z.string(), detail: z.string().nullable(), actor: z.string().nullable(), site: z.string().nullable() });
export type VehicleHistoryEntry = z.infer<typeof VehicleHistoryEntry>;

export const CreateStayRequest = z
  .object({
    vin: Vin,
    make: z.string().max(40).optional(),
    model: z.string().max(60).optional(),
    modelYear: z.number().int().min(1950).max(2100).optional(),
    color: z.string().max(30).optional(),
    plateNumber: z.string().max(20).optional(),
    ownerPartnerId: Uuid.optional(),
    expectedAt: IsoDateTime.optional(),
    acceptCheckDigit: z.boolean().optional(),
  })
  .strict();
export type CreateStayRequest = z.infer<typeof CreateStayRequest>;

export const ReceiveVehicleRequest = z
  .object({ scan: ScanEvidence, odometerKm: z.number().int().min(0).optional(), fuelOrBatteryPct: z.number().int().min(0).max(100).optional(), keyTag: z.string().max(20).optional(), expectedVersion: ExpectedVersion })
  .strict();
export type ReceiveVehicleRequest = z.infer<typeof ReceiveVehicleRequest>;

export const InspectionRequest = z
  .object({
    inspectionType: z.enum(['RECEIVING', 'PERIODIC', 'RELEASE']).default('RECEIVING'),
    checklist: z.array(z.object({ key: z.string(), passed: z.boolean(), note: z.string().max(200).optional() })),
    resultCondition: VehicleCondition,
    setHold: z.object({ reason: z.string().min(3).max(200) }).optional(),
    expectedVersion: ExpectedVersion,
  })
  .strict();
export type InspectionRequest = z.infer<typeof InspectionRequest>;

export const AllocateSlotRequest = z.object({ slotLocationId: Uuid, expectedVersion: ExpectedVersion }).strict();
export const ConfirmParkedRequest = z.object({ scan: ScanEvidence, expectedVersion: ExpectedVersion }).strict();
export const MoveVehicleRequest = z.object({ toLocationId: Uuid, reason: z.string().min(3).max(200) }).strict();
export const HoldRequest = z.object({ reason: z.string().min(3).max(200), expectedVersion: ExpectedVersion }).strict();
export const ReleaseRequestBody = z.object({ reason: z.string().min(3).max(200), recipientName: z.string().min(2).max(120), plannedAt: IsoDateTime.optional() }).strict();
export const VehicleVersionRequest = z.object({ expectedVersion: ExpectedVersion, note: z.string().max(300).optional() }).strict();
