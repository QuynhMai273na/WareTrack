import type { SiteSnapshot, SnapshotTruck } from '@waretrack/shared-schemas';
import { type LayoutIndex, outward, type Placed, tangent } from './layoutIndex';
import { dockPose } from './motion';
import type { DisplayedPallet } from './palletLayout';

/**
 * Chuyến chở pallet của xe nâng (Animation State — chỉ để vẽ, BR-30): khi pallet đổi vị trí trong snapshot,
 * một xe nâng chạy tới chỗ cũ, xúc pallet, chở tới chỗ mới rồi đặt xuống. Pallet không bao giờ tự trượt.
 */
export interface Point {
  x: number;
  z: number;
}

/** Một đầu của chuyến chở: chỗ pallet nằm + hướng xe nâng phải quay mặt vào khi xúc/đặt. */
export interface JobEnd {
  /** Tâm pallet (mặt đất). */
  point: Point;
  /** Độ cao pallet (tầng rack). */
  y: number;
  /** Các hướng tiếp cận được phép (vector đơn vị, chiều xe nâng chạy vào). */
  facings: Point[];
  /** slot: pallet nằm trên sàn/rack · truck: trong thùng xe tải · door: trong nhà kho (qua cửa). */
  kind: 'slot' | 'truck' | 'door';
}

export interface PalletJob {
  id: string;
  palletId: string;
  forkliftId: string;
  color: string;
  scale: number;
  from: JobEnd;
  to: JobEnd;
  /** Tư thế pallet đang chờ ở chỗ cũ (để vẽ cho tới khi được xúc). */
  waitingPose: { x: number; y: number; z: number; rotY: number; scale: number } | null;
}

export type DriveStep =
  | { kind: 'drive'; x: number; z: number }
  | { kind: 'reverse'; x: number; z: number }
  | { kind: 'turn'; heading: number }
  | { kind: 'lift'; y: number }
  | { kind: 'pause'; seconds: number }
  | { kind: 'pickup'; jobId: string }
  | { kind: 'drop'; jobId: string };

/** Khoảng cách từ tâm xe nâng tới tâm pallet trên càng (ForkliftModel scale 1.25, càng ở z = 1.8). */
export const FORK_REACH = 2.25;
/** Độ cao càng khi chở. */
export const CARRY_HEIGHT = 0.32;
const APPROACH_GAP = 3.2;

interface Obstacle {
  center: Point;
  halfWidth: number;
  halfDepth: number;
  rotY: number;
}

const distance = (first: Point, second: Point) => Math.hypot(second.x - first.x, second.z - first.z);
const offset = (origin: Point, direction: Point, amount: number) => ({ x: origin.x + direction.x * amount, z: origin.z + direction.z * amount });

/** Vật cản xe nâng phải đi vòng: nhà kho, xe tải đang đỗ ở dock, kệ ngoài trời. */
export function forkliftObstacles(layout: LayoutIndex, trucks: SnapshotTruck[]): Obstacle[] {
  const obstacles: Obstacle[] = layout.buildings.map((building) => ({ center: { x: building.posX, z: building.posZ }, halfWidth: building.sizeX / 2, halfDepth: building.sizeZ / 2, rotY: (building.rotY * Math.PI) / 180 }));
  for (const truck of trucks) {
    if (!['AT_DOCK', 'HANDLING', 'READY_TO_LEAVE'].includes(truck.status)) continue;
    const dockId = truck.position?.locationId ?? truck.dockLocationId;
    const dock = dockId ? layout.byLocation.get(dockId) : undefined;
    if (!dock) continue;
    const pose = dockPose(dock);
    obstacles.push({ center: pose, halfWidth: 1.4, halfDepth: 7.6, rotY: dock.rotY });
  }
  for (const location of layout.locations) {
    if (location.display === 'rack') obstacles.push({ center: { x: location.x, z: location.z }, halfWidth: location.sx / 2, halfDepth: location.sz / 2, rotY: location.rotY });
  }
  return obstacles;
}

