import type { SnapshotTruck } from '@waretrack/shared-schemas';
import { type LayoutIndex, outward, type Placed, tangent, TRUCK_LENGTH } from './layoutIndex';

/**
 * Animation State (mục 18.4, 18.9 — lane graph): lộ trình hiển thị của xe dẫn xuất từ Business State.
 * Chỉ dùng để vẽ; không bao giờ ghi ngược API/cache (BR-30).
 */
export interface Waypoint {
  x: number;
  z: number;
  /** Đi lùi tới điểm này (đầu xe hướng ngược chiều chuyển động). */
  reverse?: boolean;
}

export interface TruckTarget {
  /** Khóa trạng thái: đổi khóa → lập lộ trình mới. */
  key: string;
  x: number;
  z: number;
  rotY: number;
  visible: boolean;
  /** Lộ trình từ vị trí hiện tại (đã bỏ điểm đầu) tới đích. */
  plan: (from: { x: number; z: number }) => Waypoint[];
}

const pt = (x: number, z: number, reverse?: boolean): Waypoint => ({ x, z, reverse });
const add = (p: { x: number; z: number }, v: { x: number; z: number }, k: number) => ({ x: p.x + v.x * k, z: p.z + v.z * k });

/** Điểm trên polyline theo tỉ lệ 0..1 (theo chiều dài). */
export function along(path: Array<[number, number]>, f: number): { x: number; z: number; heading: number } {
  const segs = path.slice(1).map((p, i) => ({ a: path[i], b: p, len: Math.hypot(p[0] - path[i][0], p[1] - path[i][1]) }));
  const total = segs.reduce((s, x) => s + x.len, 0);
  let d = Math.max(0, Math.min(1, f)) * total;
  for (const s of segs) {
    if (d <= s.len || s === segs[segs.length - 1]) {
      const t = s.len ? Math.min(1, d / s.len) : 0;
      return { x: s.a[0] + (s.b[0] - s.a[0]) * t, z: s.a[1] + (s.b[1] - s.a[1]) * t, heading: Math.atan2(s.b[0] - s.a[0], s.b[1] - s.a[1]) };
    }
    d -= s.len;
  }
  const last = path[path.length - 1];
  return { x: last[0], z: last[1], heading: 0 };
}

/** Điểm đỗ tại dock: đuôi xe sát cửa, đầu xe hướng ra ngoài. */
export function dockPose(dock: Placed) {
  const o = outward(dock);
  return { ...add(dock, o, TRUCK_LENGTH / 2 + 0.6), rotY: dock.rotY };
}

/** Lộ trình lùi chuồng vào bay: chạy tới điểm lệch sang bên, rồi lùi theo cung vào trục bay. */
function dockingApproach(dock: Placed, stopShort: number): Waypoint[] {
  const o = outward(dock);
  const t = tangent(dock);
  const axisFar = add(dock, o, TRUCK_LENGTH / 2 + 26);
  const side = add(axisFar, t, 16);
  const pre = add(side, o, 4);
  const pts: Waypoint[] = [pt(pre.x, pre.z), pt(side.x, side.z)];
  // Cung lùi (bezier bậc 2) từ điểm bên cạnh về trục bay
  const ctrl = add(add(dock, o, TRUCK_LENGTH / 2 + 26), t, 2);
  const end = add(dock, o, TRUCK_LENGTH / 2 + 0.6 + stopShort);
  const mid = add(dock, o, TRUCK_LENGTH / 2 + 14);
  for (let i = 1; i <= 6; i++) {
    const s = i / 6;
    const x = (1 - s) * (1 - s) * side.x + 2 * (1 - s) * s * ctrl.x + s * s * mid.x;
    const z = (1 - s) * (1 - s) * side.z + 2 * (1 - s) * s * ctrl.z + s * s * mid.z;
    pts.push(pt(x, z, true));
  }
  pts.push(pt(end.x, end.z, true));
  return pts;
}

const gateOf = (layout: LayoutIndex) => layout.locations.find((l) => l.type === 'GATE_LANE');

/** Xe đang tới (SCHEDULED, ETA ≤ 8 phút): chạy trên đường ngoài theo lanes.entry, tỉ lệ theo ETA. */
export const EN_ROUTE_WINDOW_MIN = 8;

