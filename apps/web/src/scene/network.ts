import type { LayoutIndex } from './layoutIndex';

/**
 * Mạng đường chung của bản đồ nhiều site (FR-12): đồ thị đại lộ biên ô lưới + đường nối từ lối vào/lối ra
 * của từng site + nhánh đường ra khỏi bản đồ. Xe tải tới/rời site đi theo đồ thị này thay vì hiện ra / biến mất
 * giữa chừng. Toàn bộ tọa độ ở đây là tọa độ chung (đã cộng offset của site); chỉ dùng để vẽ (BR-30).
 */
export interface Point {
  x: number;
  z: number;
}

/** Một đoạn đường cần vẽ thêm (đường nối, nhánh ra khỏi bản đồ): tâm, bề rộng, chiều dài, góc (radian). */
export interface RoadPiece {
  x: number;
  z: number;
  width: number;
  length: number;
  rotY: number;
  avenue: boolean;
}

/** Lộ trình của một site, trả về theo tọa độ cục bộ của site (để vẽ trong group đã dịch offset). */
export interface SiteRoutes {
  /** Đường tới: từ ngoài bản đồ (hoặc từ site trước) theo đại lộ vào tới cổng. */
  approachFor: (truckCode: string) => Point[];
  /** Đường rời: từ đầu lối ra theo đại lộ tới site khác (nếu xe có lịch ở đó) hoặc ra khỏi bản đồ. */
  departureFor: (truckCode: string, destinationSiteId?: string) => Point[];
}

export interface RoadNetwork {
  routes: Map<string, SiteRoutes>;
  extraRoads: RoadPiece[];
}

interface Segment {
  start: Point;
  end: Point;
  width: number;
}

interface SiteLink {
  offset: Point;
  /** Lối vào (tọa độ chung) bắt đầu từ điểm nối trên đại lộ hoặc từ cổng ra ngoài bản đồ riêng. */
  entryLane: Point[];
  exitLane: Point[];
  entryNode: string | null;
  exitNode: string | null;
  /** Khi lối vào/ra không chạm đại lộ nào: đi thẳng ra ngoài bản đồ theo hướng của lối. */
  entryFar: Point | null;
  exitFar: Point | null;
}

const SNAP = 0.5;
const STUB_LENGTH = 320;
/** Xe chạy làn phải của đại lộ (đại lộ rộng 18 m, 2 làn mỗi chiều tính cả lề). */
const LANE_OFFSET = 2.6;
const MAX_LINK_DISTANCE = 320;

const keyOf = (point: Point) => `${Math.round(point.x / SNAP) * SNAP},${Math.round(point.z / SNAP) * SNAP}`;
const distance = (first: Point, second: Point) => Math.hypot(second.x - first.x, second.z - first.z);
const normalize = (vector: Point) => {
  const length = Math.hypot(vector.x, vector.z) || 1;
  return { x: vector.x / length, z: vector.z / length };
};

function hashCode(text: string) {
  let hash = 0;
  for (let charIndex = 0; charIndex < text.length; charIndex++) hash = (hash * 31 + text.charCodeAt(charIndex)) | 0;
  return Math.abs(hash);
}

/** Đường tim của một road decor (posX/posZ là tâm, sizeZ là chiều dài theo hướng rotY). */
function roadCenterline(decorObject: LayoutIndex['decor'][number], offset: Point): Segment {
  const rotation = (decorObject.rotY * Math.PI) / 180;
  const along = { x: Math.sin(rotation), z: Math.cos(rotation) };
  const center = { x: offset.x + decorObject.posX, z: offset.z + decorObject.posZ };
  const half = decorObject.sizeZ / 2;
  return { start: { x: center.x - along.x * half, z: center.z - along.z * half }, end: { x: center.x + along.x * half, z: center.z + along.z * half }, width: decorObject.sizeX };
}

/** Tham số t trên tia (origin + t·direction) cắt đoạn thẳng, hoặc null. */
function rayHit(origin: Point, direction: Point, segment: Segment): number | null {
  const segmentVector = { x: segment.end.x - segment.start.x, z: segment.end.z - segment.start.z };
  const denominator = direction.x * segmentVector.z - direction.z * segmentVector.x;
  if (Math.abs(denominator) < 1e-9) return null;
  const relative = { x: segment.start.x - origin.x, z: segment.start.z - origin.z };
  const rayParam = (relative.x * segmentVector.z - relative.z * segmentVector.x) / denominator;
  const segmentParam = (relative.x * direction.z - relative.z * direction.x) / denominator;
  if (rayParam < 0 || segmentParam < -1e-6 || segmentParam > 1 + 1e-6) return null;
  return rayParam;
}

