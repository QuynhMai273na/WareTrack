/**
 * Sơ đồ 5 site theo video tham chiếu (DEC-56): Riverside Hub, Northgate DC, Eastport Cold Chain,
 * Southfield Cross-Dock, Westgate Robotics Hub. Kích thước/vị trí ước lượng từ khung hình video.
 */
import { avenues, SiteBuilder } from './builder';
import type { SiteLayoutSpec } from './layout';

const BLUE = '#2f6fe4';
const WALL = '#eef2fb';
const WHITE = '#f4f6fb';

/** Cây theo hàng. */
const row = (x1: number, z1: number, x2: number, z2: number, count: number, size = 1): Array<[number, number, number]> =>
  Array.from({ length: count }, (_, treeIndex) => [x1 + ((x2 - x1) * treeIndex) / Math.max(1, count - 1), z1 + ((z2 - z1) * treeIndex) / Math.max(1, count - 1), size * (0.85 + ((treeIndex * 37) % 30) / 100)]);

/** WH-01 Riverside Hub (Depot): nhà kho 2 khối mái xanh, 2 bay phía trước, container MAERA LINE bên trái. */
export function riverside(): SiteLayoutSpec {
  const builder = new SiteBuilder({ minX: -40, minZ: -40, maxX: 150, maxZ: 120 });
  builder.building('BLD-A', 'WH-01', { x: 24, z: 14, w: 26, d: 18 }, 7, {
    roof: 'gable', ridge: 'x', bays: 1, roofColor: BLUE, wallColor: WALL, badge: null,
    doors: [{ face: 'S', offset: 6, open: true, cargo: true }],
  });
  builder.building('BLD-A0', '', { x: 18, z: 17, w: 6, d: 12 }, 5, { roof: 'gable', ridge: 'z', bays: 1, roofColor: BLUE, wallColor: WALL, badge: null });
  builder.building('BLD-B', 'WH-01', { x: 34, z: 26, w: 30, d: 18 }, 6.5, {
    roof: 'gable', ridge: 'x', bays: 1, roofColor: BLUE, wallColor: WALL, badge: { u: 0.45, v: 0.5, size: 2.6 },
    doors: [
      { face: 'S', offset: 24, open: true, cargo: true },
      { face: 'E', offset: 6, open: true, cargo: true },
    ],
    sign: { face: 'S', offset: 19, text: 'WareTrack', sub: 'WH-01 · Riverside Hub' },
  });
  builder.dock('BAY-2', 'Bay 2', 'BLD-B', 'S', 5);
  builder.dock('BAY-1', 'Bay 1', 'BLD-B', 'S', 13);
  // Staging bên trái (pallet carton) + 3 pallet chờ xuất có ghim bên phải
  [[8, 38], [13, 38], [18, 38], [8, 44], [13, 44], [18, 44], [11, 50]].forEach(([x, z], slotIndex) => builder.slot(`S${String(slotIndex + 1).padStart(2, '0')}`, `Yard slot S${String(slotIndex + 1).padStart(2, '0')}`, x, z));
  builder.slot('S10', 'Staging lane 10', 72, 30).slot('S11', 'Staging lane 11', 68, 40).slot('S12', 'Staging lane 12', 60, 51);
  // Kho ngoài trời: rack carton + 2 chồng thùng nhựa xanh + 1 pallet trắng
  builder.rack('R-01', 56, 10, { levels: 3, bays: 2 });
  builder.slot('Y01', 'Yard storage Y01', 45, 8, { type: 'STORAGE', capacity: 4, w: 5 }).slot('Y02', 'Yard storage Y02', 70, 17, { type: 'STORAGE', capacity: 4, w: 5 }).slot('Y03', 'Yard storage Y03', 74, 24, { type: 'STORAGE', capacity: 2 });
  builder.charger('C1', 4, 24, 90).charger('C2', 4, 28.5, 90);
  builder.add('pad', 4.5, 26, { w: 7, d: 10, color: '#dff3e6' });
  builder.yardSlot('Y-01', 78, 58).yardSlot('Y-02', 84, 58);
  builder.gate('GATE-IN', 90, 82);
  builder.indoorStorageTotal('A', 1800, 30);
  builder.add('container', -3, 40, { color: '#2bb3a3', label: 'MAERA LINE' });
  builder.road(100, -60, 100, 140, 14).road(-60, 94, 160, 94, 14);
  builder.add('crosswalk', 100, 80, { w: 14, d: 4 });
  builder.trees([...row(36, 4, 80, 4, 5, 1.05), ...row(86, 12, 86, 44, 4, 1), [28, 6, 1], [-12, 18, 0.9]]);
  builder.add('bush', 50, 4).add('bush', 88, 50);
  builder.add('neighbor', 124, 20, { w: 24, d: 40, h: 16, props: { style: 'office' } });
  builder.add('neighbor', 124, 76, { w: 24, d: 30, h: 12, props: { style: 'office' } });
  builder.add('neighbor', -28, -24, { w: 30, d: 26, h: 8, props: { style: 'warehouse' } });
  builder.add('neighbor', 24, -26, { w: 30, d: 16, h: 11, props: { style: 'office' } });
  builder.lanes([[180, 90.5], [94, 90.5], [90, 86], [90, 78]], [[46, 72], [40, 84], [36, 90.5], [-80, 90.5]]);
  avenues(builder, {});
  return builder.build();
}

