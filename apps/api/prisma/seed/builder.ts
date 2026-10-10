/**
 * Bộ dựng layout chi tiết cho các site demo theo video tham chiếu (DEC-56).
 * Hệ tọa độ (mục 18.2): mét, Y-up, +X = đông, +Z = nam; camera isometric nhìn từ đông-nam.
 * Mặt nhà (face): S = tường nam (+Z, hướng xuống-trái màn hình), E = tường đông (+X, hướng xuống-phải).
 */
import type { DockDirection, LocationType, ZoneType } from '@prisma/client';
import type { BuildingSpec, DecorSpec, LocationSpec, SiteLayoutSpec, ZoneSpec } from './layout';

export type Face = 'S' | 'E' | 'N' | 'W';

/** Ô lưới của mỗi site trên bản đồ chung: rộng 300 m × sâu 260 m, đại lộ chạy ở biên ô (cách gốc 70 m). */
export const NETWORK_CELL = { w: 300, d: 260, margin: 70 };

/** Đại lộ biên ô lưới (bản đồ mạng lưới chung) — mỗi site vẽ cạnh tây + bắc, site ở rìa vẽ thêm cạnh đông/nam. */
export function avenues(b: SiteBuilder, sides: { east?: boolean; south?: boolean }) {
  const m = NETWORK_CELL.margin;
  const x0 = -m;
  const x1 = NETWORK_CELL.w - m;
  const z0 = -m;
  const z1 = NETWORK_CELL.d - m;
  b.decor.push({ kind: 'road', x: x0, z: (z0 + z1) / 2, w: 18, d: z1 - z0, rotY: 0, props: { lanes: 2, sidewalk: true, avenue: true, layer: 1 } });
  b.decor.push({ kind: 'road', x: (x0 + x1) / 2, z: z0, w: 18, d: x1 - x0, rotY: 90, props: { lanes: 2, sidewalk: true, avenue: true, layer: 0 } });
  if (sides.east) b.decor.push({ kind: 'road', x: x1, z: (z0 + z1) / 2, w: 18, d: z1 - z0, rotY: 0, props: { lanes: 2, sidewalk: true, avenue: true, layer: 1 } });
  if (sides.south) b.decor.push({ kind: 'road', x: (x0 + x1) / 2, z: z1, w: 18, d: x1 - x0, rotY: 90, props: { lanes: 2, sidewalk: true, avenue: true, layer: 0 } });
}
const FACE_ROT: Record<Face, number> = { S: 0, E: 90, N: 180, W: -90 };

export interface BuildingStyle {
  roof: 'gable' | 'sawtooth' | 'flat';
  /** Hướng nóc mái (gable): chạy theo trục X hoặc Z. */
  ridge?: 'x' | 'z';
  /** Số nhịp mái (gable nhiều nhịp / sawtooth). */
  bays?: number;
  roofColor: string;
  wallColor: string;
  /** Dải viền navy chạy quanh đỉnh tường (kho lạnh / automated DC). */
  band?: boolean;
  /** Huy hiệu logo trên mái (vị trí tương đối 0..1). */
  badge?: { u: number; v: number; size: number } | null;
  /** Cụm máy lạnh trên mái: [u, v, số quạt]. */
  roofUnits?: Array<[number, number, number]>;
  /** Khối văn phòng kính gắn vào một mặt. */
  office?: { face: Face; offset: number; width: number; height: number };
  /** Cửa trang trí (không phải dock nghiệp vụ). */
  doors?: Array<{ face: Face; offset: number; open?: boolean; cargo?: boolean; label?: string }>;
  /** Biển tên trên tường. */
  sign?: { face: Face; offset: number; text: string; sub?: string };
  /** Sàn dock nâng có viền vàng chạy dọc một mặt. */
  platform?: { face: Face; from: number; to: number; depth: number };
}

export class SiteBuilder {
  zones: ZoneSpec[] = [];
  locations: LocationSpec[] = [];
  buildings: BuildingSpec[] = [];
  decor: DecorSpec[] = [];
  private bRects = new Map<string, { x: number; z: number; w: number; d: number }>();

  constructor(readonly bounds: SiteLayoutSpec['bounds']) {}

