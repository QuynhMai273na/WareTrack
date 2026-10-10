import { z } from 'zod';
import { ExpectedVersion, IsoDateTime, Qty, ScanEvidence, Uuid } from './common';
import { StockStatus } from './inventory';

// ───────────── Shipments (mục 9.5, 15.11) ─────────────

export const ShipmentStatus = z.enum(['DRAFT', 'CONFIRMED', 'PICKING', 'STAGED', 'LOADING', 'DISPATCHED', 'DELIVERED', 'EXPECTED', 'ARRIVED', 'UNLOADING', 'RECEIVED', 'CLOSED', 'CANCELLED']);
export type ShipmentStatus = z.infer<typeof ShipmentStatus>;

export const TrackingStep = z.object({
  key: z.string(),
  state: z.enum(['DONE', 'CURRENT', 'PENDING']),
  at: IsoDateTime.nullable(),
  eta: IsoDateTime.nullable(),
  progress: z.object({ done: z.number(), total: z.number() }).nullable(),
});
export type TrackingStep = z.infer<typeof TrackingStep>;

export const ShipmentDetail = z.object({
  id: Uuid,
  code: z.string(),
  direction: z.enum(['INBOUND', 'OUTBOUND']),
  status: ShipmentStatus,
  partner: z.object({ id: Uuid, name: z.string() }).nullable(),
  carrier: z.object({ id: Uuid, name: z.string() }).nullable(),
  visit: z.object({ id: Uuid, code: z.string(), status: z.string(), truckCode: z.string(), dockCode: z.string().nullable() }).nullable(),
  stagingLocation: z.object({ id: Uuid, code: z.string() }).nullable(),
  destinationText: z.string().nullable(),
  plannedDispatchAt: IsoDateTime.nullable(),
  promisedAt: IsoDateTime.nullable(),
  etaAt: IsoDateTime.nullable(),
  arrivedAt: IsoDateTime.nullable(),
  dispatchedAt: IsoDateTime.nullable(),
  deliveredAt: IsoDateTime.nullable(),
  sealNumber: z.string().nullable(),
  progress: z.object({ done: z.number(), total: z.number() }),
  items: z.array(z.object({ id: Uuid, handlingUnitId: Uuid.nullable(), code: z.string(), label: z.string(), loadedAt: IsoDateTime.nullable(), lifecycle: z.string().nullable() })),
  orders: z.array(z.object({ id: Uuid, code: z.string(), status: z.string() })),
  steps: z.array(TrackingStep),
  version: z.number(),
});
export type ShipmentDetail = z.infer<typeof ShipmentDetail>;

export const ShipmentRow = ShipmentDetail.pick({ id: true, code: true, direction: true, status: true, partner: true, visit: true, progress: true, plannedDispatchAt: true, etaAt: true, version: true });
export type ShipmentRow = z.infer<typeof ShipmentRow>;

export const AssignVisitRequest = z.object({ truckVisitId: Uuid.nullable(), expectedVersion: ExpectedVersion }).strict();
export const DeliverRequest = z.object({ deliveredAt: IsoDateTime, note: z.string().max(300).optional(), expectedVersion: ExpectedVersion }).strict();

// ───────────── Inbound (mục 16.4.15) ─────────────

export const CreateInboundOrderRequest = z
  .object({
    supplierId: Uuid.optional(),
    expectedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    truckVisitId: Uuid.optional(),
    etaAt: IsoDateTime.optional(),
    lines: z.array(z.object({ skuId: Uuid, expectedQty: Qty, expectedHuCount: z.number().int().min(0).optional(), expectedLotNumber: z.string().max(40).optional() })).min(1),
  })
  .strict();
export type CreateInboundOrderRequest = z.infer<typeof CreateInboundOrderRequest>;

export const InboundOrderDetail = z.object({
  id: Uuid,
  code: z.string(),
  status: z.string(),
  supplier: z.object({ id: Uuid, name: z.string() }).nullable(),
  expectedOn: z.string().nullable(),
  shipment: z.object({ id: Uuid, code: z.string(), status: z.string(), visitId: Uuid.nullable() }).nullable(),
  lines: z.array(z.object({ id: Uuid, sku: z.object({ id: Uuid, code: z.string(), name: z.string(), lotTracked: z.boolean(), qcRequired: z.boolean() }), expectedQty: Qty, expectedHuCount: z.number().nullable(), expectedLotNumber: z.string().nullable(), receivedQty: Qty })),
  receipt: z.object({ id: Uuid, code: z.string(), status: z.string() }).nullable(),
  version: z.number(),
});
export type InboundOrderDetail = z.infer<typeof InboundOrderDetail>;

export const StartReceiptRequest = z.object({ inboundOrderId: Uuid }).strict();

export const ReceiptLineRequest = z
  .object({
    huCode: z.string().max(40).optional(),
    skuId: Uuid,
    lotNumber: z.string().max(40).optional(),
    expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    quantity: Qty,
    condition: z.enum(['GOOD', 'DAMAGED']).default('GOOD'),
  })
  .strict();
export type ReceiptLineRequest = z.infer<typeof ReceiptLineRequest>;

