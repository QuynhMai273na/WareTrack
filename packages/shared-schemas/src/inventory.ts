import { z } from 'zod';
import { ExpectedVersion, IsoDateTime, PositionSource, Qty, Uuid } from './common';

export const StockStatus = z.enum(['AVAILABLE', 'QC_HOLD', 'QUARANTINE', 'DAMAGED']);
export type StockStatus = z.infer<typeof StockStatus>;

export const HuLifecycle = z.enum(['RECEIVING', 'IN_STOCK', 'PICKED', 'STAGED', 'LOADED', 'DISPATCHED', 'EMPTY']);
export type HuLifecycle = z.infer<typeof HuLifecycle>;

export const InventoryTxType = z.enum(['RECEIPT', 'RECEIPT_REVERSAL', 'MOVE', 'STATUS_CHANGE', 'ISSUE', 'ISSUE_REVERSAL', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT']);
export type InventoryTxType = z.infer<typeof InventoryTxType>;

export const AdjustmentReason = z.enum(['COUNT_VARIANCE', 'DAMAGE', 'LOSS', 'FOUND', 'DATA_CORRECTION']);
export type AdjustmentReason = z.infer<typeof AdjustmentReason>;

export const SkuDto = z.object({
  id: Uuid,
  code: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  baseUom: z.string(),
  uomDecimals: z.number(),
  lotTracked: z.boolean(),
  serialTracked: z.boolean(),
  expiryTracked: z.boolean(),
  qcRequired: z.boolean(),
  allocationStrategy: z.enum(['FIFO', 'FEFO']),
  unitWeightKg: z.string().nullable(),
  lowStockThreshold: z.string().nullable(),
  version: z.number(),
});
export type SkuDto = z.infer<typeof SkuDto>;

export const CreateSkuRequest = z
  .object({
    code: z.string().regex(/^[A-Z0-9-]{3,40}$/),
    name: z.string().min(2).max(200),
    /** Nhóm hàng hiển thị (Packaging, PPE, Grocery…). */
    category: z.string().max(40).optional(),
    baseUom: z.string().min(1).max(10).default('EA'),
    uomDecimals: z.number().int().min(0).max(3).default(0),
    lotTracked: z.boolean().default(false),
    serialTracked: z.boolean().default(false),
    expiryTracked: z.boolean().default(false),
    qcRequired: z.boolean().default(false),
    allocationStrategy: z.enum(['FIFO', 'FEFO']).default('FIFO'),
    unitWeightKg: Qty.optional(),
    lowStockThreshold: Qty.optional(),
  })
  .strict()
  .refine((request) => !request.expiryTracked || request.lotTracked, { message: 'expiryTracked requires lotTracked', path: ['expiryTracked'] })
  .refine((request) => request.allocationStrategy !== 'FEFO' || request.expiryTracked, { message: 'FEFO requires expiryTracked (DEC-09)', path: ['allocationStrategy'] });
export type CreateSkuRequest = z.infer<typeof CreateSkuRequest>;

export const BalanceDto = z.object({
  id: Uuid,
  sku: z.object({ id: Uuid, code: z.string(), name: z.string(), baseUom: z.string() }),
  lot: z.object({ id: Uuid, lotNumber: z.string(), expiresOn: z.string().nullable() }).nullable(),
  location: z.object({ id: Uuid, code: z.string(), type: z.string() }),
  handlingUnit: z.object({ id: Uuid, code: z.string() }).nullable(),
  stockStatus: StockStatus,
  qtyOnHand: Qty,
  qtyReserved: Qty,
  qtyAvailable: Qty,
  receivedAt: IsoDateTime,
  version: z.number(),
});
export type BalanceDto = z.infer<typeof BalanceDto>;

export const AvailabilityDto = z.object({
  sku: z.object({ id: Uuid, code: z.string(), name: z.string(), baseUom: z.string() }),
  onHand: Qty,
  reserved: Qty,
  available: Qty,
  byStatus: z.record(Qty),
  lowStock: z.boolean(),
  lowStockThreshold: Qty.nullable(),
});
export type AvailabilityDto = z.infer<typeof AvailabilityDto>;

export const InventoryTxDto = z.object({
  id: z.string(),
  txType: InventoryTxType,
  sku: z.object({ id: Uuid, code: z.string() }),
  lotNumber: z.string().nullable(),
  handlingUnitCode: z.string().nullable(),
  fromLocation: z.string().nullable(),
  toLocation: z.string().nullable(),
  fromStatus: StockStatus.nullable(),
  toStatus: StockStatus.nullable(),
  quantity: Qty,
  referenceType: z.string(),
  referenceId: z.string(),
  reversesTxId: z.string().nullable(),
  reversedByTxId: z.string().nullable(),
  actor: z.string().nullable(),
  occurredAt: IsoDateTime,
});
export type InventoryTxDto = z.infer<typeof InventoryTxDto>;

export const HuContentDto = z.object({
  balanceId: Uuid,
  sku: z.object({ id: Uuid, code: z.string(), name: z.string(), baseUom: z.string(), category: z.string().nullable().optional() }),
  lotNumber: z.string().nullable(),
  receivedAt: IsoDateTime.nullable().optional(),
  expiresOn: z.string().nullable(),
  stockStatus: StockStatus,
  qtyOnHand: Qty,
  qtyReserved: Qty,
});

export const HandlingUnitDetail = z.object({
  id: Uuid,
  code: z.string(),
  sscc: z.string().nullable(),
  lifecycle: HuLifecycle,
  location: z.object({ id: Uuid, code: z.string(), type: z.string(), name: z.string().nullable().optional() }).nullable(),
  position: z.object({ source: PositionSource, confirmedAt: IsoDateTime }).nullable(),
  grossWeightKg: z.number().nullable().optional(),
  contents: z.array(HuContentDto),
  version: z.number(),
});
export type HandlingUnitDetail = z.infer<typeof HandlingUnitDetail>;

export const HuHistoryEntry = z.object({
  at: IsoDateTime,
  kind: z.enum(['LEDGER', 'MOVEMENT']),
  description: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  source: z.string().nullable(),
  actor: z.string().nullable(),
});
export type HuHistoryEntry = z.infer<typeof HuHistoryEntry>;

export const MovePalletRequest = z
  .object({
    toLocationId: Uuid,
    reason: z.string().min(3).max(200),
    scanDestination: z.string().max(128).optional(),
    overrideCapacity: z.boolean().optional(),
    expectedVersion: ExpectedVersion,
  })
  .strict();
export type MovePalletRequest = z.infer<typeof MovePalletRequest>;

export const StatusChangeRequest = z
  .object({ balanceId: Uuid, quantity: Qty, toStatus: StockStatus, reason: z.string().min(3).max(200) })
  .strict();
export type StatusChangeRequest = z.infer<typeof StatusChangeRequest>;

export const AdjustmentDto = z.object({
  id: Uuid,
  code: z.string(),
  balance: BalanceDto,
  qtyDelta: z.string(),
  reasonCode: AdjustmentReason,
  note: z.string().nullable(),
  status: z.enum(['PENDING_APPROVAL', 'APPLIED', 'REJECTED']),
  requiresManager: z.boolean(),
  requestedBy: z.object({ id: Uuid, fullName: z.string() }),
  approvedBy: z.object({ id: Uuid, fullName: z.string() }).nullable(),
  decidedAt: IsoDateTime.nullable(),
  decisionNote: z.string().nullable(),
  createdAt: IsoDateTime,
  version: z.number(),
});
export type AdjustmentDto = z.infer<typeof AdjustmentDto>;

export const CreateAdjustmentRequest = z
  .object({
    balanceId: Uuid,
    qtyDelta: z.string().regex(/^-?\d{1,15}(\.\d{1,3})?$/),
    reasonCode: AdjustmentReason,
    note: z.string().max(500).optional(),
  })
  .strict()
  .refine((request) => Number(request.qtyDelta) !== 0, { message: 'qtyDelta must not be zero', path: ['qtyDelta'] });
export type CreateAdjustmentRequest = z.infer<typeof CreateAdjustmentRequest>;

export const DecisionRequest = z.object({ note: z.string().max(500).optional(), expectedVersion: ExpectedVersion }).strict();
export type DecisionRequest = z.infer<typeof DecisionRequest>;

export const StockCountDto = z.object({
  id: Uuid,
  code: z.string(),
  status: z.enum(['PLANNED', 'IN_PROGRESS', 'RECONCILING', 'COMPLETED', 'CANCELLED']),
  blind: z.boolean(),
  freeze: z.boolean(),
  scope: z.object({ zoneIds: z.array(Uuid).optional(), locationIds: z.array(Uuid).optional(), skuIds: z.array(Uuid).optional() }),
  lineCount: z.number(),
  countedCount: z.number(),
  varianceCount: z.number(),
  createdAt: IsoDateTime,
  version: z.number(),
});
export type StockCountDto = z.infer<typeof StockCountDto>;

export const StockCountLineDto = z.object({
  id: Uuid,
  location: z.string(),
  sku: z.object({ code: z.string(), name: z.string() }),
  lotNumber: z.string().nullable(),
  handlingUnitCode: z.string().nullable(),
  /** Ẩn với người đếm khi blind count (UC-16-AC1). */
  systemQty: Qty.nullable(),
  countedQty: Qty.nullable(),
  variance: z.string().nullable(),
  countRound: z.number(),
});
export type StockCountLineDto = z.infer<typeof StockCountLineDto>;

export const CreateStockCountRequest = z
  .object({
    scope: z.object({ zoneIds: z.array(Uuid).optional(), locationIds: z.array(Uuid).optional(), skuIds: z.array(Uuid).optional() }),
    blind: z.boolean().default(true),
    freeze: z.boolean().default(false),
  })
  .strict()
  .refine((request) => (request.scope.zoneIds?.length ?? 0) + (request.scope.locationIds?.length ?? 0) + (request.scope.skuIds?.length ?? 0) > 0, { message: 'Scope must not be empty', path: ['scope'] });
export type CreateStockCountRequest = z.infer<typeof CreateStockCountRequest>;

export const RecordCountRequest = z.object({ countedQty: Qty }).strict();

/** Lý do điều chỉnh tồn mặc định (DEC-57). */
export const ADJUSTMENT_REASONS = AdjustmentReason.options;