/** WH-02 Northgate DC: nhà kho dài 6 cửa, góc văn phòng kính, staging thùng xanh trước cửa. */
export function northgate(): SiteLayoutSpec {
  const builder = new SiteBuilder({ minX: -40, minZ: -40, maxX: 170, maxZ: 130 });
  builder.building('BLD-1', 'WH-02 · Northgate DC', { x: 10, z: 10, w: 74, d: 30 }, 8.5, {
    roof: 'gable', ridge: 'x', bays: 2, roofColor: BLUE, wallColor: WALL, badge: { u: 0.55, v: 0.5, size: 4.2 },
    roofUnits: [[0.12, 0.3, 2]],
    office: { face: 'S', offset: 1, width: 10, height: 9 },
    doors: [
      { face: 'S', offset: 14, open: true, cargo: true, label: 'D1' },
      { face: 'S', offset: 58, open: true, cargo: true, label: 'D6' },
      { face: 'S', offset: 67, open: true, cargo: true, label: 'D7' },
    ],
    sign: { face: 'S', offset: 12, text: 'WareTrack', sub: 'WH-02 · Northgate DC' },
  });
  ['BAY-1', 'BAY-2', 'BAY-3', 'BAY-4'].forEach((dockCode, dockIndex) => builder.dock(dockCode, `Bay ${dockIndex + 1}`, 'BLD-1', 'S', 22 + dockIndex * 9));
  // 5 pallet staged trước cửa D6–D7 (thùng xanh + carton) + vài pallet có ghim bên trái
  [[72, 49], [76, 49], [80, 49], [84, 49], [72, 54], [76, 54], [80, 54], [84, 54]].forEach(([x, z], slotIndex) => builder.slot(`S${String(slotIndex + 1).padStart(2, '0')}`, `Staging lane ${slotIndex + 1}`, x, z));
  builder.slot('S20', 'Yard slot S20', -4, 66).slot('S21', 'Yard slot S21', 0, 70);
  builder.rack('R-01', 104, 14, { levels: 3, bays: 2 }).rack('R-02', 104, 22, { levels: 3, bays: 2 });
  builder.slot('Y01', 'Yard storage Y01', 112, 32, { type: 'STORAGE', capacity: 4, w: 5.4 });
  builder.charger('C1', 100, 40, -90).charger('C2', 100, 44, -90).charger('C3', 100, 48, -90).charger('C4', 100, 52, -90);
  builder.add('pad', 102, 46, { w: 7, d: 16, color: '#dff3e6' });
  [0, 1, 2, 3, 4].forEach((slotIndex) => builder.yardSlot(`Y-0${slotIndex + 1}`, 30 + slotIndex * 7, 84));
  builder.gate('GATE-IN', 126, 96);
  builder.indoorStorageTotal('A', 4200, 30);
  builder.road(140, -60, 140, 160, 14).road(-60, 112, 180, 112, 14);
  builder.fence(126, 0, 126, 100, true);
  builder.trees([...row(124, 6, 124, 96, 7, 1), ...row(20, 0, 90, 0, 6, 1.1)]);
  builder.add('container', -8, 30, { color: '#2bb3a3', label: 'MAERA LINE' });
  builder.add('neighbor', 162, 30, { w: 24, d: 46, h: 16, props: { style: 'office' } });
  builder.add('neighbor', 40, -26, { w: 50, d: 16, h: 10, props: { style: 'warehouse' } });
  builder.lanes([[200, 108.5], [130, 108.5], [126, 102], [126, 92]], [[60, 80], [50, 100], [46, 108.5], [-80, 108.5]]);
  avenues(builder, {});
  return builder.build();
}

