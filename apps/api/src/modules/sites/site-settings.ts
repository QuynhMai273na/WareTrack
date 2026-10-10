import { z } from 'zod';

/** Tham số cấu hình theo site và giá trị mặc định đã chốt (mục 15.19, Decision Log). */
export const SITE_SETTING_SCHEMAS = {
  noShowGraceMinutes: z.number().int().min(0).max(1440), // DEC-24
  dockReservationTtlMinutes: z.number().int().min(5).max(1440), // DEC-28
  appointmentToleranceMinutes: z.number().int().min(0).max(720),
  overReceiptTolerancePct: z.number().min(0).max(100), // DEC-15
  lowBatteryPct: z.number().int().min(1).max(99), // DEC-50
  adjustApprovalThreshold: z.object({ maxUnits: z.number().min(0), maxPct: z.number().min(0) }), // DEC-14
  mixedPalletAllowed: z.boolean(), // DEC-10
  allowPartialDispatch: z.boolean(), // DEC-18
  warehouseCanAssignDock: z.boolean(), // DEC-32
  selfAssign: z.boolean(), // DEC-33
  onTimeDispatchToleranceMinutes: z.number().int().min(0).max(1440), // DEC-12
  gateDocumentChecklist: z.array(z.object({ key: z.string(), vi: z.string(), en: z.string(), required: z.boolean() })), // DEC-20
  vehicleInspectionChecklist: z.array(z.object({ key: z.string(), vi: z.string(), en: z.string(), required: z.boolean() })), // DEC-20
  dashboardSkus: z.array(z.string()), // SKU hiển thị trên panel site (thứ tự)
} as const;

export type SiteSettingKey = keyof typeof SITE_SETTING_SCHEMAS;
export type SiteSettings = { [K in SiteSettingKey]: z.infer<(typeof SITE_SETTING_SCHEMAS)[K]> };

export const SITE_SETTING_DEFAULTS: SiteSettings = {
  noShowGraceMinutes: 60,
  dockReservationTtlMinutes: 30,
  appointmentToleranceMinutes: 120,
  overReceiptTolerancePct: 0,
  lowBatteryPct: 20,
  adjustApprovalThreshold: { maxUnits: 5, maxPct: 2 },
  mixedPalletAllowed: false,
  allowPartialDispatch: false,
  warehouseCanAssignDock: false,
  selfAssign: false,
  onTimeDispatchToleranceMinutes: 0,
  gateDocumentChecklist: [
    { key: 'PLATE_MATCH', vi: 'Biển số khớp', en: 'Plate matches', required: true },
    { key: 'DRIVER_ID', vi: 'Giấy tờ tài xế', en: 'Driver ID', required: true },
    { key: 'TRANSPORT_ORDER', vi: 'Lệnh vận chuyển', en: 'Transport order', required: true },
  ],
  dashboardSkus: [],
  vehicleInspectionChecklist: [
    { key: 'EXTERIOR', vi: 'Ngoại thất', en: 'Exterior', required: true },
    { key: 'INTERIOR', vi: 'Nội thất', en: 'Interior', required: true },
    { key: 'KEYS', vi: 'Chìa khóa', en: 'Keys', required: true },
    { key: 'DOCUMENTS', vi: 'Giấy tờ xe', en: 'Vehicle documents', required: true },
    { key: 'PHOTOS_4_SIDES', vi: 'Ảnh 4 góc', en: 'Photos (4 sides)', required: true },
  ],
};

export function isSettingKey(key: string): key is SiteSettingKey {
  return key in SITE_SETTING_SCHEMAS;
}
