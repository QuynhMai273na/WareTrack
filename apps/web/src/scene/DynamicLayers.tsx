import { Html, RoundedBox } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import type { SiteSnapshot, SnapshotTruck } from '@waretrack/shared-schemas';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRunInfo } from '@/lib/queries';
import { useScene, type SelectableType } from '@/stores/scene';
import { useTraffic } from '@/stores/traffic';
import { Animated } from './Animated';
import { type LayoutIndex, outward, type Placed, tangent } from './layoutIndex';
import { CarModel, ForkliftModel, MapPin, PalletModel, TruckModel } from './models';
import { dockingApproach, EN_ROUTE_SPEED, exitPlan, forkliftDockSpots, truckTarget, type TruckTarget, type Waypoint } from './motion';
import { polylineLength, projectOntoPolyline, type SiteRoutes, slicePolyline } from './network';
import { PathFollower, ShuttleMover } from './Movers';
import { objectKey, registerObject, takePose } from './registry';

function useSelectHandlers(siteId: string, type: SelectableType, id: string) {
  const select = useScene((state) => state.select);
  const setHover = useScene((state) => state.setHover);
  return {
    onClick: (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation();
      select({ siteId, type, id });
    },
    onPointerOver: (event: ThreeEvent<PointerEvent>) => {
      event.stopPropagation();
      setHover({ siteId, type, id });
      document.body.style.cursor = 'pointer';
    },
    onPointerOut: () => {
      setHover(null);
      document.body.style.cursor = '';
    },
  };
}

