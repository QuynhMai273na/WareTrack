import type { SnapshotTruck } from '@waretrack/shared-schemas';
import { type LayoutIndex, outward, type Placed, tangent, TRUCK_LENGTH } from './layoutIndex';
import { type Point, pointAtDistance, polylineLength, projectOntoPolyline, slicePolyline } from './network';

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
  /** Xe mới vào bản đồ: xuất hiện ở điểm này (ngoài bản đồ) rồi chạy theo `plan` tới đích, thay vì hiện ngay tại đích. */
  spawn?: { x: number; z: number; rotY: number };
}

const waypoint = (x: number, z: number, reverse?: boolean): Waypoint => ({ x, z, reverse });
const offsetPoint = (origin: { x: number; z: number }, direction: { x: number; z: number }, distance: number) => ({ x: origin.x + direction.x * distance, z: origin.z + direction.z * distance });

/** Điểm trên polyline theo tỉ lệ 0..1 (theo chiều dài). */
export function along(path: Array<[number, number]>, fraction: number): { x: number; z: number; heading: number } {
  const segs = path.slice(1).map((endPoint, segmentIndex) => ({ start: path[segmentIndex], end: endPoint, len: Math.hypot(endPoint[0] - path[segmentIndex][0], endPoint[1] - path[segmentIndex][1]) }));
  const total = segs.reduce((sum, segment) => sum + segment.len, 0);
  let remainingDistance = Math.max(0, Math.min(1, fraction)) * total;
  for (const segment of segs) {
    if (remainingDistance <= segment.len || segment === segs[segs.length - 1]) {
      const ratio = segment.len ? Math.min(1, remainingDistance / segment.len) : 0;
      return { x: segment.start[0] + (segment.end[0] - segment.start[0]) * ratio, z: segment.start[1] + (segment.end[1] - segment.start[1]) * ratio, heading: Math.atan2(segment.end[0] - segment.start[0], segment.end[1] - segment.start[1]) };
    }
    remainingDistance -= segment.len;
  }
  const last = path[path.length - 1];
  return { x: last[0], z: last[1], heading: 0 };
}

/** Điểm đỗ tại dock: đuôi xe sát cửa, đầu xe hướng ra ngoài. */
export function dockPose(dock: Placed) {
  const outwardDirection = outward(dock);
  return { ...offsetPoint(dock, outwardDirection, TRUCK_LENGTH / 2 + 0.6), rotY: dock.rotY };
}

/** Lộ trình lùi chuồng vào bay: chạy tới điểm lệch sang bên, rồi lùi theo cung vào trục bay. */
export function dockingApproach(dock: Placed, stopShort: number): Waypoint[] {
  const outwardDirection = outward(dock);
  const tangentDirection = tangent(dock);
  const axisFar = offsetPoint(dock, outwardDirection, TRUCK_LENGTH / 2 + 26);
  const side = offsetPoint(axisFar, tangentDirection, 16);
  const pre = offsetPoint(side, outwardDirection, 4);
  const pts: Waypoint[] = [waypoint(pre.x, pre.z), waypoint(side.x, side.z)];
  // Cung lùi (bezier bậc 2) từ điểm bên cạnh về trục bay
  const ctrl = offsetPoint(offsetPoint(dock, outwardDirection, TRUCK_LENGTH / 2 + 26), tangentDirection, 2);
  const end = offsetPoint(dock, outwardDirection, TRUCK_LENGTH / 2 + 0.6 + stopShort);
  const mid = offsetPoint(dock, outwardDirection, TRUCK_LENGTH / 2 + 14);
  for (let stepIndex = 1; stepIndex <= 6; stepIndex++) {
    const curveParam = stepIndex / 6;
    const x = (1 - curveParam) * (1 - curveParam) * side.x + 2 * (1 - curveParam) * curveParam * ctrl.x + curveParam * curveParam * mid.x;
    const z = (1 - curveParam) * (1 - curveParam) * side.z + 2 * (1 - curveParam) * curveParam * ctrl.z + curveParam * curveParam * mid.z;
    pts.push(waypoint(x, z, true));
  }
  pts.push(waypoint(end.x, end.z, true));
  return pts;
}

const gateOf = (layout: LayoutIndex) => layout.locations.find((location) => location.type === 'GATE_LANE');

/** Xe đang tới (SCHEDULED, ETA ≤ 8 phút) khi site không có mạng đường chung: chạy trên lanes.entry, tỉ lệ theo ETA. */
export const EN_ROUTE_WINDOW_MIN = 8;
/** Tốc độ hiển thị của xe đang tới trên mạng đường chung (m/s): vị trí = quãng còn lại tới cổng theo ETA. */
export const EN_ROUTE_SPEED = 4.5;