function segmentIntersection(first: Segment, second: Segment): Point | null {
  const firstDirection = { x: first.end.x - first.start.x, z: first.end.z - first.start.z };
  const firstLength = Math.hypot(firstDirection.x, firstDirection.z);
  const hitParam = rayHit(first.start, normalize(firstDirection), second);
  if (hitParam === null || hitParam > firstLength + 1e-6) return null;
  const unit = normalize(firstDirection);
  return { x: first.start.x + unit.x * hitParam, z: first.start.z + unit.z * hitParam };
}

/** Điểm nằm trên đoạn (trong dung sai) → tham số 0..1, ngược lại null. */
function paramOnSegment(point: Point, segment: Segment): number | null {
  const segmentVector = { x: segment.end.x - segment.start.x, z: segment.end.z - segment.start.z };
  const lengthSquared = segmentVector.x ** 2 + segmentVector.z ** 2;
  if (lengthSquared === 0) return null;
  const param = ((point.x - segment.start.x) * segmentVector.x + (point.z - segment.start.z) * segmentVector.z) / lengthSquared;
  if (param < -1e-6 || param > 1 + 1e-6) return null;
  const projected = { x: segment.start.x + segmentVector.x * param, z: segment.start.z + segmentVector.z * param };
  return distance(projected, point) < 0.75 ? param : null;
}

/** Dời polyline sang làn phải theo chiều chạy (miter tại các góc). */
function offsetToRightLane(points: Point[], amount: number): Point[] {
  if (points.length < 2) return points;
  const rightNormal = (from: Point, to: Point) => {
    const direction = normalize({ x: to.x - from.x, z: to.z - from.z });
    return { x: -direction.z, z: direction.x };
  };
  return points.map((point, pointIndex) => {
    const incoming = pointIndex > 0 ? rightNormal(points[pointIndex - 1], point) : null;
    const outgoing = pointIndex < points.length - 1 ? rightNormal(point, points[pointIndex + 1]) : null;
    if (!incoming || !outgoing) {
      const normal = (incoming ?? outgoing)!;
      return { x: point.x + normal.x * amount, z: point.z + normal.z * amount };
    }
    const dot = incoming.x * outgoing.x + incoming.z * outgoing.z;
    if (dot < -0.9) return { x: point.x + outgoing.x * amount, z: point.z + outgoing.z * amount };
    const scale = amount / (1 + dot);
    return { x: point.x + (incoming.x + outgoing.x) * scale, z: point.z + (incoming.z + outgoing.z) * scale };
  });
}

function dropDuplicates(points: Point[]) {
  return points.filter((point, pointIndex) => pointIndex === 0 || distance(point, points[pointIndex - 1]) > 0.05);
}

class RoadGraph {
  private nodes = new Map<string, Point>();
  private edges = new Map<string, Map<string, number>>();

  addNode(point: Point) {
    const key = keyOf(point);
    if (!this.nodes.has(key)) {
      this.nodes.set(key, { x: Math.round(point.x / SNAP) * SNAP, z: Math.round(point.z / SNAP) * SNAP });
      this.edges.set(key, new Map());
    }
    return key;
  }

  connect(firstKey: string, secondKey: string) {
    if (firstKey === secondKey) return;
    const length = distance(this.nodes.get(firstKey)!, this.nodes.get(secondKey)!);
    this.edges.get(firstKey)!.set(secondKey, length);
    this.edges.get(secondKey)!.set(firstKey, length);
  }

  point(key: string) {
    return this.nodes.get(key)!;
  }

  neighbors(key: string) {
    return this.edges.get(key) ?? new Map<string, number>();
  }

  allNodes() {
    return [...this.nodes.entries()];
  }

  /** Dijkstra từ một nút: khoảng cách + nút trước để dựng lại đường. */
  shortestFrom(sourceKey: string) {
    const distances = new Map<string, number>([[sourceKey, 0]]);
    const previous = new Map<string, string>();
    const pending = new Set<string>([sourceKey]);
    const settled = new Set<string>();
    while (pending.size) {
      let currentKey = '';
      let currentDistance = Infinity;
      for (const candidateKey of pending) {
        const candidateDistance = distances.get(candidateKey)!;
        if (candidateDistance < currentDistance) {
          currentDistance = candidateDistance;
          currentKey = candidateKey;
        }
      }
      pending.delete(currentKey);
      settled.add(currentKey);
      for (const [neighborKey, edgeLength] of this.neighbors(currentKey)) {
        if (settled.has(neighborKey)) continue;
        const throughDistance = currentDistance + edgeLength;
        if (throughDistance < (distances.get(neighborKey) ?? Infinity)) {
          distances.set(neighborKey, throughDistance);
          previous.set(neighborKey, currentKey);
          pending.add(neighborKey);
        }
      }
    }
    return { distances, previous };
  }
}

