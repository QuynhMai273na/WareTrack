import { z } from 'zod';
import { DockDirection, EquipmentType, SiteType } from './enums';
import { Uuid } from './common';

/**
 * Quản trị vận hành thật: tạo site, bản thiết kế sơ đồ (blueprint), danh mục và nhập tồn đầu kỳ.
 * Hệ tọa độ blueprint (mục 18.2): mét, +X = đông, +Z = nam, gốc ở góc tây-bắc khu đất của site.
 */

/** Khu đất mỗi site trên bản đồ mạng lưới chung: ô 300 × 260 m, đại lộ chạy ở biên ô (cách gốc 70 m). */
export const SITE_PLOT = { minX: -60, minZ: -60, maxX: 220, maxZ: 180 } as const;

const coordinateX = z.number().min(SITE_PLOT.minX).max(SITE_PLOT.maxX);
const coordinateZ = z.number().min(SITE_PLOT.minZ).max(SITE_PLOT.maxZ);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const objectCode = z.string().regex(/^[A-Za-z0-9-]{1,20}$/, 'Use letters, digits and dashes (max 20)');
const codePrefix = z.string().regex(/^[A-Za-z0-9-]{1,8}$/, 'Use letters, digits and dashes (max 8)');
const rotationDegrees = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(-90)]);

export const BuildingFace = z.enum(['S', 'E', 'N', 'W']);
export type BuildingFace = z.infer<typeof BuildingFace>;

export const BlueprintBuilding = z.object({
  id: z.string().min(1).max(40),
  code: objectCode,
  label: z.string().min(1).max(80),
  x: coordinateX,
  z: coordinateZ,
  width: z.number().min(10).max(200),
  depth: z.number().min(10).max(160),
  height: z.number().min(4).max(24).default(9),
  roof: z.enum(['gable', 'flat', 'sawtooth']).default('gable'),
  roofColor: hexColor.default('#2f6fe4'),
  wallColor: hexColor.default('#e8eef8'),
});
export type BlueprintBuilding = z.infer<typeof BlueprintBuilding>;

export const BlueprintDock = z.object({
  id: z.string().min(1).max(40),
  code: objectCode,
  label: z.string().min(1).max(40),
  buildingCode: objectCode,
  face: BuildingFace,
  /** Khoảng cách (m) từ góc trái của mặt nhà khi nhìn từ ngoài vào. */
  offset: z.number().min(2).max(200),
  direction: DockDirection.default('BOTH'),
});
export type BlueprintDock = z.infer<typeof BlueprintDock>;

/** Lưới ô sàn (staging / dock lane): mã ô = tiền tố + số thứ tự 2 chữ số. */
export const BlueprintSlotGrid = z.object({
  id: z.string().min(1).max(40),
  codePrefix,
  labelPrefix: z.string().min(1).max(30).default('Staging'),
  x: coordinateX,
  z: coordinateZ,
  rows: z.number().int().min(1).max(10),
  columns: z.number().int().min(1).max(20),
  capacityEach: z.number().int().min(1).max(12).default(2),
  spacing: z.number().min(2.6).max(8).default(3.4),
  startNumber: z.number().int().min(1).max(900).default(1),
});
export type BlueprintSlotGrid = z.infer<typeof BlueprintSlotGrid>;

export const BlueprintRack = z.object({
  id: z.string().min(1).max(40),
  code: objectCode,
  x: coordinateX,
  z: coordinateZ,
  rotation: rotationDegrees.default(0),
  levels: z.number().int().min(1).max(6).default(3),
  bays: z.number().int().min(1).max(8).default(2),
});
export type BlueprintRack = z.infer<typeof BlueprintRack>;

/** Hàng ô chờ xe tải (yard slot) hoặc trạm sạc xe nâng: đặt liên tiếp theo trục X. */
export const BlueprintRow = z.object({
  id: z.string().min(1).max(40),
  codePrefix,
  x: coordinateX,
  z: coordinateZ,
  count: z.number().int().min(1).max(20),
  rotation: rotationDegrees.default(0),
  spacing: z.number().min(3).max(12).default(6),
});
export type BlueprintRow = z.infer<typeof BlueprintRow>;

