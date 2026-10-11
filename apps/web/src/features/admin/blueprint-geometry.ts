import type { BlueprintBuilding, BuildingFace, SiteBlueprint } from '@waretrack/shared-schemas';

/** Hình học dùng chung của trình vẽ sơ đồ — khớp SiteBuilder phía API (mét, +X đông, +Z nam). */

export const DOCK_DOOR_WIDTH = 4.4;
export const DOCK_APRON_DEPTH = 18;
export const RACK_BAY_WIDTH = 2.8;
export const RACK_DEPTH = 1.6;
export const YARD_SLOT_SIZE = { width: 4.2, depth: 17 };
export const CHARGER_SIZE = { width: 3, depth: 3.4 };
export const GATE_SIZE = { width: 4.5, depth: 16 };

export type BlueprintObjectKind = 'building' | 'dock' | 'staging' | 'rack' | 'yard' | 'charger' | 'gate';

export interface BlueprintSelection {
  kind: BlueprintObjectKind;
  id: string;
}

/** Điểm giữa cửa dock trên mặt nhà (offset tính từ góc trái của mặt khi nhìn từ ngoài vào). */
export function dockDoorPoint(building: BlueprintBuilding, face: BuildingFace, offset: number) {
  switch (face) {
    case 'S':
      return { x: building.x + offset, z: building.z + building.depth };
    case 'N':
      return { x: building.x + building.width - offset, z: building.z };
    case 'E':
      return { x: building.x + building.width, z: building.z + building.depth - offset };
    case 'W':
      return { x: building.x, z: building.z + offset };
  }
}

/** Hướng ra ngoài của mặt nhà (vector đơn vị). */
export function faceOutward(face: BuildingFace) {
  return { S: { x: 0, z: 1 }, N: { x: 0, z: -1 }, E: { x: 1, z: 0 }, W: { x: -1, z: 0 } }[face];
}

export function faceLength(building: BlueprintBuilding, face: BuildingFace) {
  return face === 'S' || face === 'N' ? building.width : building.depth;
}

/** Offset trên mặt nhà gần nhất với một điểm (để kéo dock dọc theo tường). */
export function offsetAlongFace(building: BlueprintBuilding, face: BuildingFace, point: { x: number; z: number }) {
  const raw = {
    S: point.x - building.x,
    N: building.x + building.width - point.x,
    E: building.z + building.depth - point.z,
    W: point.z - building.z,
  }[face];
  return Math.max(3, Math.min(faceLength(building, face) - 3, Math.round(raw)));
}

/** Kích thước một dãy rack theo số khoang. */
export function rackFootprint(bays: number, rotation: number) {
  const along = RACK_BAY_WIDTH * bays;
  return Math.abs(rotation) === 90 ? { width: RACK_DEPTH, depth: along } : { width: along, depth: RACK_DEPTH };
}

/** Thống kê sức chứa để hiển thị tóm tắt trước khi publish. */
export function blueprintSummary(blueprint: SiteBlueprint) {
  const stagingSlots = blueprint.stagingGrids.reduce((sum, grid) => sum + grid.rows * grid.columns, 0);
  const stagingCapacity = blueprint.stagingGrids.reduce((sum, grid) => sum + grid.rows * grid.columns * grid.capacityEach, 0);
  const rackCapacity = blueprint.racks.reduce((sum, rack) => sum + rack.levels * rack.bays, 0);
  const yardSlots = blueprint.yardRows.reduce((sum, row) => sum + row.count, 0);
  const chargers = blueprint.chargerRows.reduce((sum, row) => sum + row.count, 0);
  const storagePositions = Math.max(blueprint.indoorStorage.totalPallets, rackCapacity);
  return { docks: blueprint.docks.length, stagingSlots, stagingCapacity, rackCapacity, yardSlots, chargers, storagePositions };
}

/** Mã chưa dùng tiếp theo theo mẫu `${prefix}${n}`. */
export function nextFreeCode(existing: string[], prefix: string, width = 2) {
  const taken = new Set(existing);
  for (let sequence = 1; ; sequence++) {
    const candidate = `${prefix}${String(sequence).padStart(width, '0')}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Tiền tố ô chưa dùng (S, T, U…) cho lưới staging / hàng yard mới. */
export function nextFreePrefix(existing: string[], candidates: string[]) {
  return candidates.find((candidate) => !existing.includes(candidate)) ?? `${candidates[0]}${existing.length + 1}`;
}

export const newObjectId = (kind: BlueprintObjectKind) => `${kind}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1296).toString(36)}`;