const toWaypoints = (points: Point[]) => points.map((point) => waypoint(point.x, point.z));

/**
 * `approach` (nếu có): lộ trình đầy đủ từ ngoài bản đồ theo đại lộ tới cổng (tọa độ cục bộ, điểm cuối ở trong cổng).
 * Xe đang tới nằm trên lộ trình này theo ETA; đổi trạng thái thì chạy nốt phần còn lại thay vì cắt ngang.
 */
export function truckTarget(truck: SnapshotTruck, layout: LayoutIndex, waitingIndex: number, nowMs: number, approach?: Point[]): TruckTarget {
  const hidden: TruckTarget = { key: 'hidden', x: 0, z: 0, rotY: 0, visible: false, plan: () => [] };
  const dock = truck.dockLocationId ? layout.byLocation.get(truck.dockLocationId) : undefined;
  const confirmed = truck.position?.locationId ? layout.byLocation.get(truck.position.locationId) : undefined;
  const entry = layout.lanes?.entry ?? [];
  const gate = gateOf(layout);
  const hasApproach = !!approach && approach.length >= 2;
  /** Phần lộ trình ở ngoài cổng (bỏ điểm cuối nằm trong cổng). */
  const outside = hasApproach ? approach!.slice(0, -1) : [];
  const viaEntry = (from: { x: number; z: number }, stopAtGate = false): Waypoint[] => {
    if (hasApproach) {
      // Xe còn trên đường ngoài cổng → đi nốt lộ trình (tới cổng, hoặc qua cổng vào trong)
      const projection = projectOntoPolyline(outside, from);
      const total = polylineLength(approach!);
      const endDistance = stopAtGate && gate ? projectOntoPolyline(approach!, gate).travelled : total;
      if (projection.gap > 4 || endDistance - projection.travelled < 1) return [];
      return toWaypoints(slicePolyline(approach!, projection.travelled, endDistance).slice(1));
    }
    // Nếu xe còn ở ngoài cổng thì đi nốt lộ trình vào
    if (!gate || entry.length === 0) return [];
    const gatePoint = { x: gate.x, z: gate.z };
    const distGate = Math.hypot(from.x - gatePoint.x, from.z - gatePoint.z);
    const isOutside = Math.hypot(from.x - entry[0][0], from.z - entry[0][1]) < Math.hypot(entry[0][0] - gatePoint.x, entry[0][1] - gatePoint.z) + 2 && distGate > 6;
    if (!isOutside) return [];
    const nearest = entry.reduce((best, point, pointIndex) => (Math.hypot(point[0] - from.x, point[1] - from.z) < Math.hypot(entry[best][0] - from.x, entry[best][1] - from.z) ? pointIndex : best), 0);
    return entry.slice(nearest + 1).map(([x, z]) => waypoint(x, z));
  };

  switch (truck.status) {
    case 'SCHEDULED': {
      if (hasApproach) {
        if (!truck.etaAt) return hidden;
        const outsideLength = polylineLength(outside);
        // Quãng còn lại tới cổng theo ETA; xa hơn cả lộ trình = xe chưa vào bản đồ
        const remaining = Math.max(4, ((new Date(truck.etaAt).getTime() - nowMs) / 1000) * EN_ROUTE_SPEED);
        if (remaining > outsideLength) return hidden;
        const travelled = outsideLength - remaining;
        const position = pointAtDistance(outside, travelled);
        return {
          key: `enroute:${Math.round(travelled)}`,
          x: position.x,
          z: position.z,
          rotY: position.heading,
          visible: true,
          plan: (from) => {
            const projection = projectOntoPolyline(outside, from);
            if (projection.gap > 6 || projection.travelled >= travelled) return [waypoint(position.x, position.z)];
            return toWaypoints(slicePolyline(outside, projection.travelled, travelled).slice(1));
          },
        };
      }
      if (!truck.etaAt || entry.length < 2) return hidden;
      const etaMin = (new Date(truck.etaAt).getTime() - nowMs) / 60_000;
      if (etaMin > EN_ROUTE_WINDOW_MIN) return hidden;
      const progress = Math.min(0.92, Math.max(0, 1 - etaMin / EN_ROUTE_WINDOW_MIN));
      const position = along(entry.slice(0, -1), progress);
      return { key: `enroute:${Math.round(progress * 100)}`, x: position.x, z: position.z, rotY: position.heading, visible: true, plan: () => [waypoint(position.x, position.z)] };
    }
    case 'AT_GATE': {
      if (!gate) return hidden;
      const inward = entry.length >= 2 ? Math.atan2(entry[entry.length - 1][0] - entry[entry.length - 2][0], entry[entry.length - 1][1] - entry[entry.length - 2][1]) : Math.PI;
      const gateHeading = hasApproach ? pointAtDistance(approach!, projectOntoPolyline(approach!, gate).travelled).heading : inward;
      return { key: 'gate', x: gate.x, z: gate.z, rotY: gateHeading, visible: true, plan: (from) => [...viaEntry(from, true), waypoint(gate.x, gate.z)] };
    }
    case 'DOCK_ASSIGNED': {
      if (!dock) break;
      const route = dockingApproach(dock, 9);
      const end = route[route.length - 1];
      return { key: `docking:${dock.id}`, x: end.x, z: end.z, rotY: dock.rotY, visible: true, plan: (from) => [...viaEntry(from), ...route] };
    }
    case 'AT_DOCK':
    case 'HANDLING': {
      const parkedDock = confirmed ?? dock;
      if (!parkedDock) break;
      const pose = dockPose(parkedDock);
      return { key: `dock:${parkedDock.id}`, x: pose.x, z: pose.z, rotY: pose.rotY, visible: true, plan: (from) => [...viaEntry(from), ...(Math.hypot(from.x - pose.x, from.z - pose.z) > 30 ? dockingApproach(parkedDock, 0) : [waypoint(pose.x, pose.z, true)])] };
    }
    case 'READY_TO_LEAVE': {
      const parkedDock = confirmed ?? dock;
      if (!parkedDock) break;
      const leavePoint = offsetPoint(dockPose(parkedDock), outward(parkedDock), 2.5);
      return { key: `ready:${parkedDock.id}`, x: leavePoint.x, z: leavePoint.z, rotY: parkedDock.rotY, visible: true, plan: () => [waypoint(leavePoint.x, leavePoint.z)] };
    }
    default:
      break;
  }
  // WAITING (hoặc không xác định): yard slot theo thứ tự
  const slots = layout.locations.filter((location) => location.type === 'YARD_SLOT');
  const slot = slots[waitingIndex % Math.max(slots.length, 1)];
  if (slot) {
    const slotPoint = offsetPoint(slot, outward(slot), 0);
    return { key: `yard:${slot.id}`, x: slotPoint.x, z: slotPoint.z, rotY: slot.rotY, visible: true, plan: (from) => [...viaEntry(from), waypoint(slotPoint.x, slotPoint.z)] };
  }
  return hidden;
}