export interface NetworkSiteInput {
  siteId: string;
  offset: Point;
  layout: LayoutIndex;
}

/**
 * Dựng mạng đường từ layout đã publish của các site: đại lộ (`road` decor có `avenue`), lối vào/ra (`lanes`).
 * Không cần thay đổi dữ liệu layout — site cũ lẫn site tạo mới từ blueprint đều dùng được.
 */
export function buildRoadNetwork(sites: NetworkSiteInput[]): RoadNetwork {
  const graph = new RoadGraph();
  const extraRoads: RoadPiece[] = [];
  const avenueSegments: Segment[] = [];
  const localRoads = new Map<string, Segment[]>();

  for (const site of sites) {
    const siteRoads: Segment[] = [];
    for (const decorObject of site.layout.decor) {
      const decorProps = (decorObject.props ?? {}) as { kind?: string; avenue?: boolean };
      if (decorProps.kind !== 'road') continue;
      (decorProps.avenue ? avenueSegments : siteRoads).push(roadCenterline(decorObject, site.offset));
    }
    localRoads.set(site.siteId, siteRoads);
  }

  // Nút: đầu mút + giao điểm giữa các đại lộ
  const pointsOnAvenues: Point[] = [];
  for (const segment of avenueSegments) pointsOnAvenues.push(segment.start, segment.end);
  for (let firstIndex = 0; firstIndex < avenueSegments.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < avenueSegments.length; secondIndex++) {
      const crossing = segmentIntersection(avenueSegments[firstIndex], avenueSegments[secondIndex]);
      if (crossing) pointsOnAvenues.push(crossing);
    }
  }

  // Điểm nối lối vào/ra của từng site lên đại lộ gần nhất theo hướng của lối
  const links = new Map<string, SiteLink>();
  const linkToAvenue = (origin: Point, direction: Point) => {
    let bestParam: number | null = null;
    let bestSegment: Segment | null = null;
    for (const segment of avenueSegments) {
      const hitParam = rayHit(origin, direction, segment);
      if (hitParam !== null && hitParam <= MAX_LINK_DISTANCE && (bestParam === null || hitParam < bestParam)) {
        bestParam = hitParam;
        bestSegment = segment;
      }
    }
    return bestParam === null ? null : { point: { x: origin.x + direction.x * bestParam, z: origin.z + direction.z * bestParam }, width: bestSegment!.width };
  };

  /** Đường nội khu thẳng hàng với lối (để kéo dài tới đại lộ thay vì để xe chạy trên cỏ). */
  const alignedLocalRoad = (siteId: string, lanePoint: Point, direction: Point) => {
    let best: { segment: Segment; reach: number } | null = null;
    for (const segment of localRoads.get(siteId) ?? []) {
      const along = normalize({ x: segment.end.x - segment.start.x, z: segment.end.z - segment.start.z });
      if (Math.abs(along.x * direction.x + along.z * direction.z) < 0.99) continue;
      const lateral = Math.abs((lanePoint.x - segment.start.x) * -along.z + (lanePoint.z - segment.start.z) * along.x);
      if (lateral > segment.width / 2 + 0.5) continue;
      const reach = Math.max((segment.start.x - lanePoint.x) * direction.x + (segment.start.z - lanePoint.z) * direction.z, (segment.end.x - lanePoint.x) * direction.x + (segment.end.z - lanePoint.z) * direction.z);
      if (!best || reach > best.reach) best = { segment, reach };
    }
    return best;
  };

  /** Vẽ đoạn đường nối từ cuối đường nội khu (hoặc đầu lối) tới đại lộ / ra khỏi bản đồ. */
  const addConnector = (siteId: string, laneEnd: Point, direction: Point, target: Point, stopShort: number) => {
    const aligned = alignedLocalRoad(siteId, laneEnd, direction);
    const width = aligned?.segment.width ?? 9;
    // Tim đường nối: theo tim đường nội khu nếu có (lối xe chạy lệch một làn so với tim), không thì theo chính lối xe
    const normal = { x: -direction.z, z: direction.x };
    const lateralShift = aligned ? (laneEnd.x - aligned.segment.start.x) * normal.x + (laneEnd.z - aligned.segment.start.z) * normal.z : 0;
    const centerOffset = { x: -normal.x * lateralShift, z: -normal.z * lateralShift };
    // Bắt đầu từ cuối đường nội khu (có thể nằm trước đầu lối) để không hở khoảng cỏ
    const startReach = aligned ? aligned.reach : 0;
    const totalReach = (target.x - laneEnd.x) * direction.x + (target.z - laneEnd.z) * direction.z - stopShort;
    if (totalReach - startReach < 1) return;
    const from = { x: laneEnd.x + direction.x * startReach + centerOffset.x, z: laneEnd.z + direction.z * startReach + centerOffset.z };
    const to = { x: laneEnd.x + direction.x * totalReach + centerOffset.x, z: laneEnd.z + direction.z * totalReach + centerOffset.z };
    extraRoads.push({ x: (from.x + to.x) / 2, z: (from.z + to.z) / 2, width, length: distance(from, to), rotY: Math.atan2(to.x - from.x, to.z - from.z), avenue: false });
  };

  for (const site of sites) {
    const lanes = site.layout.lanes;
    if (!lanes || lanes.entry.length < 2 || lanes.exit.length < 2) continue;
    const toGlobal = ([x, z]: [number, number]) => ({ x: site.offset.x + x, z: site.offset.z + z });
    const entry = lanes.entry.map(toGlobal);
    const exit = lanes.exit.map(toGlobal);
    const link: SiteLink = { offset: site.offset, entryLane: entry, exitLane: exit, entryNode: null, exitNode: null, entryFar: null, exitFar: null };

    const entryDirection = normalize({ x: entry[0].x - entry[1].x, z: entry[0].z - entry[1].z });
    const entryHit = linkToAvenue(entry[1], entryDirection);
    if (entryHit) {
      link.entryLane = [entryHit.point, ...entry.slice(1)];
      pointsOnAvenues.push(entryHit.point);
      link.entryNode = keyOf(entryHit.point);
      addConnector(site.siteId, entry[0], entryDirection, entryHit.point, entryHit.width / 2 + 1.8);
    } else {
      link.entryFar = { x: entry[0].x + entryDirection.x * STUB_LENGTH, z: entry[0].z + entryDirection.z * STUB_LENGTH };
      link.entryLane = [link.entryFar, ...entry];
      addConnector(site.siteId, entry[0], entryDirection, link.entryFar, 0);
    }

    const exitDirection = normalize({ x: exit[exit.length - 1].x - exit[exit.length - 2].x, z: exit[exit.length - 1].z - exit[exit.length - 2].z });
    const exitHit = linkToAvenue(exit[exit.length - 2], exitDirection);
    if (exitHit) {
      link.exitLane = [...exit.slice(0, -1), exitHit.point];
      pointsOnAvenues.push(exitHit.point);
      link.exitNode = keyOf(exitHit.point);
      addConnector(site.siteId, exit[exit.length - 1], exitDirection, exitHit.point, exitHit.width / 2 + 1.8);
    } else {
      link.exitFar = { x: exit[exit.length - 1].x + exitDirection.x * STUB_LENGTH, z: exit[exit.length - 1].z + exitDirection.z * STUB_LENGTH };
      link.exitLane = [...exit, link.exitFar];
      addConnector(site.siteId, exit[exit.length - 1], exitDirection, link.exitFar, 0);
    }
    links.set(site.siteId, link);
  }

  // Cạnh: chia mỗi đại lộ tại các nút nằm trên nó
  for (const segment of avenueSegments) {
    const onSegment = pointsOnAvenues
      .map((point) => ({ point, param: paramOnSegment(point, segment) }))
      .filter((entry): entry is { point: Point; param: number } => entry.param !== null)
      .sort((first, second) => first.param - second.param);
    for (let pointIndex = 1; pointIndex < onSegment.length; pointIndex++) graph.connect(graph.addNode(onSegment[pointIndex - 1].point), graph.addNode(onSegment[pointIndex].point));
  }

  // Nhánh ra khỏi bản đồ: ở đầu cụt và ở các đầu đại lộ nằm trên mép ngoài của mạng lưới
  const gateways: string[] = [];
  const nodeEntries = graph.allNodes();
  if (nodeEntries.length) {
    const bounds = nodeEntries.reduce(
      (box, [, point]) => ({ minX: Math.min(box.minX, point.x), maxX: Math.max(box.maxX, point.x), minZ: Math.min(box.minZ, point.z), maxZ: Math.max(box.maxZ, point.z) }),
      { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
    );
    const compass: Point[] = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];
    for (const [nodeKey, point] of nodeEntries) {
      const neighborDirections = [...graph.neighbors(nodeKey).keys()].map((neighborKey) => normalize({ x: graph.point(neighborKey).x - point.x, z: graph.point(neighborKey).z - point.z }));
      for (const direction of compass) {
        const hasEdgeThisWay = neighborDirections.some((neighborDirection) => neighborDirection.x * direction.x + neighborDirection.z * direction.z > 0.99);
        const hasEdgeOpposite = neighborDirections.some((neighborDirection) => neighborDirection.x * direction.x + neighborDirection.z * direction.z < -0.99);
        if (hasEdgeThisWay || !hasEdgeOpposite) continue;
        const onOuterEdge = (direction.x > 0 && point.x >= bounds.maxX - 1) || (direction.x < 0 && point.x <= bounds.minX + 1) || (direction.z > 0 && point.z >= bounds.maxZ - 1) || (direction.z < 0 && point.z <= bounds.minZ + 1);
        const deadEnd = neighborDirections.length === 1;
        if (!onOuterEdge && !deadEnd) continue;
        // Đầu cụt giữa bản đồ: kéo dài tới quá mép ngoài của mạng lưới để xe xuất hiện / biến mất ngoài tầm nhìn
        const toOuterEdge = direction.x > 0 ? bounds.maxX - point.x : direction.x < 0 ? point.x - bounds.minX : direction.z > 0 ? bounds.maxZ - point.z : point.z - bounds.minZ;
        const stubLength = STUB_LENGTH + Math.max(0, toOuterEdge);
        const far = { x: point.x + direction.x * stubLength, z: point.z + direction.z * stubLength };
        const farKey = graph.addNode(far);
        graph.connect(nodeKey, farKey);
        gateways.push(farKey);
        // Bắt đầu ngay tại giao lộ (vẽ thấp hơn đại lộ một chút) để không hở góc ở chỗ rẽ
        extraRoads.push({ x: (point.x + far.x) / 2, z: (point.z + far.z) / 2, width: 18, length: distance(point, far), rotY: Math.atan2(direction.x, direction.z), avenue: true });
      }
    }
  }

  const shortestCache = new Map<string, ReturnType<RoadGraph['shortestFrom']>>();
  const shortest = (sourceKey: string) => {
    if (!shortestCache.has(sourceKey)) shortestCache.set(sourceKey, graph.shortestFrom(sourceKey));
    return shortestCache.get(sourceKey)!;
  };
  /** Đường đi trên đồ thị (tọa độ tim đường) từ nút nguồn tới nút đích. */
  const pathBetween = (sourceKey: string, targetKey: string): Point[] | null => {
    const { previous, distances } = shortest(sourceKey);
    if (!distances.has(targetKey)) return null;
    const keys = [targetKey];
    while (keys[0] !== sourceKey) keys.unshift(previous.get(keys[0])!);
    return keys.map((key) => graph.point(key));
  };
  /** Chọn một trong hai lối ra bản đồ gần nhất (theo mã xe để xe khác nhau đi các hướng khác nhau). */
  const pickGateway = (nodeKey: string, truckCode: string) => {
    const { distances } = shortest(nodeKey);
    const reachable = gateways.filter((gatewayKey) => distances.has(gatewayKey)).sort((first, second) => distances.get(first)! - distances.get(second)!);
    if (!reachable.length) return null;
    return reachable[hashCode(truckCode) % Math.min(2, reachable.length)];
  };

  const routes = new Map<string, SiteRoutes>();
  for (const [siteId, link] of links) {
    const toLocal = (points: Point[]) => points.map((point) => ({ x: point.x - link.offset.x, z: point.z - link.offset.z }));
    const approachFor = (truckCode: string) => {
      if (!link.entryNode) return toLocal(link.entryLane);
      const gatewayKey = pickGateway(link.entryNode, `in:${truckCode}`);
      const roadPart = gatewayKey ? pathBetween(gatewayKey, link.entryNode) : null;
      if (!roadPart) return toLocal(link.entryLane);
      return toLocal(dropDuplicates([...offsetToRightLane(roadPart, LANE_OFFSET), ...link.entryLane]));
    };
    const departureFor = (truckCode: string, destinationSiteId?: string) => {
      if (!link.exitNode) return toLocal(link.exitLane);
      const destination = destinationSiteId ? links.get(destinationSiteId) : undefined;
      if (destination?.entryNode) {
        const transfer = pathBetween(link.exitNode, destination.entryNode);
        if (transfer) return toLocal(dropDuplicates([...link.exitLane, ...offsetToRightLane(transfer, LANE_OFFSET), ...destination.entryLane.slice(1)]));
      }
      const gatewayKey = pickGateway(link.exitNode, `out:${truckCode}`);
      const roadPart = gatewayKey ? pathBetween(link.exitNode, gatewayKey) : null;
      if (!roadPart) return toLocal(link.exitLane);
      return toLocal(dropDuplicates([...link.exitLane, ...offsetToRightLane(roadPart, LANE_OFFSET)]));
    };
    const approachCache = new Map<string, Point[]>();
    const departureCache = new Map<string, Point[]>();
    routes.set(siteId, {
      approachFor: (truckCode) => {
        if (!approachCache.has(truckCode)) approachCache.set(truckCode, approachFor(truckCode));
        return approachCache.get(truckCode)!;
      },
      departureFor: (truckCode, destinationSiteId) => {
        const cacheKey = `${truckCode}>${destinationSiteId ?? ''}`;
        if (!departureCache.has(cacheKey)) departureCache.set(cacheKey, departureFor(truckCode, destinationSiteId));
        return departureCache.get(cacheKey)!;
      },
    });
  }
  return { routes, extraRoads };
}