export const BlueprintGate = z.object({ x: coordinateX, z: coordinateZ, rotation: rotationDegrees.default(0) });
export type BlueprintGate = z.infer<typeof BlueprintGate>;

/** Sức chứa trong nhà (không vẽ từng ô): tổng vị trí pallet chia thành các ô `capacityEach`. */
export const BlueprintIndoorStorage = z.object({
  codePrefix,
  totalPallets: z.number().int().min(0).max(100_000),
  capacityEach: z.number().int().min(1).max(200).default(30),
});
export type BlueprintIndoorStorage = z.infer<typeof BlueprintIndoorStorage>;

export const SiteBlueprint = z
  .object({
    version: z.literal(1),
    buildings: z.array(BlueprintBuilding).min(1).max(6),
    docks: z.array(BlueprintDock).max(40),
    stagingGrids: z.array(BlueprintSlotGrid).max(12),
    racks: z.array(BlueprintRack).max(40),
    yardRows: z.array(BlueprintRow).max(8),
    chargerRows: z.array(BlueprintRow).max(6),
    gate: BlueprintGate,
    indoorStorage: BlueprintIndoorStorage,
    landscaping: z.boolean().default(true),
  })
  .superRefine((blueprint, context) => {
    const buildingCodes = new Set(blueprint.buildings.map((building) => building.code));
    blueprint.docks.forEach((dock, dockIndex) => {
      if (!buildingCodes.has(dock.buildingCode)) context.addIssue({ code: 'custom', path: ['docks', dockIndex, 'buildingCode'], message: `Unknown building ${dock.buildingCode}` });
    });
  });
export type SiteBlueprint = z.infer<typeof SiteBlueprint>;

// ───────────── Site ─────────────

export const CreateSiteRequest = z
  .object({
    code: z.string().regex(/^[A-Z0-9-]{2,12}$/, 'Use 2–12 upper-case letters, digits or dashes'),
    name: z.string().min(2).max(80),
    siteType: SiteType,
    addressLine: z.string().max(200).optional(),
    timezone: z.string().min(3).max(60).default('America/New_York'),
  })
  .strict();
export type CreateSiteRequest = z.infer<typeof CreateSiteRequest>;

export const UpdateSiteRequest = z
  .object({
    name: z.string().min(2).max(80).optional(),
    addressLine: z.string().max(200).nullable().optional(),
    timezone: z.string().min(3).max(60).optional(),
    operationalStatus: z.enum(['OPERATIONAL', 'LIMITED', 'CLOSED']).optional(),
  })
  .strict();
export type UpdateSiteRequest = z.infer<typeof UpdateSiteRequest>;

export interface BlueprintState {
  blueprint: SiteBlueprint;
  /** Bản nháp đã lưu khác bản đang publish. */
  hasUnpublishedChanges: boolean;
  publishedVersionNo: number | null;
  publishedAt: string | null;
  /** Chưa từng lưu bản thiết kế: đang hiển thị bản mẫu (site demo có sơ đồ viết tay trong seed sẽ bị thay khi publish). */
  isTemplate: boolean;
}

export interface PublishBlueprintResult {
  versionNo: number;
  locationsCreated: number;
  locationsUpdated: number;
  locationsRetired: number;
}

// ───────────── Danh mục ─────────────

export const PartnerType = z.enum(['CUSTOMER', 'SUPPLIER', 'CARRIER']);
export type PartnerType = z.infer<typeof PartnerType>;

export const CreatePartnerRequest = z
  .object({
    code: z.string().regex(/^[A-Z0-9-]{2,20}$/, 'Use 2–20 upper-case letters, digits or dashes'),
    name: z.string().min(2).max(120),
    partnerTypes: z.array(PartnerType).min(1),
    contactEmail: z.string().email().optional(),
    contactPhone: z.string().max(30).optional(),
  })
  .strict();
