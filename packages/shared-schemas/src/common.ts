import { z } from 'zod';

export const Uuid = z.string().uuid();
export const IsoDateTime = z.string().datetime({ offset: true });

/** Số lượng dạng chuỗi thập phân để không mất chính xác (mục 16.1). */
export const Qty = z.string().regex(/^\d{1,15}(\.\d{1,3})?$/, 'Invalid quantity');

export const PositionSource = z.enum(['CONFIRMED_MANUAL', 'CONFIRMED_SCAN', 'SENSOR_OBSERVED', 'INFERRED']);
export type PositionSource = z.infer<typeof PositionSource>;

export const ScanEvidence = z
  .object({
    method: z.enum(['QR', 'BARCODE', 'RFID', 'MANUAL']),
    value: z.string().min(1).max(128),
    scannedAt: IsoDateTime,
  })
  .strict();
export type ScanEvidence = z.infer<typeof ScanEvidence>;

export const ExpectedVersion = z.number().int().min(0);

export const LocationRef = z.object({
  id: Uuid,
  code: z.string(),
  type: z.string(),
});
export type LocationRef = z.infer<typeof LocationRef>;

export const PositionDto = z.object({
  location: LocationRef.nullable(),
  source: PositionSource,
  confirmedAt: IsoDateTime,
});
export type PositionDto = z.infer<typeof PositionDto>;

export const pageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  code: z.string(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  correlationId: z.string().optional(),
  details: z.record(z.unknown()).optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

/** Lỗi "blocked" có danh sách nguyên nhân (mục 16.2). */
export const Blocker = z.object({
  code: z.string(),
  message: z.string(),
  refType: z.string().optional(),
  refId: z.string().optional(),
});
export type Blocker = z.infer<typeof Blocker>;
