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
  for (const o of layout.objects) {
    if (o.targetType !== 'LOCATION' || !o.targetId) continue;
    const props = (o.props ?? {}) as { code?: string; locationType?: string; label?: string; display?: 'rack' | 'floor' | null; levels?: number | null; bays?: number | null };
    const p: Placed = {
      id: o.targetId,
      x: o.posX,
      z: o.posZ,
      rotY: (o.rotY * Math.PI) / 180,
      sx: o.sizeX,
      sz: o.sizeZ,
      code: props.code ?? '',
      type: props.locationType ?? '',
      label: props.label ?? props.code ?? '',
      display: props.display ?? null,
      levels: props.levels ?? 3,
      bays: props.bays ?? 2,
    };
    byLocation.set(o.targetId, p);
    locationLabels.set(o.targetId, { code: p.code, label: p.label, type: p.type });
    byCode.set(p.code, p);
    locations.push(p);
  }
  const decor = layout.objects.filter((o) => o.targetType === 'DECOR');
  const lanesObj = decor.find((d) => (d.props as { kind?: string } | null)?.kind === 'lanes');
  const b = layout.bounds;
  return {
    byLocation,
    byCode,
    locations,
    zones: layout.objects.filter((o) => o.targetType === 'ZONE'),
    buildings: layout.objects.filter((o) => o.targetType === 'BUILDING'),
    decor: decor.filter((d) => d !== lanesObj),
    lanes: lanesObj ? (lanesObj.props as unknown as Lanes) : null,
    center: { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 },
    bounds: b,
  };
}

export const TRUCK_LENGTH = 15;

/** Pháp tuyến (hướng ra ngoài) của một vị trí có rotY. */
export const outward = (p: { rotY: number }) => ({ x: Math.sin(p.rotY), z: Math.cos(p.rotY) });
/** Tiếp tuyến (sang phải khi nhìn từ ngoài vào). */
export const tangent = (p: { rotY: number }) => ({ x: Math.cos(p.rotY), z: -Math.sin(p.rotY) });