  zone(code: string, name: string, zoneType: ZoneType, rect: ZoneSpec['rect'], color = 'transparent') {
    this.zones.push({ code, name, zoneType, rect, color });
    return this;
  }

  building(code: string, label: string, rect: { x: number; z: number; w: number; d: number }, height: number, style: BuildingStyle) {
    this.bRects.set(code, rect);
    this.buildings.push({ code, label, rect, height, roofColor: style.roofColor, wallColor: style.wallColor, style });
    if (!this.zones.some((z) => z.code === 'WH')) this.zone('WH', 'Warehouse', 'WAREHOUSE', rect, 'transparent');
    return this;
  }

  /** Điểm trên mặt nhà tại `offset` (m tính từ góc trái của mặt khi nhìn từ ngoài vào). */
  facePoint(building: string, face: Face, offset: number) {
    const r = this.bRects.get(building)!;
    switch (face) {
      case 'S':
        return { x: r.x + offset, z: r.z + r.d };
      case 'N':
        return { x: r.x + r.w - offset, z: r.z };
      case 'E':
        return { x: r.x + r.w, z: r.z + r.d - offset };
      case 'W':
        return { x: r.x, z: r.z + offset };
    }
  }

  dock(code: string, label: string, building: string, face: Face, offset: number, direction: DockDirection = 'BOTH') {
    const p = this.facePoint(building, face, offset);
    if (!this.zones.some((z) => z.code === 'DOCKS')) this.zone('DOCKS', 'Dock apron', 'YARD', { x: 0, z: 0, w: 1, d: 1 });
    void code;
    this.locations.push({
      zone: 'DOCKS',
      code: label,
      type: 'DOCK',
      capacity: 1,
      single: true,
      pos: { x: p.x, z: p.z, rotY: FACE_ROT[face] },
      size: { x: 4.4, z: 18 },
      dockDirection: direction,
      doorNumber: label.replace(/\D+/g, '') || label,
      lengthM: 18,
      widthM: 4.4,
      label,
    });
    return this;
  }

  private ensureZone(code: string, name: string, type: ZoneType) {
    if (!this.zones.some((z) => z.code === code)) this.zone(code, name, type, { x: 0, z: 0, w: 1, d: 1 });
  }

  /** Ô sàn có viền vàng (staging / yard slot pallet). */
  slot(code: string, label: string, x: number, z: number, opts: { type?: LocationType; capacity?: number; rotY?: number; w?: number; d?: number } = {}) {
    const type = opts.type ?? 'STAGING';
    this.ensureZone('STG', 'Staging', 'STAGING');
    this.locations.push({ zone: 'STG', code, type, capacity: opts.capacity ?? 2, single: false, pos: { x, z, rotY: opts.rotY ?? 0 }, size: { x: opts.w ?? 2.6, z: opts.d ?? 2.6 }, label, display: 'floor' });
    return this;
  }

  /** Rack ngoài trời (khung xanh + thanh cam). */
  rack(code: string, x: number, z: number, opts: { rotY?: number; levels?: number; bays?: number } = {}) {
    this.ensureZone('RACK', 'Outdoor racks', 'WAREHOUSE');
    const bays = opts.bays ?? 2;
    this.locations.push({ zone: 'RACK', code, type: 'STORAGE', capacity: (opts.levels ?? 3) * bays, single: false, pos: { x, z, rotY: opts.rotY ?? 0 }, size: { x: 2.8 * bays, z: 1.6 }, label: code, display: 'rack', levels: opts.levels ?? 3, bays });
    return this;
  }

  charger(code: string, x: number, z: number, rotY = 0) {
    this.ensureZone('CHG', 'Charging', 'CHARGING');
    this.locations.push({ zone: 'CHG', code, type: 'CHARGER', capacity: 1, single: false, pos: { x, z, rotY }, size: { x: 3, z: 3.4 }, label: code });
    return this;
  }

  yardSlot(code: string, x: number, z: number, rotY = 0) {
    this.ensureZone('YARD', 'Truck yard', 'YARD');
    this.locations.push({ zone: 'YARD', code, type: 'YARD_SLOT', capacity: 1, single: true, pos: { x, z, rotY }, size: { x: 4.2, z: 17 }, label: code });
    return this;
  }