export type CreatePartnerRequest = z.infer<typeof CreatePartnerRequest>;

export const UpdatePartnerRequest = z
  .object({
    name: z.string().min(2).max(120).optional(),
    partnerTypes: z.array(PartnerType).min(1).optional(),
    contactEmail: z.string().email().nullable().optional(),
    contactPhone: z.string().max(30).nullable().optional(),
  })
  .strict();
export type UpdatePartnerRequest = z.infer<typeof UpdatePartnerRequest>;

export interface PartnerDto {
  id: string;
  code: string;
  name: string;
  partnerTypes: string[];
  contactEmail: string | null;
  contactPhone: string | null;
}

export const CreateEquipmentRequest = z
  .object({
    code: z.string().regex(/^[A-Z0-9-]{2,20}$/, 'Use 2–20 upper-case letters, digits or dashes'),
    equipmentType: EquipmentType.default('FORKLIFT'),
    model: z.string().max(80).optional(),
    chargerLocationId: Uuid.nullable().optional(),
    operatorUserId: Uuid.nullable().optional(),
  })
  .strict();
export type CreateEquipmentRequest = z.infer<typeof CreateEquipmentRequest>;

export const UpdateEquipmentRequest = z
  .object({
    model: z.string().max(80).nullable().optional(),
    chargerLocationId: Uuid.nullable().optional(),
    operatorUserId: Uuid.nullable().optional(),
  })
  .strict();
export type UpdateEquipmentRequest = z.infer<typeof UpdateEquipmentRequest>;

export const UpdateUserRequest = z
  .object({
    fullName: z.string().min(2).max(120).optional(),
    email: z.string().email().optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  })
  .strict();
export type UpdateUserRequest = z.infer<typeof UpdateUserRequest>;

export const ResetPasswordRequest = z.object({ tempPassword: z.string().min(12).max(200) }).strict();
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequest>;

// ───────────── Tồn kho đầu kỳ ─────────────

export const OpeningStockRow = z.object({
  skuCode: z.string().min(1).max(40),
  locationCode: z.string().min(1).max(40),
  quantity: z.string().regex(/^\d+(\.\d{1,3})?$/, 'Quantity must be a positive number'),
  palletCode: z.string().regex(/^[A-Za-z0-9-]{3,30}$/).optional(),
  lotNumber: z.string().max(40).optional(),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
});
export type OpeningStockRow = z.infer<typeof OpeningStockRow>;

export const OpeningStockRequest = z
  .object({
    rows: z.array(OpeningStockRow).min(1).max(5000),
    /** true = chỉ kiểm tra, không ghi. */
    dryRun: z.boolean().default(true),
  })
  .strict();
export type OpeningStockRequest = z.infer<typeof OpeningStockRequest>;

export interface OpeningStockRowResult {
  rowNumber: number;
  status: 'OK' | 'ERROR';
  message: string | null;
  palletCode: string | null;
}

export interface OpeningStockResult {
  dryRun: boolean;
  importedPallets: number;
  errorCount: number;
  rows: OpeningStockRowResult[];
}

export interface AdminSiteDto {
  id: string;
  code: string;
  name: string;
  siteType: SiteType;
  addressLine: string | null;
  timezone: string;
  operationalStatus: 'OPERATIONAL' | 'LIMITED' | 'CLOSED';
  map: { x: number; z: number };
  publishedVersionNo: number | null;
  locationCount: number;
  version: number;
}

export interface AdminUserDto {
  id: string;
  username: string;
  email: string;
  fullName: string;
  status: 'ACTIVE' | 'DISABLED' | 'LOCKED';
  siteRoles: Array<{ id: string; roleCode: string; siteId: string | null; siteCode: string | null }>;
}

export interface AdminEquipmentDto {
  id: string;
  code: string;
  equipmentType: string;
  model: string | null;
  status: string;
  chargerLocationId: string | null;
  operator: string | null;
  operatorUserId: string | null;
  batteryPct: number | null;
}
