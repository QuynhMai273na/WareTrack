/**
 * Bộ dựng layout thủ tục cho site demo (DEC-56): không có bản vẽ thật, layout hư cấu theo phong cách video.
 * Kiểu dữ liệu dùng chung nằm ở src/modules/site-setup/layout/layout-spec.ts.
 */
import type { DockDirection } from '@prisma/client';
import type { BuildingSpec, DecorSpec, LocationSpec, SiteLayoutSpec, ZoneSpec } from '../../src/modules/site-setup/layout/layout-spec';

export type { BuildingSpec, DecorSpec, LocationSpec, SiteLayoutSpec, ZoneSpec } from '../../src/modules/site-setup/layout/layout-spec';

export interface WarehouseOptions {
  docks: Array<{ code: string; direction: DockDirection }>;
  rackRows: number;
  rackBays: number;
  yardSlots: number;
  parkingRows?: number;
  parkingCols?: number;
  chargers: number;
  buildingColor?: string;
  label: string;
}

const BLUE_ROOF = '#2f6fe4';
const WALL = '#e8eef8';

/** Kho tiêu chuẩn: nhà kho có dãy dock phía nam, khu staging + rack ngoài trời phía đông, bãi chờ xe tải phía nam. */
export function warehouseLayout(o: WarehouseOptions): SiteLayoutSpec {
  const zones: ZoneSpec[] = [];
  const locations: LocationSpec[] = [];
  const decor: DecorSpec[] = [];

  const dockSpacing = 9;
  const buildingW = Math.max(40, o.docks.length * dockSpacing + 16);
  const building: BuildingSpec = {
    code: 'BLD-1',
    label: o.label,
    rect: { x: 10, z: 10, w: buildingW, d: 28 },
    height: 9,
    roofColor: o.buildingColor ?? BLUE_ROOF,
    wallColor: WALL,
  };
  const frontZ = building.rect.z + building.rect.d; // tường phía nam

  zones.push({ code: 'WH', name: 'Warehouse', zoneType: 'WAREHOUSE', rect: building.rect, color: '#dbe4f3' });

  // Dock dọc tường nam — cửa quay về phía nam (rotY = 0 nghĩa là mặt hướng +Z trong scene)
  zones.push({ code: 'DOCKS', name: 'Dock apron', zoneType: 'YARD', rect: { x: building.rect.x, z: frontZ, w: buildingW, d: 22 }, color: '#e9edf5' });
  const firstDockX = building.rect.x + (buildingW - (o.docks.length - 1) * dockSpacing) / 2;
  o.docks.forEach((d, i) => {
    locations.push({
      zone: 'DOCKS',
      code: d.code,
      type: 'DOCK',
      capacity: 1,
      single: true,
      pos: { x: firstDockX + i * dockSpacing, z: frontZ, rotY: 0 },
      size: { x: 4.2, z: 18 },
      dockDirection: d.direction,
      doorNumber: String(i + 1),
      lengthM: 18,
      widthM: 4.2,
    });
  });

  // Staging + rack ngoài trời phía đông nhà kho
  const eastX = building.rect.x + buildingW + 8;
  zones.push({ code: 'STG', name: 'Staging', zoneType: 'STAGING', rect: { x: eastX, z: frontZ - 12, w: 24, d: 14 }, color: '#fff3d6' });
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 5; c++) {
      locations.push({
        zone: 'STG',
        code: `STG-${r + 1}${String.fromCharCode(65 + c)}`,
        type: 'STAGING',
        capacity: 6,
        single: false,
        pos: { x: eastX + 3 + c * 4.4, z: frontZ - 8 + r * 5.5, rotY: 0 },
        size: { x: 2.4, z: 2.4 },
      });
    }
  }
  zones.push({ code: 'RACK', name: 'Rack area', zoneType: 'WAREHOUSE', rect: { x: eastX, z: building.rect.z, w: 30, d: 16 }, color: '#e3ecfb' });
  for (let r = 0; r < o.rackRows; r++) {
    for (let b = 0; b < o.rackBays; b++) {
      locations.push({
        zone: 'RACK',
        code: `R-${String.fromCharCode(65 + r)}-${String(b + 1).padStart(2, '0')}`,
        type: 'STORAGE',
        capacity: 2,
        single: false,
        pos: { x: eastX + 2.5 + b * 2.9, z: building.rect.z + 3 + r * 5, rotY: 0 },
        size: { x: 2.6, z: 1.6 },
      });
    }
  }
  zones.push({ code: 'QUAR', name: 'Quarantine', zoneType: 'QUARANTINE', rect: { x: eastX + 26, z: frontZ - 12, w: 8, d: 8 }, color: '#fde2e2' });
  locations.push({ zone: 'QUAR', code: 'Q-01', type: 'QUARANTINE', capacity: 4, single: false, pos: { x: eastX + 30, z: frontZ - 8, rotY: 0 }, size: { x: 6, z: 6 } });

  // Bãi chờ xe tải phía nam
  const yardZ = frontZ + 34;
  zones.push({ code: 'YARD', name: 'Truck yard', zoneType: 'YARD', rect: { x: building.rect.x, z: yardZ - 4, w: o.yardSlots * 6 + 8, d: 20 }, color: '#eef1f6' });
  for (let i = 0; i < o.yardSlots; i++) {
    locations.push({ zone: 'YARD', code: `Y-${String(i + 1).padStart(2, '0')}`, type: 'YARD_SLOT', capacity: 1, single: true, pos: { x: building.rect.x + 6 + i * 6, z: yardZ + 6, rotY: 0 }, size: { x: 4, z: 16 } });
  }

  // Cổng
  const gateX = Math.max(eastX + 40, building.rect.x + o.yardSlots * 6 + 24);
  zones.push({ code: 'GATE', name: 'Gate', zoneType: 'GATE_AREA', rect: { x: gateX - 6, z: yardZ - 4, w: 12, d: 20 }, color: '#e6f4ea' });
  locations.push({ zone: 'GATE', code: 'GATE-IN', type: 'GATE_LANE', capacity: 1, single: false, pos: { x: gateX - 2.5, z: yardZ + 6, rotY: 0 }, size: { x: 4, z: 16 } });
  locations.push({ zone: 'GATE', code: 'GATE-OUT', type: 'GATE_LANE', capacity: 1, single: false, pos: { x: gateX + 2.5, z: yardZ + 6, rotY: 0 }, size: { x: 4, z: 16 } });

  // Trạm sạc xe nâng phía tây
  zones.push({ code: 'CHG', name: 'Charging', zoneType: 'CHARGING', rect: { x: 0, z: frontZ - 12, w: 8, d: o.chargers * 4 + 2 }, color: '#e8f7ee' });
  for (let i = 0; i < o.chargers; i++) {
    locations.push({ zone: 'CHG', code: `C${i + 1}`, type: 'CHARGER', capacity: 1, single: false, pos: { x: 4, z: frontZ - 10 + i * 4, rotY: 0 }, size: { x: 3, z: 3 } });
  }

  let maxZ = yardZ + 24;
  // Bãi lưu xe ô tô (khi có)
  if (o.parkingRows && o.parkingCols) {
    const pz = yardZ + 26;
    zones.push({ code: 'VS', name: 'Vehicle storage', zoneType: 'VEHICLE_STORAGE', rect: { x: building.rect.x, z: pz, w: o.parkingCols * 3 + 6, d: o.parkingRows * 7 + 4 }, color: '#edf0ff' });
    for (let r = 0; r < o.parkingRows; r++) {
      for (let c = 0; c < o.parkingCols; c++) {
        locations.push({
          zone: 'VS',
          code: `P-${String.fromCharCode(65 + r)}-${String(c + 1).padStart(3, '0')}`,
          type: 'PARKING_SLOT',
          capacity: 1,
          single: true,
          pos: { x: building.rect.x + 4 + c * 3, z: pz + 4 + r * 7, rotY: 0 },
          size: { x: 2.6, z: 5.4 },
          lengthM: 5.4,
          widthM: 2.6,
        });
      }
    }
    zones.push({ code: 'REL', name: 'Release staging', zoneType: 'VEHICLE_STORAGE', rect: { x: building.rect.x + o.parkingCols * 3 + 10, z: pz, w: 12, d: 10 }, color: '#f3e8ff' });
    locations.push({ zone: 'REL', code: 'REL-01', type: 'STAGING', capacity: 4, single: false, pos: { x: building.rect.x + o.parkingCols * 3 + 16, z: pz + 5, rotY: 0 }, size: { x: 10, z: 8 } });
    maxZ = pz + o.parkingRows * 7 + 10;
  }

  const maxX = gateX + 20;
  // Trang trí: đường, cây, container
  decor.push({ kind: 'road', x: maxX / 2, z: yardZ + 18, w: maxX + 20, d: 8 });
  decor.push({ kind: 'road', x: gateX + 12, z: (yardZ + 18) / 2, w: 8, d: yardZ + 18, rotY: 0 });
  for (let i = 0; i < 9; i++) decor.push({ kind: 'tree', x: -4 + i * 15, z: -6 });
  for (let i = 0; i < 5; i++) decor.push({ kind: 'tree', x: maxX - 4, z: 4 + i * 12 });
  decor.push({ kind: 'container', x: building.rect.x - 6, z: frontZ + 10, rotY: 90, color: '#2bb3a3', label: 'MARLIN LINE' });
  decor.push({ kind: 'cones', x: gateX, z: yardZ - 2 });

  return { bounds: { minX: -12, minZ: -12, maxX, maxZ }, zones, locations, buildings: [building], decor };
}