/** Đổi điểm sang hệ trục của vật cản (trục x theo bề rộng, z theo chiều sâu). */
function toObstacleFrame(point: Point, obstacle: Obstacle): Point {
  const relative = { x: point.x - obstacle.center.x, z: point.z - obstacle.center.z };
  const cos = Math.cos(obstacle.rotY);
  const sin = Math.sin(obstacle.rotY);
  return { x: relative.x * cos - relative.z * sin, z: relative.x * sin + relative.z * cos };
}

function insideObstacle(point: Point, obstacle: Obstacle, margin: number) {
  const local = toObstacleFrame(point, obstacle);
  return Math.abs(local.x) < obstacle.halfWidth + margin && Math.abs(local.z) < obstacle.halfDepth + margin;
}

/** Đoạn thẳng cắt hình chữ nhật (Liang–Barsky trong hệ trục vật cản). */
function segmentHits(start: Point, end: Point, obstacle: Obstacle, margin: number) {
  const localStart = toObstacleFrame(start, obstacle);
  const localEnd = toObstacleFrame(end, obstacle);
  const delta = { x: localEnd.x - localStart.x, z: localEnd.z - localStart.z };
  let enter = 0;
  let leave = 1;
  const limits: Array<[number, number, number]> = [
    [-delta.x, localStart.x + obstacle.halfWidth + margin, 0],
    [delta.x, obstacle.halfWidth + margin - localStart.x, 0],
    [-delta.z, localStart.z + obstacle.halfDepth + margin, 0],
    [delta.z, obstacle.halfDepth + margin - localStart.z, 0],
  ];
  for (const [direction, bound] of limits) {
    if (Math.abs(direction) < 1e-9) {
      if (bound < 0) return false;
      continue;
    }
    const ratio = bound / direction;
    if (direction < 0) enter = Math.max(enter, ratio);
    else leave = Math.min(leave, ratio);
    if (enter > leave) return false;
  }
  return leave > 0.001 && enter < 0.999;
}

function corners(obstacle: Obstacle, margin: number): Point[] {
  const cos = Math.cos(obstacle.rotY);
  const sin = Math.sin(obstacle.rotY);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([signX, signZ]) => {
    const localX = signX * (obstacle.halfWidth + margin);
    const localZ = signZ * (obstacle.halfDepth + margin);
    return { x: obstacle.center.x + localX * cos + localZ * sin, z: obstacle.center.z - localX * sin + localZ * cos };
  });
}

const MARGIN = 1.6;

/**
 * Lộ trình tránh vật cản giữa hai điểm: đồ thị "nhìn thấy nhau" giữa các góc vật cản (đã nới lề) + Dijkstra —
 * đi vòng đúng cả khi nhiều nhà kho ghép thành hình chữ L. Không có đường thì đi thẳng.
 */
export function routeAround(start: Point, end: Point, obstacles: Obstacle[]): Point[] {
  // Bỏ qua vật cản thật sự chứa điểm đầu/cuối (đi vào cửa kho, đứng trong trạm…)
  const relevant = obstacles.filter((obstacle) => !insideObstacle(start, obstacle, 0) && !insideObstacle(end, obstacle, 0));
  // Đoạn chạm điểm đầu/cuối chỉ cần không cắt tường thật (điểm có thể sát tường); đoạn giữa chừng giữ lề an toàn
  const clear = (first: Point, second: Point) => {
    const touchesEndpoint = first === start || first === end || second === start || second === end;
    return !relevant.some((obstacle) => segmentHits(first, second, obstacle, touchesEndpoint ? 0.1 : MARGIN * 0.8));
  };
  if (clear(start, end)) return [end];
  const waypoints = relevant.flatMap((obstacle) => corners(obstacle, MARGIN)).filter((corner) => !relevant.some((obstacle) => insideObstacle(corner, obstacle, MARGIN * 0.9)));
  const nodes = [start, end, ...waypoints];
  const best = nodes.map(() => Infinity);
  const previous = nodes.map(() => -1);
  const settled = nodes.map(() => false);
  best[0] = 0;
  for (;;) {
    let currentIndex = -1;
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) if (!settled[nodeIndex] && best[nodeIndex] < Infinity && (currentIndex < 0 || best[nodeIndex] < best[currentIndex])) currentIndex = nodeIndex;
    if (currentIndex < 0 || currentIndex === 1) break;
    settled[currentIndex] = true;
    for (let nextIndex = 0; nextIndex < nodes.length; nextIndex++) {
      if (settled[nextIndex] || nextIndex === currentIndex) continue;
      const through = best[currentIndex] + distance(nodes[currentIndex], nodes[nextIndex]);
      if (through < best[nextIndex] && clear(nodes[currentIndex], nodes[nextIndex])) {
        best[nextIndex] = through;
        previous[nextIndex] = currentIndex;
      }
    }
  }
  if (best[1] === Infinity) return [end];
  const path: Point[] = [];
  for (let nodeIndex = 1; nodeIndex > 0; nodeIndex = previous[nodeIndex]) path.unshift(nodes[nodeIndex]);
  return path;
}