/** Chiều dài polyline. */
export function polylineLength(points: Point[]) {
  let total = 0;
  for (let pointIndex = 1; pointIndex < points.length; pointIndex++) total += distance(points[pointIndex - 1], points[pointIndex]);
  return total;
}

/** Điểm cách đầu polyline một quãng `travelled` (m) + hướng đầu xe + chỉ số đoạn. */
export function pointAtDistance(points: Point[], travelled: number) {
  let remaining = Math.max(0, travelled);
  for (let pointIndex = 1; pointIndex < points.length; pointIndex++) {
    const segmentLength = distance(points[pointIndex - 1], points[pointIndex]);
    if (remaining <= segmentLength || pointIndex === points.length - 1) {
      const ratio = segmentLength ? Math.min(1, remaining / segmentLength) : 0;
      const start = points[pointIndex - 1];
      const end = points[pointIndex];
      return { x: start.x + (end.x - start.x) * ratio, z: start.z + (end.z - start.z) * ratio, heading: Math.atan2(end.x - start.x, end.z - start.z), segmentIndex: pointIndex - 1 };
    }
    remaining -= segmentLength;
  }
  const last = points[points.length - 1] ?? { x: 0, z: 0 };
  return { x: last.x, z: last.z, heading: 0, segmentIndex: Math.max(0, points.length - 2) };
}

