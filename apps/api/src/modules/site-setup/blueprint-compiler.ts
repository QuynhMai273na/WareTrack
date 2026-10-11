import type { SiteBlueprint } from '@waretrack/shared-schemas';
import { SITE_PLOT } from '@waretrack/shared-schemas';
import type { SiteLayoutSpec } from './layout/layout-spec';
import { avenues, NETWORK_CELL, SiteBuilder } from './layout/site-builder';

const twoDigits = (value: number) => String(value).padStart(2, '0');

/** Số nhịp mái theo kích thước nhà: mái răng cưa mỗi nhịp ~12 m, mái dốc mỗi nhịp ~32 m chiều sâu. */
function roofBays(roof: SiteBlueprint['buildings'][number]['roof'], width: number, depth: number) {
  if (roof === 'sawtooth') return Math.max(3, Math.round(width / 12));
  if (roof === 'gable') return Math.max(1, Math.round(depth / 32));
  return 1;
}

/**
 * Biên dịch bản thiết kế (blueprint) do admin vẽ thành đặc tả layout đầy đủ: zone, location (mã ổn định theo blueprint),
 * nhà kho, đường nội khu, lộ trình xe tải (lanes) và cây xanh — cùng định dạng với site demo nên scene 3D vẽ được ngay.
 */
export function compileBlueprint(siteName: string, blueprint: SiteBlueprint): SiteLayoutSpec {
  const builder = new SiteBuilder({ minX: SITE_PLOT.minX, minZ: SITE_PLOT.minZ, maxX: SITE_PLOT.maxX, maxZ: SITE_PLOT.maxZ });

  blueprint.buildings.forEach((building, buildingIndex) => {
    const isMainBuilding = buildingIndex === 0;
    builder.building(building.code, building.label, { x: building.x, z: building.z, w: building.width, d: building.depth }, building.height, {
      roof: building.roof,
      ridge: building.roof === 'sawtooth' ? 'z' : 'x',
      bays: roofBays(building.roof, building.width, building.depth),
      roofColor: building.roofColor,
      wallColor: building.wallColor,
      band: building.roof === 'flat',
      badge: isMainBuilding && building.roof !== 'flat' ? { u: 0.5, v: 0.5, size: Math.min(4.4, Math.max(2.4, building.width / 18)) } : null,
      sign: isMainBuilding ? { face: 'S', offset: building.width / 2, text: 'WareTrack', sub: siteName } : undefined,
    });
  });

  for (const dock of blueprint.docks) {
    builder.dock(dock.code, dock.label, dock.buildingCode, dock.face, dock.offset, dock.direction);
    // SiteBuilder dùng nhãn làm mã cho site demo; site thật giữ mã kỹ thuật riêng (ổn định khi đổi nhãn)
    const dockLocation = builder.locations[builder.locations.length - 1];
    dockLocation.code = dock.code;
    dockLocation.label = dock.label;
  }

  for (const grid of blueprint.stagingGrids) {
    let slotNumber = grid.startNumber;
    for (let rowIndex = 0; rowIndex < grid.rows; rowIndex++) {
      for (let columnIndex = 0; columnIndex < grid.columns; columnIndex++) {
        builder.slot(`${grid.codePrefix}${twoDigits(slotNumber)}`, `${grid.labelPrefix} ${slotNumber}`, grid.x + columnIndex * grid.spacing, grid.z + rowIndex * grid.spacing, {
          capacity: grid.capacityEach,
          w: Math.min(2.6, grid.spacing - 0.4),
          d: Math.min(2.6, grid.spacing - 0.4),
        });
        slotNumber++;
      }
    }
  }

  for (const rack of blueprint.racks) builder.rack(rack.code, rack.x, rack.z, { rotY: rack.rotation, levels: rack.levels, bays: rack.bays });

  for (const row of blueprint.yardRows) {
    for (let slotIndex = 0; slotIndex < row.count; slotIndex++) builder.yardSlot(`${row.codePrefix}${twoDigits(slotIndex + 1)}`, row.x + slotIndex * row.spacing, row.z, row.rotation);
  }

  for (const row of blueprint.chargerRows) {
    for (let chargerIndex = 0; chargerIndex < row.count; chargerIndex++) builder.charger(`${row.codePrefix}${chargerIndex + 1}`, row.x + chargerIndex * row.spacing, row.z, row.rotation);
  }

  const gate = blueprint.gate;
  builder.gate('GATE-IN', gate.x, gate.z, gate.rotation);
  builder.indoorStorageTotal(blueprint.indoorStorage.codePrefix, blueprint.indoorStorage.totalPallets, blueprint.indoorStorage.capacityEach);

  // Đường nội khu chạy ngang trước cổng, nối hai đại lộ biên ô lưới; xe vào từ phía đông, ra về phía tây
  const westEdge = -NETWORK_CELL.margin;
  const eastEdge = NETWORK_CELL.w - NETWORK_CELL.margin;
  const accessRoadZ = Math.min(SITE_PLOT.maxZ - 4, gate.z + 14);
  builder.road(westEdge, accessRoadZ, eastEdge, accessRoadZ, 14);
  builder.lanes(
    [
      [eastEdge + 40, accessRoadZ - 2],
      [gate.x + 6, accessRoadZ - 2],
      [gate.x, gate.z + 8],
      [gate.x, gate.z - 2],
    ],
    [
      [gate.x - 10, gate.z - 4],
      [gate.x - 14, accessRoadZ + 2],
      [westEdge - 40, accessRoadZ + 2],
    ],
  );

  if (blueprint.landscaping) {
    const treeLineZ = accessRoadZ - 11;
    const treePoints: Array<[number, number, number]> = [];
    for (let treeX = westEdge + 14; treeX < eastEdge - 10; treeX += 12) {
      const nearGate = Math.abs(treeX - gate.x) < 16;
      if (!nearGate) treePoints.push([treeX, treeLineZ, 0.85 + ((treeX * 7) % 3) * 0.08]);
    }
    builder.trees(treePoints);
  }

  avenues(builder, { east: true, south: true });
  return builder.build();
}

