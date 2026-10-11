/**
 * Đặc tả layout của một site (zone, location, nhà kho, trang trí) — đầu vào để ghi LayoutVersion.
 * Hệ tọa độ (mục 18.2): mét, Y-up, +X = đông, +Z = nam; gốc ở góc tây-bắc của khu đất.
 */
import type { DockDirection, LocationType, ZoneType } from '@prisma/client';

export interface ZoneSpec {
  code: string;
  name: string;
  zoneType: ZoneType;
  rect: { x: number; z: number; w: number; d: number };
  color: string;
}

export interface LocationSpec {
  zone: string;
  code: string;
  type: LocationType;
  capacity: number;
  single: boolean;
  pos: { x: number; z: number; rotY: number };
  size: { x: number; z: number };
  dockDirection?: DockDirection;
  doorNumber?: string;
  lengthM?: number;
  widthM?: number;
  /** Nhãn hiển thị (Bay 1, Yard slot S01…) */
  label?: string;
  /** Cách vẽ: rack, ô sàn viền vàng */
  display?: 'rack' | 'floor';
  levels?: number;
  bays?: number;
  /** Vị trí trong nhà: không tạo layout object */
  noLayout?: boolean;
}

export interface BuildingSpec {
  code: string;
  label: string;
  rect: { x: number; z: number; w: number; d: number };
  height: number;
  roofColor: string;
  wallColor: string;
  style?: import('./site-builder').BuildingStyle;
}

export interface DecorSpec {
  kind: 'tree' | 'bush' | 'container' | 'road' | 'fence' | 'lamp' | 'cones' | 'silo' | 'shed' | 'neighbor' | 'crosswalk' | 'lanes' | 'pad' | 'parked' | 'platform';
  x: number;
  z: number;
  rotY?: number;
  w?: number;
  d?: number;
  color?: string;
  label?: string;
  h?: number;
  props?: Record<string, unknown>;
}

export interface SiteLayoutSpec {
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  zones: ZoneSpec[];
  locations: LocationSpec[];
  buildings: BuildingSpec[];
  decor: DecorSpec[];
}