/** WH-03 Eastport Cold Chain: kho lạnh mái phẳng trắng, nhiều cụm máy lạnh, sàn dock nâng viền vàng, silo. */
export function eastport(): SiteLayoutSpec {
  const builder = new SiteBuilder({ minX: -60, minZ: -50, maxX: 160, maxZ: 130 });
  const units: Array<[number, number, number]> = [];
  for (let rowIndex = 0; rowIndex < 3; rowIndex++) for (let columnIndex = 0; columnIndex < 5; columnIndex++) units.push([0.14 + columnIndex * 0.18, 0.2 + rowIndex * 0.28, 2]);
  builder.building('BLD-1', 'WH-03 · Eastport Cold Chain', { x: 20, z: 10, w: 60, d: 40 }, 8.5, {
    roof: 'flat', roofColor: WHITE, wallColor: WHITE, band: true, roofUnits: units, badge: { u: 0.5, v: 0.5, size: 2.2 },
    doors: [
      { face: 'S', offset: 12, open: false },
      { face: 'S', offset: 44, open: true, cargo: true },
    ],
    platform: { face: 'S', from: 4, to: 52, depth: 5 },
    sign: { face: 'S', offset: 50, text: 'WareTrack', sub: 'WH-03 · Eastport Cold Chain' },
  });
  builder.building('BLD-2', '', { x: 0, z: 18, w: 20, d: 30 }, 7, { roof: 'flat', roofColor: WHITE, wallColor: WHITE, band: true, roofUnits: [[0.3, 0.3, 3], [0.3, 0.7, 3]], badge: null });
  ['BAY-1', 'BAY-2', 'BAY-3'].forEach((dockCode, dockIndex) => builder.dock(dockCode, `Bay ${dockIndex + 1}`, 'BLD-1', 'S', 20 + dockIndex * 8, 'INBOUND'));
  builder.charger('C1', 10, 52, 0).charger('C2', 14, 52, 0).charger('C3', 18, 52, 0);
  builder.slot('Y01', 'Cold yard Y01', 78, 64, { type: 'STORAGE', capacity: 2 }).slot('Y02', 'Cold yard Y02', 88, 60, { type: 'STORAGE', capacity: 2 });
  builder.rack('R-01', -30, 96, { levels: 3, bays: 2, rotY: 90 });
  builder.gate('GATE-IN', 104, 92);
  builder.indoorStorageTotal('C', 1400, 20);
  builder.road(-60, 104, 180, 104, 16).road(130, -60, 130, 160, 14).road(-48, -60, -48, 160, 12);
  builder.add('crosswalk', 130, 86, { w: 14, d: 4 }).add('crosswalk', 114, 104, { w: 4, d: 16 });
  builder.fence(-36, 92, 116, 92, true);
  builder.trees([...row(-30, 88, 110, 88, 12, 0.9), ...row(118, 10, 118, 80, 5, 0.9)]);
  [[-32, -18], [-24, -18], [-32, -9], [-24, -9]].forEach(([x, z]) => builder.add('silo', x, z, { h: 12 }));
  builder.add('shed', 104, 70, { w: 10, d: 8, h: 6, color: '#3b6fe0' }).add('shed', 118, 118, { w: 12, d: 10, h: 6, color: '#3b6fe0' });
  builder.add('container', 96, 120, { color: '#2bb3a3', label: 'MAERA LINE', rotY: 90 }).add('container', 56, -18, { color: '#3b6fe0', label: null as unknown as string, rotY: 90 });
  builder.add('neighbor', -40, -40, { w: 30, d: 20, h: 14, props: { style: 'office' } });
  builder.add('neighbor', 150, 10, { w: 24, d: 30, h: 16, props: { style: 'office' } });
  builder.lanes([[200, 100], [108, 100], [104, 96], [104, 88]], [[60, 80], [40, 96], [36, 100], [-90, 100]]);
  avenues(builder, { east: true });
  return builder.build();
}