/** Đầu chuyến ở một ô pallet: tiếp cận theo 4 hướng của ô (rack chỉ từ mặt trước / sau). */
export function slotEnd(displayed: Pick<DisplayedPallet, 'placed' | 'pose'>): JobEnd {
  const front = outward(displayed.placed);
  const side = tangent(displayed.placed);
  const reverse = (vector: Point) => ({ x: -vector.x, z: -vector.z });
  const facings = displayed.placed.display === 'rack' ? [reverse(front), front] : [reverse(front), front, side, reverse(side)];
  return { point: { x: displayed.pose.x, z: displayed.pose.z }, y: displayed.pose.y, facings, kind: 'slot' };
}

/** Đầu chuyến ở xe tải đang đỗ tại dock: xe nâng xếp/dỡ từ hông đuôi xe. */
export function truckEnd(dock: Placed): JobEnd {
  const outwardDirection = outward(dock);
  const tangentDirection = tangent(dock);
  // Hai bên hông đuôi xe; xe nâng quay mặt vào thùng xe
  const facings = [1, -1].map((side) => ({ x: -tangentDirection.x * side, z: -tangentDirection.z * side }));
  return { point: offset(dock, outwardDirection, 2.4), y: 0, facings, kind: 'truck' };
}

/** Đầu chuyến ở kho trong nhà: đi vào qua cửa dock không có xe đỗ gần nhất, không có thì qua tường gần nhất. */
export function doorEnd(layout: LayoutIndex, near: Point, trucks: SnapshotTruck[]): JobEnd | null {
  const occupied = new Set(trucks.filter((truck) => ['AT_DOCK', 'HANDLING', 'READY_TO_LEAVE', 'DOCK_ASSIGNED'].includes(truck.status)).map((truck) => truck.position?.locationId ?? truck.dockLocationId));
  const freeDocks = layout.locations.filter((location) => location.type === 'DOCK' && !occupied.has(location.id));
  if (freeDocks.length) {
    const dock = freeDocks.reduce((closest, candidate) => (distance(candidate, near) < distance(closest, near) ? candidate : closest));
    const inward = { x: -outward(dock).x, z: -outward(dock).z };
    return { point: offset(dock, inward, 1.2), y: 0, facings: [inward], kind: 'door' };
  }
  if (!layout.buildings.length) return null;
  // Điểm gần nhất trên tường của nhà kho gần nhất
  let best: { point: Point; inward: Point; gap: number } | null = null;
  for (const building of layout.buildings) {
    const halfWidth = building.sizeX / 2;
    const halfDepth = building.sizeZ / 2;
    const clamped = { x: Math.max(building.posX - halfWidth, Math.min(building.posX + halfWidth, near.x)), z: Math.max(building.posZ - halfDepth, Math.min(building.posZ + halfDepth, near.z)) };
    const walls = [
      { point: { x: building.posX - halfWidth, z: clamped.z }, inward: { x: 1, z: 0 } },
      { point: { x: building.posX + halfWidth, z: clamped.z }, inward: { x: -1, z: 0 } },
      { point: { x: clamped.x, z: building.posZ - halfDepth }, inward: { x: 0, z: 1 } },
      { point: { x: clamped.x, z: building.posZ + halfDepth }, inward: { x: 0, z: -1 } },
    ];
    for (const wall of walls) {
      const gap = distance(wall.point, near);
      if (!best || gap < best.gap) best = { ...wall, gap };
    }
  }
  return best ? { point: offset(best.point, best.inward, 1.2), y: 0, facings: [best.inward], kind: 'door' } : null;
}