/** Hình chiếu gần nhất của một điểm lên polyline: khoảng cách vuông góc + quãng đã đi tính từ đầu. */
export function projectOntoPolyline(points: Point[], target: Point) {
  let best = { gap: Infinity, travelled: 0, segmentIndex: 0 };
  let travelledBefore = 0;
  for (let pointIndex = 1; pointIndex < points.length; pointIndex++) {
    const start = points[pointIndex - 1];
    const end = points[pointIndex];
    const segmentLength = distance(start, end);
    const param = segmentLength ? Math.max(0, Math.min(1, ((target.x - start.x) * (end.x - start.x) + (target.z - start.z) * (end.z - start.z)) / segmentLength ** 2)) : 0;
    const projected = { x: start.x + (end.x - start.x) * param, z: start.z + (end.z - start.z) * param };
    const gap = distance(projected, target);
    if (gap < best.gap) best = { gap, travelled: travelledBefore + param * segmentLength, segmentIndex: pointIndex - 1 };
    travelledBefore += segmentLength;
  }
  return best;
}

/** Phần polyline từ quãng `fromDistance` tới `toDistance` (theo chiều đi tới), gồm cả hai điểm mút. */
export function slicePolyline(points: Point[], fromDistance: number, toDistance: number): Point[] {
  const startPoint = pointAtDistance(points, fromDistance);
  const endPoint = pointAtDistance(points, toDistance);
  const middle = points.slice(startPoint.segmentIndex + 1, endPoint.segmentIndex + 1);
  return dropDuplicates([{ x: startPoint.x, z: startPoint.z }, ...middle, { x: endPoint.x, z: endPoint.z }]);
}