export function truckTarget(t: SnapshotTruck, layout: LayoutIndex, waitingIndex: number, nowMs: number): TruckTarget {
  const hidden: TruckTarget = { key: 'hidden', x: 0, z: 0, rotY: 0, visible: false, plan: () => [] };
  const dock = t.dockLocationId ? layout.byLocation.get(t.dockLocationId) : undefined;
  const confirmed = t.position?.locationId ? layout.byLocation.get(t.position.locationId) : undefined;
  const entry = layout.lanes?.entry ?? [];
  const gate = gateOf(layout);
  const viaEntry = (from: { x: number; z: number }) => {
    // Nếu xe còn ở ngoài cổng thì đi nốt lộ trình vào
    if (!gate || entry.length === 0) return [];
    const g = { x: gate.x, z: gate.z };
    const distGate = Math.hypot(from.x - g.x, from.z - g.z);
    const outside = Math.hypot(from.x - entry[0][0], from.z - entry[0][1]) < Math.hypot(entry[0][0] - g.x, entry[0][1] - g.z) + 2 && distGate > 6;
    if (!outside) return [];
    const nearest = entry.reduce((best, p, i) => (Math.hypot(p[0] - from.x, p[1] - from.z) < Math.hypot(entry[best][0] - from.x, entry[best][1] - from.z) ? i : best), 0);
    return entry.slice(nearest + 1).map(([x, z]) => pt(x, z));
  };

  switch (t.status) {
    case 'SCHEDULED': {
      if (!t.etaAt || entry.length < 2) return hidden;
      const etaMin = (new Date(t.etaAt).getTime() - nowMs) / 60_000;
      if (etaMin > EN_ROUTE_WINDOW_MIN) return hidden;
      const f = Math.min(0.92, Math.max(0, 1 - etaMin / EN_ROUTE_WINDOW_MIN));
      const p = along(entry.slice(0, -1), f);
      return { key: `enroute:${Math.round(f * 100)}`, x: p.x, z: p.z, rotY: p.heading, visible: true, plan: () => [pt(p.x, p.z)] };
    }
    case 'AT_GATE': {
      if (!gate) return hidden;
      const inward = entry.length >= 2 ? Math.atan2(entry[entry.length - 1][0] - entry[entry.length - 2][0], entry[entry.length - 1][1] - entry[entry.length - 2][1]) : Math.PI;
      return { key: 'gate', x: gate.x, z: gate.z, rotY: inward, visible: true, plan: (from) => [...viaEntry(from), pt(gate.x, gate.z)] };
    }
    case 'DOCK_ASSIGNED': {
      if (!dock) break;
      const route = dockingApproach(dock, 9);
      const end = route[route.length - 1];
      return { key: `docking:${dock.id}`, x: end.x, z: end.z, rotY: dock.rotY, visible: true, plan: (from) => [...viaEntry(from), ...route] };
    }
    case 'AT_DOCK':
    case 'HANDLING': {
      const d = confirmed ?? dock;
      if (!d) break;
      const p = dockPose(d);
      return { key: `dock:${d.id}`, x: p.x, z: p.z, rotY: p.rotY, visible: true, plan: (from) => [...viaEntry(from), ...(Math.hypot(from.x - p.x, from.z - p.z) > 30 ? dockingApproach(d, 0) : [pt(p.x, p.z, true)])] };
    }
    case 'READY_TO_LEAVE': {
      const d = confirmed ?? dock;
      if (!d) break;
      const p = add(dockPose(d), outward(d), 2.5);
      return { key: `ready:${d.id}`, x: p.x, z: p.z, rotY: d.rotY, visible: true, plan: () => [pt(p.x, p.z)] };
    }
    default:
      break;
  }
  // WAITING (hoặc không xác định): yard slot theo thứ tự
  const slots = layout.locations.filter((l) => l.type === 'YARD_SLOT');
  const slot = slots[waitingIndex % Math.max(slots.length, 1)];
  if (slot) {
    const p = add(slot, outward(slot), 0);
    return { key: `yard:${slot.id}`, x: p.x, z: p.z, rotY: slot.rotY, visible: true, plan: (from) => [...viaEntry(from), pt(p.x, p.z)] };
  }
  return hidden;
}

/** Lộ trình rời site của xe vừa EXITED: chạy thẳng ra khỏi dock rồi theo lanes.exit. */
export function exitPlan(from: { x: number; z: number; rotY: number }, layout: LayoutIndex): Waypoint[] {
  const o = { x: Math.sin(from.rotY), z: Math.cos(from.rotY) };
  const out = add(from, o, 18);
  return [pt(out.x, out.z), ...(layout.lanes?.exit ?? []).map(([x, z]) => pt(x, z))];
}

/** Điểm trước dock nơi xe nâng lấy/đặt pallet (sau đuôi xe, lệch sang bên). */
export function forkliftDockSpots(dock: Placed) {
  const o = outward(dock);
  const t = tangent(dock);
  return {
    atTruck: add(add(dock, o, 1.8), t, 0),
    beside: add(add(dock, o, 3.2), t, 3.4),
  };
}
