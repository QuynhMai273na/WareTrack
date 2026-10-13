import type { SiteSnapshot } from '@waretrack/shared-schemas';
import { useRef } from 'react';
import { type LayoutIndex, outward, type Placed, tangent } from './layoutIndex';

type SnapshotPallet = SiteSnapshot['pallets'][number];

/** Loại vị trí có vẽ pallet trên bản đồ 3D (kho trong nhà không có layout → không vẽ). */
const DISPLAYED_TYPES = ['STAGING', 'STORAGE', 'DOCK', 'QUARANTINE', 'YARD_SLOT'];

export interface PalletPose {
  x: number;
  y: number;
  z: number;
  rotY: number;
  scale: number;
}

export interface DisplayedPallet {
  pallet: SnapshotPallet;
  placed: Placed;
  slotIndex: number;
  pose: PalletPose;
}

/** Số ô vẽ tối đa của một vị trí (dock xếp cạnh đuôi xe, ô sàn/rack). */
export const slotCapacity = (placed: Placed) => (placed.type === 'DOCK' ? 6 : placed.display === 'rack' ? placed.levels * placed.bays : 12);

/** Vị trí ô thứ `slotIndex` của một location: ô sàn xếp lưới, rack theo tầng/khoang, dock xếp cạnh đuôi xe. */
export function palletSlotPose(placed: Placed, slotIndex: number): PalletPose {
  const rotate = (localX: number, localZ: number) => ({ x: placed.x + localX * Math.cos(placed.rotY) + localZ * Math.sin(placed.rotY), z: placed.z - localX * Math.sin(placed.rotY) + localZ * Math.cos(placed.rotY) });
  if (placed.display === 'rack') {
    const level = Math.floor(slotIndex / placed.bays) % placed.levels;
    const bay = slotIndex % placed.bays;
    const bayWidth = placed.sx / placed.bays;
    const slotPosition = rotate(-placed.sx / 2 + bayWidth * (bay + 0.5), 0);
    return { x: slotPosition.x, y: 0.2 + level * 1.5, z: slotPosition.z, rotY: placed.rotY, scale: 1 };
  }
  if (placed.type === 'DOCK') {
    const outwardDirection = outward(placed);
    const tangentDirection = tangent(placed);
    const side = slotIndex % 2 === 0 ? 1 : -1;
    const stackRow = Math.floor(slotIndex / 2);
    return { x: placed.x + outwardDirection.x * (2.2 + stackRow * 1.7) + tangentDirection.x * side * 4.2, y: 0, z: placed.z + outwardDirection.z * (2.2 + stackRow * 1.7) + tangentDirection.z * side * 4.2, rotY: placed.rotY, scale: 1.3 };
  }
  const columns = placed.sx > 4 ? 3 : 2;
  const column = slotIndex % columns;
  const row = Math.floor(slotIndex / columns);
  const slotPosition = rotate((column - (columns - 1) / 2) * 1.5, row * 1.4 - 0.3);
  return { x: slotPosition.x, y: 0, z: slotPosition.z, rotY: placed.rotY, scale: 1.3 };
}

const BLUE_SKUS = ['glove', 'container'];
const WHITE_SKUS = ['peas', 'berries', 'water', 'juice'];

/** Màu thùng hàng theo SKU / trạng thái tồn (dùng chung cho pallet trên sàn và pallet đang trên càng xe nâng). */
export function palletColor(pallet: Pick<SnapshotPallet, 'label' | 'stockStatus'>) {
  const label = pallet.label.toLowerCase();
  if (pallet.stockStatus === 'QUARANTINE' || pallet.stockStatus === 'DAMAGED') return '#ef8a8a';
  if (BLUE_SKUS.some((keyword) => label.includes(keyword))) return '#3b6fe0';
  if (WHITE_SKUS.some((keyword) => label.includes(keyword))) return '#eef2f8';
  return '#d9a86c';
}

/**
 * Pallet đang vẽ trên bản đồ, mỗi pallet GIỮ NGUYÊN ô của mình: pallet khác rời đi thì không dồn cả cụm,
 * pallet mới lấy ô trống thấp nhất. Pallet đã xếp lên xe (LOADED) nằm trong thùng xe → không vẽ.
 */
export function useStablePalletSlots(pallets: SnapshotPallet[], layout: LayoutIndex): Map<string, DisplayedPallet> {
  const slotMemory = useRef(new Map<string, Map<string, number>>());
  const cache = useRef<{ pallets: SnapshotPallet[]; layout: LayoutIndex; result: Map<string, DisplayedPallet> } | null>(null);
  if (cache.current && cache.current.pallets === pallets && cache.current.layout === layout) return cache.current.result;

  const byLocation = new Map<string, SnapshotPallet[]>();
  for (const pallet of pallets) {
    const locationId = pallet.position?.locationId;
    if (!locationId || pallet.lifecycle === 'LOADED') continue;
    const placed = layout.byLocation.get(locationId);
    if (!placed || !DISPLAYED_TYPES.includes(placed.type)) continue;
    const list = byLocation.get(locationId) ?? [];
    list.push(pallet);
    byLocation.set(locationId, list);
  }

  const result = new Map<string, DisplayedPallet>();
  const nextMemory = new Map<string, Map<string, number>>();
  for (const [locationId, list] of byLocation) {
    const placed = layout.byLocation.get(locationId)!;
    const capacity = slotCapacity(placed);
    const previous = slotMemory.current.get(locationId) ?? new Map<string, number>();
    const assigned = new Map<string, number>();
    // Giữ ô cũ cho pallet vẫn còn ở đây
    for (const pallet of list) if (previous.has(pallet.id)) assigned.set(pallet.id, previous.get(pallet.id)!);
    const taken = new Set(assigned.values());
    // Pallet mới: ô trống thấp nhất (theo mã để ổn định giữa các lần tải)
    for (const pallet of list.filter((candidate) => !assigned.has(candidate.id)).sort((first, second) => first.code.localeCompare(second.code))) {
      let slotIndex = 0;
      while (taken.has(slotIndex)) slotIndex++;
      taken.add(slotIndex);
      assigned.set(pallet.id, slotIndex);
    }
    nextMemory.set(locationId, assigned);
    for (const pallet of list) {
      const slotIndex = assigned.get(pallet.id)!;
      if (slotIndex >= capacity) continue;
      result.set(pallet.id, { pallet, placed, slotIndex, pose: palletSlotPose(placed, slotIndex) });
    }
  }
  slotMemory.current = nextMemory;
  cache.current = { pallets, layout, result };
  return result;
}