/** WH-04 Southfield Cross-Dock: mái răng cưa 4 nhịp, In 1–3 mặt trước bên trái, Out 1–3 mặt đông, dãy trạm sạc. */
export function southfield(): SiteLayoutSpec {
  const builder = new SiteBuilder({ minX: -50, minZ: -40, maxX: 170, maxZ: 130 });
  builder.building('BLD-1', 'WH-04 · Southfield Cross-Dock', { x: 20, z: 8, w: 76, d: 46 }, 7.5, {
    roof: 'sawtooth', ridge: 'z', bays: 4, roofColor: BLUE, wallColor: WALL, badge: { u: 0.62, v: 0.35, size: 4.4 },
    doors: [
      { face: 'S', offset: 34, open: true, cargo: true },
      { face: 'S', offset: 46, open: true, cargo: true },
      { face: 'S', offset: 58, open: true, cargo: true },
      { face: 'S', offset: 70, open: true, cargo: true },
      { face: 'E', offset: 6, open: true, cargo: true },
      { face: 'E', offset: 44, open: true, cargo: true },
    ],
    sign: { face: 'S', offset: 76, text: 'WareTrack', sub: 'WH-04 · Southfield Cross-Dock' },
  });
  builder.dock('IN-1', 'In 1', 'BLD-1', 'S', 4, 'INBOUND').dock('IN-2', 'In 2', 'BLD-1', 'S', 12, 'INBOUND').dock('IN-3', 'In 3', 'BLD-1', 'S', 20, 'INBOUND');
  builder.dock('OUT-1', 'Out 1', 'BLD-1', 'E', 14, 'OUTBOUND').dock('OUT-2', 'Out 2', 'BLD-1', 'E', 24, 'OUTBOUND').dock('OUT-3', 'Out 3', 'BLD-1', 'E', 34, 'OUTBOUND');
  ['C1', 'C2', 'C3', 'C4', 'C5'].forEach((chargerCode, chargerIndex) => builder.charger(chargerCode, 2 + chargerIndex * 3.4, 6, 180));
  builder.add('pad', 9, 6, { w: 20, d: 7, color: '#dff3e6' });
  // 9 pallet staged giữa sân (carton + thùng xanh) — 2 ghim
  [[46, 70], [50, 70], [54, 70], [58, 70], [46, 75], [50, 75], [54, 75], [58, 75], [62, 72]].forEach(([x, z], slotIndex) => builder.slot(`S${String(slotIndex + 1).padStart(2, '0')}`, `Staging lane ${slotIndex + 1}`, x, z));
  builder.slot('S20', 'Yard slot S20', 36, 80).slot('S21', 'Yard slot S21', 40, 84);
  [0, 1, 2].forEach((slotIndex) => builder.yardSlot(`Y-0${slotIndex + 1}`, -14 + slotIndex * 6, 36));
  builder.gate('GATE-IN', 120, 98);
  builder.indoorStorageTotal('X', 1600, 20);
  builder.road(-60, 112, 180, 112, 16).road(150, -60, 150, 160, 14);
  builder.fence(-40, 98, 132, 98, false);
  builder.trees([[-6, 92, 1], [128, 40, 1], [132, 60, 0.9], ...row(30, -4, 90, -4, 5, 1)]);
  builder.add('neighbor', 175, 20, { w: 24, d: 40, h: 15, props: { style: 'office' } });
  builder.lanes([[200, 108], [124, 108], [120, 102], [120, 94]], [[70, 90], [50, 100], [46, 108], [-90, 108]]);
  avenues(builder, { south: true });
  return builder.build();
}

/** WH-05 Westgate Robotics Hub: kho trắng viền navy, 4 bay, bãi sạc xanh, hàng rào + cây dọc đường. */
export function westgate(): SiteLayoutSpec {
  const builder = new SiteBuilder({ minX: -40, minZ: -40, maxX: 170, maxZ: 130 });
  builder.building('BLD-1', 'WH-05 · Westgate Robotics Hub', { x: 10, z: 6, w: 70, d: 36 }, 9.5, {
    roof: 'flat', roofColor: WHITE, wallColor: WHITE, band: true, roofUnits: [[0.1, 0.25, 3], [0.22, 0.25, 3]], badge: null,
    doors: [{ face: 'S', offset: 64, open: false }],
    sign: { face: 'S', offset: 36, text: 'WareTrack', sub: 'WH-05 · Westgate Robotics Hub' },
  });
  ['BAY-1', 'BAY-2', 'BAY-3', 'BAY-4'].forEach((dockCode, dockIndex) => builder.dock(dockCode, `Bay ${dockIndex + 1}`, 'BLD-1', 'S', 16 + dockIndex * 12));
  builder.charger('C1', 104, 30, -90).charger('C2', 104, 34, -90).charger('C3', 104, 38, -90);
  builder.add('pad', 106, 34, { w: 8, d: 13, color: '#dff3e6' });
  [[32, 46], [44, 46], [56, 46], [68, 46], [32, 50], [44, 50], [56, 50], [68, 50]].forEach(([x, z], slotIndex) => builder.slot(`S${String(slotIndex + 1).padStart(2, '0')}`, `Dock lane ${slotIndex + 1}`, x, z, { w: 2.4, d: 2.4 }));
  builder.gate('GATE-IN', 112, 90);
  builder.indoorStorageTotal('R', 2400, 30);
  builder.road(-60, 104, 180, 104, 16).road(140, -60, 140, 160, 14);
  builder.fence(-30, 92, 126, 92, true);
  builder.trees([...row(-24, 88, 120, 88, 11, 0.95), [96, 10, 1], [116, 14, 0.9]]);
  builder.add('neighbor', 150, 70, { w: 26, d: 40, h: 18, props: { style: 'office' } });
  builder.add('neighbor', -30, 120, { w: 30, d: 20, h: 10, props: { style: 'warehouse' } });
  builder.lanes([[200, 100], [116, 100], [112, 94], [112, 86]], [[60, 80], [40, 96], [36, 100], [-90, 100]]);
  avenues(builder, { east: true, south: true });
  return builder.build();
}
