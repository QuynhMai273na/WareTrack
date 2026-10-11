import type { LayoutObjectDto, PublishedLayout } from '@waretrack/shared-schemas';
import { locationLabels } from './labels';

export interface Placed {
  id: string;
  x: number;
  z: number;
  /** Radian; mặt "ra ngoài" của vị trí là trục +Z cục bộ (dock: hướng xe lùi vào). */
  rotY: number;
  sx: number;
  sz: number;
  code: string;
  type: string;
  label: string;
  display: 'rack' | 'floor' | null;
  levels: number;
  bays: number;
}

export interface Lanes {
  entry: Array<[number, number]>;
  exit: Array<[number, number]>;
}

export interface LayoutIndex {
  byLocation: Map<string, Placed>;
  byCode: Map<string, Placed>;
  zones: LayoutObjectDto[];
  buildings: LayoutObjectDto[];
  decor: LayoutObjectDto[];
  locations: Placed[];
  lanes: Lanes | null;
  center: { x: number; z: number };
  bounds: PublishedLayout['bounds'];
}

/** Ánh xạ business target → transform hiển thị (mục 18.3). Chỉ là dữ liệu hiển thị, không phải vị trí nghiệp vụ. */
export function indexLayout(layout: PublishedLayout): LayoutIndex {
  const byLocation = new Map<string, Placed>();
  const byCode = new Map<string, Placed>();
  const locations: Placed[] = [];
  for (const layoutObject of layout.objects) {
    if (layoutObject.targetType !== 'LOCATION' || !layoutObject.targetId) continue;
    const props = (layoutObject.props ?? {}) as { code?: string; locationType?: string; label?: string; display?: 'rack' | 'floor' | null; levels?: number | null; bays?: number | null };
    const placed: Placed = {
      id: layoutObject.targetId,
      x: layoutObject.posX,
      z: layoutObject.posZ,
      rotY: (layoutObject.rotY * Math.PI) / 180,
      sx: layoutObject.sizeX,
      sz: layoutObject.sizeZ,
      code: props.code ?? '',
      type: props.locationType ?? '',
      label: props.label ?? props.code ?? '',
      display: props.display ?? null,
      levels: props.levels ?? 3,
      bays: props.bays ?? 2,
    };
    byLocation.set(layoutObject.targetId, placed);
    locationLabels.set(layoutObject.targetId, { code: placed.code, label: placed.label, type: placed.type });
    byCode.set(placed.code, placed);
    locations.push(placed);
  }
  const decor = layout.objects.filter((layoutObject) => layoutObject.targetType === 'DECOR');
  const lanesObj = decor.find((decorObject) => (decorObject.props as { kind?: string } | null)?.kind === 'lanes');
  const layoutBounds = layout.bounds;
  return {
    byLocation,
    byCode,
    locations,
    zones: layout.objects.filter((layoutObject) => layoutObject.targetType === 'ZONE'),
    buildings: layout.objects.filter((layoutObject) => layoutObject.targetType === 'BUILDING'),
    decor: decor.filter((decorObject) => decorObject !== lanesObj),
    lanes: lanesObj ? (lanesObj.props as unknown as Lanes) : null,
    center: { x: (layoutBounds.minX + layoutBounds.maxX) / 2, z: (layoutBounds.minZ + layoutBounds.maxZ) / 2 },
    bounds: layoutBounds,
  };
}

export const TRUCK_LENGTH = 15;

/** Pháp tuyến (hướng ra ngoài) của một vị trí có rotY. */
export const outward = (placement: { rotY: number }) => ({ x: Math.sin(placement.rotY), z: Math.cos(placement.rotY) });
/** Tiếp tuyến (sang phải khi nhìn từ ngoài vào). */
export const tangent = (placement: { rotY: number }) => ({ x: Math.cos(placement.rotY), z: -Math.sin(placement.rotY) });