  gate(code: string, x: number, z: number, rotY = 0) {
    this.ensureZone('GATE', 'Gate', 'GATE_AREA');
    this.locations.push({ zone: 'GATE', code, type: 'GATE_LANE', capacity: 1, single: false, pos: { x, z, rotY }, size: { x: 4.5, z: 16 }, label: code });
    return this;
  }

  /** Vị trí chứa trong nhà (không vẽ 3D) — tạo sức chứa pallet của site. */
  indoorStorage(prefix: string, count: number, capacityEach: number) {
    this.ensureZone('INDOOR', 'Indoor storage', 'WAREHOUSE');
    for (let i = 1; i <= count; i++) {
      this.locations.push({ zone: 'INDOOR', code: `${prefix}-${String(i).padStart(3, '0')}`, type: 'STORAGE', capacity: capacityEach, single: false, pos: { x: 0, z: 0, rotY: 0 }, size: { x: 1, z: 1 }, noLayout: true });
    }
    return this;
  }

  /** Sức chứa trong nhà sao cho tổng vị trí pallet (cả kho ngoài trời) đúng `total` — như video (1,800 / 4,200…). */
  indoorStorageTotal(prefix: string, total: number, capacityEach: number) {
    const outdoor = this.locations.filter((l) => l.type === 'STORAGE' && !l.noLayout).reduce((s, l) => s + l.capacity, 0);
    const remaining = Math.max(0, total - outdoor);
    const n = Math.floor(remaining / capacityEach);
    this.indoorStorage(prefix, n, capacityEach);
    const rest = remaining - n * capacityEach;
    if (rest > 0) this.locations.push({ zone: 'INDOOR', code: `${prefix}-${String(n + 1).padStart(3, '0')}`, type: 'STORAGE', capacity: rest, single: false, pos: { x: 0, z: 0, rotY: 0 }, size: { x: 1, z: 1 }, noLayout: true });
    return this;
  }

  add(kind: DecorSpec['kind'], x: number, z: number, extra: Partial<DecorSpec> = {}) {
    this.decor.push({ kind, x, z, ...extra });
    return this;
  }

  /** Đường thẳng (hình chữ nhật xoay) có vạch kẻ. */
  road(x1: number, z1: number, x2: number, z2: number, width = 12, opts: { lanes?: number; sidewalk?: boolean } = {}) {
    // Đường nội khu dừng ở đại lộ biên ô lưới của bản đồ mạng lưới (xem NETWORK_CELL)
    const cx = (v: number) => Math.max(-NETWORK_CELL.margin, Math.min(NETWORK_CELL.w - NETWORK_CELL.margin, v));
    const cz = (v: number) => Math.max(-NETWORK_CELL.margin, Math.min(NETWORK_CELL.d - NETWORK_CELL.margin, v));
    [x1, x2, z1, z2] = [cx(x1), cx(x2), cz(z1), cz(z2)];
    const len = Math.hypot(x2 - x1, z2 - z1);
    const rot = (Math.atan2(x2 - x1, z2 - z1) * 180) / Math.PI;
    this.decor.push({ kind: 'road', x: (x1 + x2) / 2, z: (z1 + z2) / 2, w: width, d: len, rotY: rot, props: { lanes: opts.lanes ?? 2, sidewalk: opts.sidewalk ?? true } });
    return this;
  }

  fence(x1: number, z1: number, x2: number, z2: number, green = false) {
    this.decor.push({ kind: 'fence', x: x1, z: z1, props: { x2, z2, green } });
    return this;
  }

  trees(points: Array<[number, number, number?]>) {
    for (const [x, z, s] of points) this.decor.push({ kind: 'tree', x, z, props: { size: s ?? 1 } });
    return this;
  }

  /** Lộ trình xe tải: đường vào (từ ngoài khung hình tới cổng) và đường ra. */
  lanes(entry: Array<[number, number]>, exit: Array<[number, number]>) {
    this.decor.push({ kind: 'lanes', x: 0, z: 0, props: { entry, exit } });
    return this;
  }

  build(): SiteLayoutSpec {
    return { bounds: this.bounds, zones: this.zones, locations: this.locations, buildings: this.buildings, decor: this.decor };
  }
}