/**
 * Lộ trình rời site của xe vừa EXITED. Xe đang ở dock: tiến thẳng ra khỏi bay rồi theo `departure`
 * (lối ra → đại lộ → site khác / ra khỏi bản đồ). Xe chưa qua cổng (bị từ chối / hủy): quay đầu theo đường tới.
 */
export function exitPlan(from: { x: number; z: number; rotY: number }, layout: LayoutIndex, options: { departure?: Point[]; approach?: Point[]; leftFrom?: string } = {}): Waypoint[] {
  const { departure, approach, leftFrom } = options;
  if ((leftFrom === 'AT_GATE' || leftFrom === 'SCHEDULED') && approach && approach.length >= 2) {
    const projection = projectOntoPolyline(approach, from);
    return toWaypoints(slicePolyline(approach, 0, projection.travelled).reverse().slice(1));
  }
  const lane = departure && departure.length >= 2 ? departure : (layout.lanes?.exit ?? []).map(([x, z]) => ({ x, z }));
  const atDock = !leftFrom || ['AT_DOCK', 'HANDLING', 'READY_TO_LEAVE'].includes(leftFrom);
  const lead: Waypoint[] = [];
  if (atDock) {
    const forwardDirection = { x: Math.sin(from.rotY), z: Math.cos(from.rotY) };
    const out = offsetPoint(from, forwardDirection, 18);
    lead.push(waypoint(out.x, out.z));
  }
  // Nhập vào lối ra ở điểm gần nhất phía trước (không quay lại đầu lối nếu đã đi quá)
  const joinFrom = lead[lead.length - 1] ?? from;
  const projection = lane.length >= 2 ? projectOntoPolyline(lane, joinFrom) : null;
  const rest = projection ? slicePolyline(lane, projection.travelled, polylineLength(lane)) : lane;
  return [...lead, ...toWaypoints(rest)];
}

/** Điểm trước dock nơi xe nâng lấy/đặt pallet (sau đuôi xe, lệch sang bên). */
export function forkliftDockSpots(dock: Placed) {
  const outwardDirection = outward(dock);
  const tangentDirection = tangent(dock);
  return {
    atTruck: offsetPoint(offsetPoint(dock, outwardDirection, 1.8), tangentDirection, 0),
    beside: offsetPoint(offsetPoint(dock, outwardDirection, 3.2), tangentDirection, 3.4),
  };
}