/** Bản thiết kế mặc định cho site mới: một nhà kho, 4 dock phía nam, staging, cổng và bãi chờ. */
export function defaultBlueprint(siteCode: string, siteName: string): SiteBlueprint {
  return {
    version: 1,
    buildings: [{ id: 'building-main', code: 'BLD-1', label: `${siteCode} · ${siteName}`, x: 20, z: 10, width: 72, depth: 40, height: 9, roof: 'gable', roofColor: '#2f6fe4', wallColor: '#e8eef8' }],
    docks: [1, 2, 3, 4].map((dockNumber) => ({
      id: `dock-${dockNumber}`,
      code: `DOCK-${dockNumber}`,
      label: `Bay ${dockNumber}`,
      buildingCode: 'BLD-1',
      face: 'S' as const,
      offset: 12 + (dockNumber - 1) * 14,
      direction: 'BOTH' as const,
    })),
    stagingGrids: [{ id: 'staging-1', codePrefix: 'S', labelPrefix: 'Staging', x: 100, z: 18, rows: 2, columns: 4, capacityEach: 2, spacing: 3.4, startNumber: 1 }],
    racks: [{ id: 'rack-1', code: 'R-01', x: 104, z: 34, rotation: 0, levels: 3, bays: 2 }],
    yardRows: [{ id: 'yard-1', codePrefix: 'Y', x: 120, z: 64, count: 4, rotation: 0, spacing: 6 }],
    chargerRows: [{ id: 'chargers-1', codePrefix: 'C', x: 8, z: 24, count: 2, rotation: 90, spacing: 4 }],
    gate: { x: 160, z: 96, rotation: 0 },
    indoorStorage: { codePrefix: 'A', totalPallets: 1200, capacityEach: 30 },
    landscaping: true,
  };
}