/** Chọn hướng tiếp cận: điểm chờ không nằm trong vật cản và gần xe nâng nhất. */
function chooseFacing(end: JobEnd, from: Point, obstacles: Obstacle[]): Point {
  const candidates = end.facings.map((facing) => ({ facing, approach: offset(end.point, facing, -(FORK_REACH + APPROACH_GAP)) }));
  // Ưu tiên điểm chờ có khoảng trống rộng quanh nó, rồi mới tới điểm chỉ vừa đủ
  const roomy = candidates.filter((candidate) => !obstacles.some((obstacle) => insideObstacle(candidate.approach, obstacle, MARGIN)));
  const tight = candidates.filter((candidate) => !obstacles.some((obstacle) => insideObstacle(candidate.approach, obstacle, 0.6)));
  const pool = roomy.length ? roomy : tight.length ? tight : candidates;
  return pool.reduce((closest, candidate) => (distance(candidate.approach, from) < distance(closest.approach, from) ? candidate : closest)).facing;
}

/** Các bước xúc/đặt ở một đầu chuyến, đi từ `from`. Trả về các bước + vị trí cuối của xe nâng. */
function engage(end: JobEnd, from: Point, obstacles: Obstacle[], action: DriveStep): { steps: DriveStep[]; endPoint: Point } {
  const facing = chooseFacing(end, from, obstacles);
  const approach = offset(end.point, facing, -(FORK_REACH + APPROACH_GAP));
  const engaged = offset(end.point, facing, -FORK_REACH);
  const liftTo = Math.max(CARRY_HEIGHT, end.y);
  const steps: DriveStep[] = [
    ...routeAround(from, approach, obstacles).map((point): DriveStep => ({ kind: 'drive', ...point })),
    { kind: 'turn', heading: Math.atan2(facing.x, facing.z) },
    // Nâng / hạ càng ngang tầng pallet trước khi vào
    { kind: 'lift', y: liftTo },
    { kind: 'drive', ...engaged },
    { kind: 'pause', seconds: 0.35 },
    action,
    { kind: 'pause', seconds: 0.35 },
    { kind: 'reverse', ...approach },
    // Lùi ra xong hạ càng về độ cao chạy
    { kind: 'lift', y: CARRY_HEIGHT },
  ];
  return { steps, endPoint: approach };
}

/** Kế hoạch đầy đủ của một chuyến: tới chỗ cũ xúc pallet, chở tới chỗ mới đặt xuống. */
export function jobPlan(job: PalletJob, start: Point, obstacles: Obstacle[]): DriveStep[] {
  const pickup = engage(job.from, start, obstacles, { kind: 'pickup', jobId: job.id });
  const drop = engage(job.to, pickup.endPoint, obstacles, { kind: 'drop', jobId: job.id });
  return [...pickup.steps, ...drop.steps];
}

/** Đường về chỗ đỗ (trạm sạc / cạnh dock đang làm). */
export function homePlan(start: Point, home: { x: number; z: number; rotY: number }, obstacles: Obstacle[]): DriveStep[] {
  if (distance(start, home) < 0.3) return [{ kind: 'turn', heading: home.rotY }];
  return [...routeAround(start, home, obstacles).map((point): DriveStep => ({ kind: 'drive', ...point })), { kind: 'turn', heading: home.rotY }];
}

/** Xe nâng có thể nhận chuyến (không offline / bảo trì). */
export const canCarry = (forklift: SiteSnapshot['forklifts'][number]) => forklift.status !== 'OFFLINE' && forklift.status !== 'MAINTENANCE';