function SceneLabel({ text, sub, selected, y }: { text: string; sub?: string | null; selected: boolean; y: number }) {
  return (
    <Html position={[0, y, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
      <div className={`scene-label${selected ? ' selected' : ''}`}>
        {text}
        {sub ? <span className="muted">{sub}</span> : null}
      </div>
    </Html>
  );
}

/** Cửa dock theo mặt nhà (xoay theo rotY) — màu theo trạng thái hiệu lực (mục 9.3); có xe thì cửa mở thấy hàng. */
const DockDoor = memo(function DockDoor({ siteId, dock, placed, selected }: { siteId: string; dock: SiteSnapshot['docks'][number]; placed: Placed; selected: boolean }) {
  const handlers = useSelectHandlers(siteId, 'dock', dock.locationId);
  const panel = dock.effectiveStatus === 'OUT_OF_SERVICE' ? '#f3b4b4' : dock.effectiveStatus === 'RESERVED' ? '#d6e1f8' : '#dfe5f1';
  const open = dock.effectiveStatus === 'OCCUPIED';
  const doorH = open ? 1.2 : 4.0;
  const frame = selected ? '#2f6fe4' : '#1f3f8f';
  const num = placed.label.replace(/^\D+/, '') || placed.label;
  return (
    <group
      position={[placed.x, 0, placed.z]}
      rotation={[0, placed.rotY, 0]}
      ref={(doorGroup) => {
        if (doorGroup) registerObject(objectKey('dock', dock.locationId), doorGroup);
      }}
      {...handlers}
    >
      {[-2.2, 2.2].map((x) => (
        <mesh key={x} position={[x, 2.35, 0.17]} castShadow>
          <boxGeometry args={[0.34, 4.7, 0.4]} />
          <meshStandardMaterial color={frame} />
        </mesh>
      ))}
      <mesh position={[0, 4.7, 0.17]} castShadow>
        <boxGeometry args={[4.75, 0.34, 0.4]} />
        <meshStandardMaterial color={frame} />
      </mesh>
      <mesh position={[0, 2.25, 0.03]}>
        <boxGeometry args={[4.1, 4.4, 0.02]} />
        <meshStandardMaterial color="#525d7a" />
      </mesh>
      <group position={[0, 0.7, -0.3]}>
        <PalletModel scale={1.2} tiers={2} />
      </group>
      <group position={[0, 4.5 - doorH / 2, 0.08]}>
        <mesh>
          <boxGeometry args={[4.1, doorH, 0.05]} />
          <meshStandardMaterial color={panel} roughness={0.6} />
        </mesh>
        {Array.from({ length: Math.floor(doorH / 0.42) }).map((_, slatIndex) => (
          <mesh key={slatIndex} position={[0, doorH / 2 - 0.3 - slatIndex * 0.42, 0.03]}>
            <boxGeometry args={[4.05, 0.035, 0.01]} />
            <meshStandardMaterial color="#b9c3d8" />
          </mesh>
        ))}
      </group>
      {[-1.6, 1.6].map((x) => (
        <mesh key={x} position={[x, 0.55, 0.42]} castShadow>
          <boxGeometry args={[0.36, 0.6, 0.3]} />
          <meshStandardMaterial color="#1f2937" />
        </mesh>
      ))}
      <RoundedBox args={[0.8, 0.8, 0.1]} radius={0.1} position={[-1.7, 5.35, 0.3]}>
        <meshStandardMaterial color="#2f6fe4" />
      </RoundedBox>
      <Html position={[-1.7, 5.35, 0.4]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
        <div style={{ color: 'white', fontSize: 9, fontWeight: 700 }}>{num}</div>
      </Html>
      {selected ? <SceneLabel y={6.6} text={placed.label} sub={dock.effectiveStatus === 'RESERVED' ? 'Booked' : dock.effectiveStatus === 'OCCUPIED' ? 'Busy' : 'Free'} selected /> : null}
    </group>
  );
});

const TRUCK_STATUS_TEXT: Record<string, string> = { SCHEDULED: 'En route', AT_GATE: 'At gate', WAITING: 'Waiting', DOCK_ASSIGNED: 'Docking', AT_DOCK: 'At dock', HANDLING: 'Handling', READY_TO_LEAVE: 'Ready' };

const Truck = memo(function Truck({ siteId, truck, target, selected, hovered }: { siteId: string; truck: SnapshotTruck; target: TruckTarget; selected: boolean; hovered: boolean }) {
  const { t } = useTranslation();
  const handlers = useSelectHandlers(siteId, 'truck', truck.visitId);
  return (
    <PathFollower objectKey={objectKey('truck', truck.visitId)} target={target} speed={truck.status === 'SCHEDULED' ? EN_ROUTE_SPEED * 1.25 : 7}>
      <group {...handlers}>
        <TruckModel carrier={truck.carrier} type={truck.truckType} />
      </group>
      {selected || hovered ? <SceneLabel y={5.6} text={truck.truckCode} sub={t(`status.${truck.status}`, { defaultValue: TRUCK_STATUS_TEXT[truck.status] })} selected={selected} /> : null}
    </PathFollower>
  );
});

type DepartingGhost = { id: string; truck: SnapshotTruck; from: { x: number; z: number; rotY: number }; plan: Waypoint[]; destinationSiteId?: string };

/** Xe vừa rời site (EXITED): chạy hết lộ trình rời (lối ra → đại lộ → site khác / ra khỏi bản đồ) rồi mới thôi vẽ. */
function DepartingTruck({ ghost, onDone }: { ghost: DepartingGhost; onDone: () => void }) {
  const [target, setTarget] = useState<TruckTarget>(() => ({ key: 'start', x: ghost.from.x, z: ghost.from.z, rotY: ghost.from.rotY, visible: true, plan: () => [] }));
  useEffect(() => {
    const last = ghost.plan[ghost.plan.length - 1] ?? ghost.from;
    const id = setTimeout(() => setTarget({ key: 'exit', x: last.x, z: last.z, rotY: ghost.from.rotY, visible: true, plan: () => ghost.plan }), 50);
    return () => clearTimeout(id);
  }, [ghost]);
  return (
    <PathFollower objectKey={`ghost:${ghost.id}`} target={target} speed={9} onIdle={() => target.key === 'exit' && onDone()}>
      <TruckModel carrier={ghost.truck.carrier} type={ghost.truck.truckType} />
    </PathFollower>
  );
}

/** Dải lộ trình xanh (video: đường đi của xe đang được chọn) + chấm dẫn vào bay + ghim. */
function RouteRibbon({ points }: { points: Waypoint[] }) {
  const segs = points.slice(1).map((endPoint, segmentIndex) => ({ startPoint: points[segmentIndex], endPoint }));
  return (
    <group>
      {segs.map(({ startPoint, endPoint }, segmentIndex) => {
        const len = Math.hypot(endPoint.x - startPoint.x, endPoint.z - startPoint.z);
        if (len < 0.2) return null;
        return (
          <mesh key={segmentIndex} position={[(startPoint.x + endPoint.x) / 2, 0.06, (startPoint.z + endPoint.z) / 2]} rotation={[0, Math.atan2(endPoint.x - startPoint.x, endPoint.z - startPoint.z), 0]}>
            <boxGeometry args={[1.1, 0.02, len + 1.1]} />
            <meshBasicMaterial color="#2f6fe4" />
          </mesh>
        );
      })}
    </group>
  );
}

function DockingMarker({ dock, from }: { dock: Placed; from: { x: number; z: number } }) {
  const outwardDirection = outward(dock);
  const bayMouth = { x: dock.x + outwardDirection.x * 3, z: dock.z + outwardDirection.z * 3 };
  const dots = useMemo(() => {
    const out: Array<[number, number]> = [];
    const dotCount = 5;
    for (let dotIndex = 1; dotIndex <= dotCount; dotIndex++) out.push([from.x + ((bayMouth.x - from.x) * dotIndex) / (dotCount + 1), from.z + ((bayMouth.z - from.z) * dotIndex) / (dotCount + 1)]);
    return out;
  }, [from.x, from.z, bayMouth.x, bayMouth.z]);
  return (
    <group>
      {dots.map(([x, z], dotIndex) => (
        <mesh key={dotIndex} position={[x, 0.06, z]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.32, 16]} />
          <meshBasicMaterial color="#2f6fe4" />
        </mesh>
      ))}
      <mesh position={[bayMouth.x, 0.06, bayMouth.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1, 28]} />
        <meshBasicMaterial color="#2f6fe4" />
      </mesh>
      <mesh position={[bayMouth.x, 0.055, bayMouth.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.3, 1.7, 32]} />
        <meshBasicMaterial color="#9db8f5" />
      </mesh>
      <group position={[bayMouth.x, 0.2, bayMouth.z]}>
        <MapPin scale={1.15} />
      </group>
    </group>
  );
}

/** Pallet theo vị trí: ô sàn xếp lưới 2 cột, rack theo tầng/khoang, dock xếp cạnh đuôi xe. */
function palletSlotOffset(placed: Placed, slotIndex: number): { x: number; y: number; z: number; scale: number } {
  const rot = (lx: number, lz: number) => ({ x: placed.x + lx * Math.cos(placed.rotY) + lz * Math.sin(placed.rotY), z: placed.z - lx * Math.sin(placed.rotY) + lz * Math.cos(placed.rotY) });
  if (placed.display === 'rack') {
    const perLevel = placed.bays;
    const level = Math.floor(slotIndex / perLevel) % placed.levels;
    const bay = slotIndex % perLevel;
    const bw = placed.sx / placed.bays;
    const slotPosition = rot(-placed.sx / 2 + bw * (bay + 0.5), 0);
    return { x: slotPosition.x, y: 0.2 + level * 1.5, z: slotPosition.z, scale: 1 };
  }
  if (placed.type === 'DOCK') {
    const outwardDirection = outward(placed);
    const tangentDirection = tangent(placed);
    const side = slotIndex % 2 === 0 ? 1 : -1;
    const stackRow = Math.floor(slotIndex / 2);
    return { x: placed.x + outwardDirection.x * (2.2 + stackRow * 1.7) + tangentDirection.x * side * 4.2, y: 0, z: placed.z + outwardDirection.z * (2.2 + stackRow * 1.7) + tangentDirection.z * side * 4.2, scale: 1.3 };
  }
  const cols = placed.sx > 4 ? 3 : 2;
  const col = slotIndex % cols;
  const rowN = Math.floor(slotIndex / cols);
  const slotPosition = rot((col - (cols - 1) / 2) * 1.5, (rowN - 0) * 1.4 - 0.3);
  return { x: slotPosition.x, y: 0, z: slotPosition.z, scale: 1.3 };
}

const Pallets = memo(function Pallets({ siteId, pallets, layout, selectedId }: { siteId: string; pallets: SiteSnapshot['pallets']; layout: LayoutIndex; selectedId: string | null }) {
  const grouped = useMemo(() => {
    const palletsByLocation = new Map<string, SiteSnapshot['pallets']>();
    for (const pallet of pallets) {
      const loc = pallet.position?.locationId;
      if (!loc || !layout.byLocation.has(loc)) continue;
      const list = palletsByLocation.get(loc) ?? [];
      list.push(pallet);
      palletsByLocation.set(loc, list);
    }
    return palletsByLocation;
  }, [pallets, layout]);
  return (
    <group>
      {[...grouped.entries()].flatMap(([locId, list]) => {
        const placed = layout.byLocation.get(locId)!;
        if (!['STAGING', 'STORAGE', 'DOCK', 'QUARANTINE', 'YARD_SLOT'].includes(placed.type)) return [];
        return list
          .slice()
          .sort((firstPallet, secondPallet) => firstPallet.code.localeCompare(secondPallet.code))
          .slice(0, placed.type === 'DOCK' ? 6 : 12)
          .map((pallet, slotIndex) => {
            const slotOffset = palletSlotOffset(placed, slotIndex);
            return <PalletItem key={pallet.id} siteId={siteId} pallet={pallet} x={slotOffset.x} y={slotOffset.y} z={slotOffset.z} scale={slotOffset.scale} rotY={placed.rotY} selected={selectedId === pallet.id} />;
          });
      })}
    </group>
  );
});

const BLUE_SKUS = ['glove', 'container'];
function PalletItem({ siteId, pallet, x, y, z, scale, rotY, selected }: { siteId: string; pallet: SiteSnapshot['pallets'][number]; x: number; y: number; z: number; scale: number; rotY: number; selected: boolean }) {
  const handlers = useSelectHandlers(siteId, 'pallet', pallet.id);
  const label = pallet.label.toLowerCase();
  const color = pallet.stockStatus === 'QUARANTINE' || pallet.stockStatus === 'DAMAGED' ? '#ef8a8a' : BLUE_SKUS.some((skuKeyword) => label.includes(skuKeyword)) ? '#3b6fe0' : label.includes('peas') || label.includes('berries') || label.includes('water') || label.includes('juice') ? '#eef2f8' : '#d9a86c';
  return (
    <Animated objectKey={objectKey('pallet', pallet.id)} x={x} z={z} rotY={rotY} speed={4}>
      <group position={[0, y, 0]} {...handlers}>
        <PalletModel boxColor={color} tiers={y > 1 ? 1 : 2} scale={scale} />
      </group>
      {selected ? <SceneLabel y={y + 2.4 * scale} text={pallet.code} sub={pallet.label} selected /> : null}
    </Animated>
  );
}

/** Xe ô tô lưu bãi tại parking slot (Phase 5). */
function Vehicles({ siteId, vehicles, layout, selectedId }: { siteId: string; vehicles: SiteSnapshot['vehicles']; layout: LayoutIndex; selectedId: string | null }) {
  return (
    <group>
      {vehicles.map((vehicle) => {
        const placed = vehicle.position?.locationId ? layout.byLocation.get(vehicle.position.locationId) : undefined;
        if (!placed) return null;
        return <VehicleItem key={vehicle.stayId} siteId={siteId} vehicle={vehicle} x={placed.x} z={placed.z} selected={selectedId === vehicle.stayId} />;
      })}
    </group>
  );
}

const CAR_COLORS = ['#e2e8f0', '#1e293b', '#b91c1c', '#2563eb', '#94a3b8', '#f8fafc'];

function VehicleItem({ siteId, vehicle, x, z, selected }: { siteId: string; vehicle: SiteSnapshot['vehicles'][number]; x: number; z: number; selected: boolean }) {
  const handlers = useSelectHandlers(siteId, 'vehicle', vehicle.stayId);
  const color = CAR_COLORS[vehicle.vin.charCodeAt(16) % CAR_COLORS.length];
  return (
    <Animated objectKey={objectKey('vehicle', vehicle.stayId)} x={x} z={z} rotY={0} speed={5}>
      <group {...handlers}>
        <CarModel color={color} />
        {vehicle.hold ? (
          <group position={[0, 1.4, 0]}>
            <MapPin color="#ef4444" scale={0.7} />
          </group>
        ) : null}
      </group>
      {selected ? <SceneLabel y={2.4} text={vehicle.vin.slice(-6)} sub={vehicle.label} selected /> : null}
    </Animated>
  );
}

/** Mã bay ("Bay 1", "In 2") trong task summary của xe nâng → dock. */
function dockFromSummary(summary: string | null, layout: LayoutIndex, trucks: SnapshotTruck[]): Placed | undefined {
  if (!summary) return undefined;
  const truck = trucks.find((candidateTruck) => summary.includes(candidateTruck.truckCode));
  if (truck?.dockLocationId) return layout.byLocation.get(truck.dockLocationId);
  const docks = layout.locations.filter((location) => location.type === 'DOCK');
  return docks.find((dock) => summary.toLowerCase().includes(dock.label.toLowerCase()));
}

function nearestStaging(layout: LayoutIndex, from: { x: number; z: number }, pallets: SiteSnapshot['pallets']) {
  const withPallets = new Set(pallets.map((pallet) => pallet.position?.locationId));
  const floors = layout.locations.filter((location) => location.display === 'floor');
  const pool = floors.filter((location) => withPallets.has(location.id));
  const list = pool.length ? pool : floors;
  return list.reduce<Placed | undefined>((best, location) => (!best || Math.hypot(location.x - from.x, location.z - from.z) < Math.hypot(best.x - from.x, best.z - from.z) ? location : best), undefined);
}

const Forklift = memo(function Forklift({ siteId, forklift, layout, trucks, pallets, shipments, autoplay, index, selected, hovered }: { siteId: string; forklift: SiteSnapshot['forklifts'][number]; layout: LayoutIndex; trucks: SnapshotTruck[]; pallets: SiteSnapshot['pallets']; shipments: SiteSnapshot['activeShipments']; autoplay: boolean; index: number; selected: boolean; hovered: boolean }) {
  const handlers = useSelectHandlers(siteId, 'forklift', forklift.id);
  const dim = forklift.status === 'OFFLINE' || forklift.status === 'MAINTENANCE';
  const busy = forklift.status === 'BUSY' || forklift.status === 'ASSIGNED';
  const summaryDock = busy ? dockFromSummary(forklift.taskSummary, layout, trucks) : undefined;
  const dockTruck = summaryDock ? trucks.find((truck) => truck.dockLocationId === summaryDock.id) : undefined;
  // Thủ công: chỉ đứng làm việc ở dock khi thật sự có xe tải đỗ ở đó (xe đã đi thì về trạm sạc)
  const dock = autoplay || dockTruck ? summaryDock : undefined;
  // Số pallet đã xếp/nhận của lô hàng gắn với xe tải ở dock — tăng lên là xe nâng chạy một chuyến
  const tripCount = dockTruck ? (shipments.find((shipment) => shipment.visitId === dockTruck.visitId)?.progress.done ?? 0) : 0;
  const label = selected || hovered ? <SceneLabel y={4.2} text={forklift.code} sub={busy ? (forklift.taskSummary?.startsWith('Unloading') ? 'Unloading truck' : 'Loading truck') : forklift.status === 'CHARGING' ? 'Charging' : 'Idle'} selected={selected} /> : null;
  if (dock) {
    const spots = forkliftDockSpots(dock);
    const stg = nearestStaging(layout, dock, pallets);
    const far = stg ? { x: stg.x + outward(stg).x * 2.2, z: stg.z + outward(stg).z * 2.2 } : { x: dock.x + outward(dock).x * 9 + tangent(dock).x * 8, z: dock.z + outward(dock).z * 9 + tangent(dock).z * 8 };
    const loading = !forklift.taskSummary?.startsWith('Unloading');
    const shuttleStart = loading ? far : spots.atTruck;
    const shuttleEnd = loading ? spots.atTruck : far;
    return (
      <ShuttleMover
        objectKey={objectKey('forklift', forklift.id)}
        startPoint={shuttleStart}
        endPoint={shuttleEnd}
        phase={index * 5.3}
        autoplay={autoplay}
        tripCount={tripCount}
        render={(carrying) => (
          <group {...handlers} scale={1.25}>
            <ForkliftModel dim={dim} carrying={carrying} />
            {label}
          </group>
        )}
      />
    );
  }
  // Không có việc: đỗ tại trạm sạc (đang sạc) hoặc ngay trước trạm (chờ việc)
  const charger = forklift.position?.locationId ? layout.byLocation.get(forklift.position.locationId) : layout.locations.find((location) => location.type === 'CHARGER');
  if (!charger) return null;
  const outwardDirection = outward(charger);
  const parkDistance = forklift.status === 'CHARGING' ? 0.4 : 3.2;
  return (
    <Animated objectKey={objectKey('forklift', forklift.id)} x={charger.x + outwardDirection.x * parkDistance} z={charger.z + outwardDirection.z * parkDistance} rotY={charger.rotY + Math.PI} speed={3}>
      <group {...handlers} scale={1.25}>
        <ForkliftModel dim={dim} carrying={false} />
      </group>
      {label}
    </Animated>
  );
});

/** Các layer động: dữ liệu lấy từ Business State (snapshot trong TanStack Query). */
export function DynamicLayers({ snapshot, layout, routes, transferTargetFor }: { snapshot: SiteSnapshot; layout: LayoutIndex; routes?: SiteRoutes; transferTargetFor?: (truckCode: string) => string | undefined }) {
  const selection = useScene((state) => state.selection);
  const hover = useScene((state) => state.hover);
  // Xe nâng chạy vòng liên tục chỉ khi DemoDirector tự vận hành; còn lại chỉ chạy theo thao tác thật
  const autoplay = useRunInfo().data?.motion === 'auto';
  const siteId = snapshot.site.id;
  const sel = (type: SelectableType, id: string) => selection?.type === type && selection.id === id;
  const hov = (type: SelectableType, id: string) => hover?.type === type && hover.id === id;

  // Đồng hồ cho xe đang tới (vị trí theo ETA)
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);

  // Xe đang chạy từ site khác tới đây: ẩn bản "đang tới" cho tới khi chuyến chuyển site chạy xong
  const inTransit = useTraffic((state) => state.inTransit);
  // Xe đã hiển thị ít nhất một lần; xe mới (sau lần tải đầu) chạy từ ngoài bản đồ vào thay vì hiện ra giữa đường
  const shownVisits = useRef(new Set<string>());
  const firstLoadDone = useRef(false);
  const truckTargets = useMemo(() => {
    let waiting = 0;
    return snapshot.trucks.map((truck) => {
      const approach = routes?.approachFor(truck.truckCode);
      const target = truckTarget(truck, layout, truck.status === 'WAITING' ? waiting++ : waiting, now, approach);
      const arrivingFromOtherSite = truck.status === 'SCHEDULED' && inTransit[truck.truckCode] === snapshot.site.id;
      if (arrivingFromOtherSite) return { truck, target: { ...target, visible: false } };
      const enteringMap = firstLoadDone.current && target.visible && !shownVisits.current.has(truck.visitId) && approach && approach.length >= 2;
      const spawn = enteringMap ? { x: approach[0].x, z: approach[0].z, rotY: Math.atan2(approach[1].x - approach[0].x, approach[1].z - approach[0].z) } : undefined;
      return { truck, target: spawn ? { ...target, spawn } : target };
    });
  }, [snapshot.trucks, snapshot.site.id, layout, now, routes, inTransit]);
  useEffect(() => {
    for (const { truck, target } of truckTargets) if (target.visible) shownVisits.current.add(truck.visitId);
    firstLoadDone.current = true;
  }, [truckTargets]);

  // Xe biến khỏi snapshot (đã rời site / bị từ chối ở cổng) → chạy hết lộ trình rời rồi mới thôi vẽ, không biến mất tại chỗ
  const prevTrucks = useRef(new Map<string, SnapshotTruck>());
  const [ghosts, setGhosts] = useState<DepartingGhost[]>([]);
  const beginTransit = useTraffic((state) => state.beginTransit);
  const endTransit = useTraffic((state) => state.endTransit);
  useEffect(() => {
    const current = new Map(snapshot.trucks.map((truck) => [truck.visitId, truck]));
    const gone: DepartingGhost[] = [];
    for (const [id, previousTruck] of prevTrucks.current) {
      if (current.has(id)) continue;
      const pose = takePose(objectKey('truck', id));
      if (!pose?.visible) continue;
      const from = { x: pose.x, z: pose.z, rotY: pose.rotY };
      // Chuyến tiếp theo ở site khác → chạy thẳng sang đó; quay lại chính site này thì cứ ra khỏi bản đồ
      const nextSiteId = transferTargetFor?.(previousTruck.truckCode);
      const destinationSiteId = nextSiteId && nextSiteId !== snapshot.site.id ? nextSiteId : undefined;
      const plan = exitPlan(from, layout, { departure: routes?.departureFor(previousTruck.truckCode, destinationSiteId), approach: routes?.approachFor(previousTruck.truckCode), leftFrom: previousTruck.status });
      if (destinationSiteId) beginTransit(previousTruck.truckCode, destinationSiteId);
      gone.push({ id: `${id}:${Date.now()}`, truck: previousTruck, from, plan, destinationSiteId });
    }
    prevTrucks.current = current;
    if (gone.length) setGhosts((previousGhosts) => [...previousGhosts, ...gone]);
  }, [snapshot.trucks, snapshot.site.id, layout, routes, transferTargetFor, beginTransit]);
  const finishGhost = (ghost: DepartingGhost) => {
    setGhosts((all) => all.filter((otherGhost) => otherGhost.id !== ghost.id));
    if (ghost.destinationSiteId) endTransit(ghost.truck.truckCode);
  };

  const stagedPins = useMemo(() => {
    const locs = new Set<string>();
    for (const pallet of snapshot.pallets) {
      const loc = pallet.position?.locationId ? layout.byLocation.get(pallet.position.locationId) : undefined;
      if (pallet.lifecycle === 'STAGED' && loc && loc.display === 'floor' && !loc.label.startsWith('Yard')) locs.add(loc.id);
    }
    return [...locs].map((id) => layout.byLocation.get(id)!).slice(0, 6);
  }, [snapshot.pallets, layout]);

  const selectedTruck = selection?.type === 'truck' ? truckTargets.find((truckEntry) => truckEntry.truck.visitId === selection.id) : undefined;
  const ribbon = useMemo(() => {
    if (!selectedTruck || !['SCHEDULED', 'AT_GATE', 'DOCK_ASSIGNED'].includes(selectedTruck.truck.status)) return null;
    const { target, truck } = selectedTruck;
    const approach = routes?.approachFor(truck.truckCode);
    if (truck.status === 'SCHEDULED' && approach && approach.length >= 2) {
      // Xe đang tới: phần đường còn lại tới cổng + đường lùi vào bay đã đặt trước (nếu có)
      const remaining = slicePolyline(approach, projectOntoPolyline(approach, target).travelled, polylineLength(approach));
      const bookedDock = truck.dockLocationId ? layout.byLocation.get(truck.dockLocationId) : undefined;
      return [...remaining, ...(bookedDock ? dockingApproach(bookedDock, 9) : [])];
    }
    return [{ x: target.x, z: target.z }, ...target.plan({ x: target.x, z: target.z })];
  }, [selectedTruck, routes, layout]);

  return (
    <group>
      {snapshot.docks.map((dock) => {
        const placed = layout.byLocation.get(dock.locationId);
        return placed ? <DockDoor key={dock.locationId} siteId={siteId} dock={dock} placed={placed} selected={sel('dock', dock.locationId)} /> : null;
      })}
      {truckTargets.map(({ truck, target }) => (target.visible ? <Truck key={truck.visitId} siteId={siteId} truck={truck} target={target} selected={sel('truck', truck.visitId)} hovered={hov('truck', truck.visitId)} /> : null))}
      {ghosts.map((ghost) => (
        <DepartingTruck key={ghost.id} ghost={ghost} onDone={() => finishGhost(ghost)} />
      ))}
      {truckTargets
        .filter(({ truck, target }) => truck.status === 'DOCK_ASSIGNED' && target.visible && truck.dockLocationId)
        .map(({ truck, target }) => {
          const dock = layout.byLocation.get(truck.dockLocationId!);
          return dock ? <DockingMarker key={`dm:${truck.visitId}`} dock={dock} from={{ x: target.x - outward(dock).x * 7.5, z: target.z - outward(dock).z * 7.5 }} /> : null;
        })}
      {ribbon ? <RouteRibbon points={ribbon} /> : null}
      {snapshot.forklifts.map((forklift, forkliftIndex) => (
        <Forklift key={forklift.id} siteId={siteId} forklift={forklift} layout={layout} trucks={snapshot.trucks} pallets={snapshot.pallets} shipments={snapshot.activeShipments} autoplay={autoplay} index={forkliftIndex} selected={sel('forklift', forklift.id)} hovered={hov('forklift', forklift.id)} />
      ))}
      <Pallets siteId={siteId} pallets={snapshot.pallets} layout={layout} selectedId={selection?.type === 'pallet' ? selection.id : null} />
      {stagedPins.map((pinLocation) => (
        <group key={pinLocation.id} position={[pinLocation.x, 2.6, pinLocation.z]}>
          <MapPin />
        </group>
      ))}
      <Vehicles siteId={siteId} vehicles={snapshot.vehicles} layout={layout} selectedId={selection?.type === 'vehicle' ? selection.id : null} />
    </group>
  );
}