export const ReceiptDetail = z.object({
  id: Uuid,
  code: z.string(),
  status: z.string(),
  inboundOrderId: Uuid,
  shipmentId: Uuid,
  dock: z.object({ id: Uuid, code: z.string() }),
  lines: z.array(z.object({ id: Uuid, sku: z.object({ code: z.string(), name: z.string() }), lotNumber: z.string().nullable(), handlingUnit: z.object({ id: Uuid, code: z.string() }), quantity: Qty, stockStatus: StockStatus, voided: z.boolean(), createdAt: IsoDateTime })),
  progress: z.object({ receivedHu: z.number(), expectedHu: z.number() }),
  discrepancies: z.array(z.object({ id: Uuid, type: z.string(), sku: z.string().nullable(), qtyDelta: z.string(), status: z.string(), note: z.string().nullable() })),
  version: z.number(),
});
export type ReceiptDetail = z.infer<typeof ReceiptDetail>;

export const CompleteReceiptRequest = z.object({ closeShortReason: z.string().max(300).optional() }).strict();

export const QcRequest = z
  .object({
    handlingUnitId: Uuid,
    result: z.enum(['PASS', 'FAIL', 'PARTIAL']),
    qtyFailed: Qty.optional(),
    failStatus: z.enum(['QUARANTINE', 'DAMAGED']).optional(),
    note: z.string().max(300).optional(),
  })
  .strict();
export type QcRequest = z.infer<typeof QcRequest>;

// ───────────── Outbound (mục 16.4.16) ─────────────

export const CreateOutboundOrderRequest = z
  .object({
    customerId: Uuid.optional(),
    requestedDeliveryAt: IsoDateTime.optional(),
    plannedDispatchAt: IsoDateTime.optional(),
    destinationText: z.string().max(200).optional(),
    truckVisitId: Uuid.optional(),
    lines: z.array(z.object({ skuId: Uuid, orderedQty: Qty, lotId: Uuid.optional() })).min(1),
  })
  .strict();
export type CreateOutboundOrderRequest = z.infer<typeof CreateOutboundOrderRequest>;

export const OutboundOrderDetail = z.object({
  id: Uuid,
  code: z.string(),
  status: z.string(),
  customer: z.object({ id: Uuid, name: z.string() }).nullable(),
  requestedDeliveryAt: IsoDateTime.nullable(),
  shipment: z.object({ id: Uuid, code: z.string(), status: z.string(), visitId: Uuid.nullable() }).nullable(),
  lines: z.array(
    z.object({
      id: Uuid,
      sku: z.object({ id: Uuid, code: z.string(), name: z.string() }),
      orderedQty: Qty,
      allocatedQty: Qty,
      pickedQty: Qty,
      shippedQty: Qty,
      status: z.string(),
    }),
  ),
  version: z.number(),
});
export type OutboundOrderDetail = z.infer<typeof OutboundOrderDetail>;

export const AllocateRequest = z.object({ allOrNothing: z.boolean().default(false) }).strict();
export const LoadScanRequest = z.object({ huScan: ScanEvidence, dockScan: ScanEvidence }).strict();
export const UnloadScanRequest = z.object({ huScan: ScanEvidence, reason: z.string().min(3).max(200) }).strict();
export const DispatchRequest = z.object({ sealNumber: z.string().max(40).optional(), expectedVersion: ExpectedVersion }).strict();

// ───────────── Operations tasks (mục 9.8, 16.4.19) ─────────────

export const TaskType = z.enum(['PUTAWAY', 'PICK', 'LOAD', 'UNLOAD', 'MOVE_PALLET', 'MOVE_VEHICLE', 'QC', 'COUNT', 'RETURN_TO_STOCK']);
export const TaskStatus = z.enum(['PENDING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED']);

export const TaskDto = z.object({
  id: Uuid,
  code: z.string(),
  taskType: TaskType,
  status: TaskStatus,
  priority: z.number(),
  subject: z.object({ type: z.string(), id: Uuid, code: z.string(), label: z.string().nullable() }),
  from: z.object({ id: Uuid, code: z.string(), qrValue: z.string() }).nullable(),
  to: z.object({ id: Uuid, code: z.string(), qrValue: z.string() }).nullable(),
  source: z.object({ type: z.string(), id: Uuid, code: z.string().nullable() }),
  assignee: z.object({ id: Uuid, fullName: z.string() }).nullable(),
  equipment: z.object({ id: Uuid, code: z.string() }).nullable(),
  sourceConfirmed: z.boolean(),
  blockReason: z.string().nullable(),
  createdAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
  version: z.number(),
});
export type TaskDto = z.infer<typeof TaskDto>;

export const AssignTaskRequest = z.object({ assigneeId: Uuid, equipmentId: Uuid.optional(), expectedVersion: ExpectedVersion }).strict();
export const TaskVersionRequest = z.object({ expectedVersion: ExpectedVersion }).strict();
export const ConfirmSourceRequest = z.object({ locationScan: z.string().min(1).max(128), subjectScan: z.string().min(1).max(128) }).strict();
export const ConfirmDestinationRequest = z.object({ locationScan: z.string().min(1).max(128), overrideReason: z.string().max(200).optional() }).strict();
export const TaskReasonRequest = z.object({ reason: z.string().min(3).max(300) }).strict();
export const ShortPickRequest = z.object({ pickedQty: Qty, reason: z.string().min(3).max(300) }).strict();

export const ExceptionDto = z.object({
  id: Uuid,
  code: z.string(),
  caseType: z.string(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  status: z.enum(['OPEN', 'IN_REVIEW', 'RESOLVED', 'REJECTED']),
  subjectType: z.string().nullable(),
  subjectId: Uuid.nullable(),
  description: z.string(),
  assignee: z.string().nullable(),
  resolutionCode: z.string().nullable(),
  resolutionNote: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: IsoDateTime,
  version: z.number(),
});
export type ExceptionDto = z.infer<typeof ExceptionDto>;
