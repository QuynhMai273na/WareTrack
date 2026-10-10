import { Html, RoundedBox } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import type { SiteSnapshot, SnapshotTruck } from '@waretrack/shared-schemas';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useScene, type SelectableType } from '@/stores/scene';
import { Animated } from './Animated';
import { type LayoutIndex, outward, type Placed, tangent } from './layoutIndex';
import { CarModel, ForkliftModel, MapPin, PalletModel, TruckModel } from './models';
import { exitPlan, forkliftDockSpots, truckTarget, type TruckTarget, type Waypoint } from './motion';
import { PathFollower, ShuttleMover } from './Movers';
import { getObject, objectKey, registerObject } from './registry';

function useSelectHandlers(siteId: string, type: SelectableType, id: string) {
  const select = useScene((s) => s.select);
  const setHover = useScene((s) => s.setHover);
  return {
    onClick: (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      select({ siteId, type, id });
    },
    onPointerOver: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
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
      ref={(g) => {
        if (g) registerObject(objectKey('dock', dock.locationId), g);
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
        {Array.from({ length: Math.floor(doorH / 0.42) }).map((_, i) => (
          <mesh key={i} position={[0, doorH / 2 - 0.3 - i * 0.42, 0.03]}>
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
    <PathFollower objectKey={objectKey('truck', truck.visitId)} target={target}>
      <group {...handlers}>
        <TruckModel carrier={truck.carrier} type={truck.truckType} />
      </group>
      {selected || hovered ? <SceneLabel y={5.6} text={truck.truckCode} sub={t(`status.${truck.status}`, { defaultValue: TRUCK_STATUS_TEXT[truck.status] })} selected={selected} /> : null}
    </PathFollower>
  );
});

/** Xe vừa rời dock (EXITED): chạy ra theo lanes.exit rồi biến mất (chỉ là animation). */
function DepartingTruck({ ghost, layout, onDone }: { ghost: { id: string; truck: SnapshotTruck; from: { x: number; z: number; rotY: number } }; layout: LayoutIndex; onDone: () => void }) {
  const [target, setTarget] = useState<TruckTarget>(() => ({ key: 'start', x: ghost.from.x, z: ghost.from.z, rotY: ghost.from.rotY, visible: true, plan: () => [] }));
  useEffect(() => {
    const plan = exitPlan(ghost.from, layout);
    const last = plan[plan.length - 1] ?? ghost.from;
    const id = setTimeout(() => setTarget({ key: 'exit', x: last.x, z: last.z, rotY: ghost.from.rotY, visible: true, plan: () => plan }), 50);
    return () => clearTimeout(id);
  }, [ghost, layout]);
  return (
    <PathFollower objectKey={`ghost:${ghost.id}`} target={target} onIdle={() => target.key === 'exit' && onDone()}>
      <TruckModel carrier={ghost.truck.carrier} type={ghost.truck.truckType} />
    </PathFollower>
  );
}

/** Dải lộ trình xanh (video: đường đi của xe đang được chọn) + chấm dẫn vào bay + ghim. */
function RouteRibbon({ points }: { points: Waypoint[] }) {
  const segs = points.slice(1).map((p, i) => ({ a: points[i], b: p }));
  return (
    <group>
      {segs.map(({ a, b }, i) => {
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < 0.2) return null;
        return (
          <mesh key={i} position={[(a.x + b.x) / 2, 0.06, (a.z + b.z) / 2]} rotation={[0, Math.atan2(b.x - a.x, b.z - a.z), 0]}>
            <boxGeometry args={[1.1, 0.02, len + 1.1]} />
            <meshBasicMaterial color="#2f6fe4" />
          </mesh>
        );
      })}
    </group>
  );
}

function DockingMarker({ dock, from }: { dock: Placed; from: { x: number; z: number } }) {
  const o = outward(dock);
  const bayMouth = { x: dock.x + o.x * 3, z: dock.z + o.z * 3 };
  const dots = useMemo(() => {
    const out: Array<[number, number]> = [];
    const n = 5;
    for (let i = 1; i <= n; i++) out.push([from.x + ((bayMouth.x - from.x) * i) / (n + 1), from.z + ((bayMouth.z - from.z) * i) / (n + 1)]);
    return out;
  }, [from.x, from.z, bayMouth.x, bayMouth.z]);
  return (
    <group>
      {dots.map(([x, z], i) => (
        <mesh key={i} position={[x, 0.06, z]} rotation={[-Math.PI / 2, 0, 0]}>
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
function palletSlotOffset(p: Placed, i: number): { x: number; y: number; z: number; scale: number } {
  const rot = (lx: number, lz: number) => ({ x: p.x + lx * Math.cos(p.rotY) + lz * Math.sin(p.rotY), z: p.z - lx * Math.sin(p.rotY) + lz * Math.cos(p.rotY) });
  if (p.display === 'rack') {
    const perLevel = p.bays;
    const level = Math.floor(i / perLevel) % p.levels;
    const bay = i % perLevel;
    const bw = p.sx / p.bays;
    const r = rot(-p.sx / 2 + bw * (bay + 0.5), 0);
    return { x: r.x, y: 0.2 + level * 1.5, z: r.z, scale: 1 };
  }
  if (p.type === 'DOCK') {
    const o = outward(p);
    const t = tangent(p);
    const side = i % 2 === 0 ? 1 : -1;
    const k = Math.floor(i / 2);
    return { x: p.x + o.x * (2.2 + k * 1.7) + t.x * side * 4.2, y: 0, z: p.z + o.z * (2.2 + k * 1.7) + t.z * side * 4.2, scale: 1.3 };
  }
  const cols = p.sx > 4 ? 3 : 2;
  const col = i % cols;
  const rowN = Math.floor(i / cols);
  const r = rot((col - (cols - 1) / 2) * 1.5, (rowN - 0) * 1.4 - 0.3);
  return { x: r.x, y: 0, z: r.z, scale: 1.3 };
}

const Pallets = memo(function Pallets({ siteId, pallets, layout, selectedId }: { siteId: string; pallets: SiteSnapshot['pallets']; layout: LayoutIndex; selectedId: string | null }) {
  const grouped = useMemo(() => {
    const m = new Map<string, SiteSnapshot['pallets']>();
    for (const p of pallets) {
      const loc = p.position?.locationId;
      if (!loc || !layout.byLocation.has(loc)) continue;
      const list = m.get(loc) ?? [];
      list.push(p);
      m.set(loc, list);
    }
    return m;
  }, [pallets, layout]);
  return (
    <group>
      {[...grouped.entries()].flatMap(([locId, list]) => {
        const placed = layout.byLocation.get(locId)!;
        if (!['STAGING', 'STORAGE', 'DOCK', 'QUARANTINE', 'YARD_SLOT'].includes(placed.type)) return [];
        return list
          .slice()
          .sort((a, b) => a.code.localeCompare(b.code))
          .slice(0, placed.type === 'DOCK' ? 6 : 12)
          .map((p, i) => {
            const o = palletSlotOffset(placed, i);
            return <PalletItem key={p.id} siteId={siteId} pallet={p} x={o.x} y={o.y} z={o.z} scale={o.scale} rotY={placed.rotY} selected={selectedId === p.id} />;
          });
      })}
    </group>
  );
});

const BLUE_SKUS = ['glove', 'container'];
function PalletItem({ siteId, pallet, x, y, z, scale, rotY, selected }: { siteId: string; pallet: SiteSnapshot['pallets'][number]; x: number; y: number; z: number; scale: number; rotY: number; selected: boolean }) {
  const handlers = useSelectHandlers(siteId, 'pallet', pallet.id);
  const label = pallet.label.toLowerCase();
  const color = pallet.stockStatus === 'QUARANTINE' || pallet.stockStatus === 'DAMAGED' ? '#ef8a8a' : BLUE_SKUS.some((k) => label.includes(k)) ? '#3b6fe0' : label.includes('peas') || label.includes('berries') || label.includes('water') || label.includes('juice') ? '#eef2f8' : '#d9a86c';
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
      {vehicles.map((v) => {
        const placed = v.position?.locationId ? layout.byLocation.get(v.position.locationId) : undefined;
        if (!placed) return null;
        return <VehicleItem key={v.stayId} siteId={siteId} vehicle={v} x={placed.x} z={placed.z} selected={selectedId === v.stayId} />;
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
  const truck = trucks.find((t) => summary.includes(t.truckCode));
  if (truck?.dockLocationId) return layout.byLocation.get(truck.dockLocationId);
  const docks = layout.locations.filter((l) => l.type === 'DOCK');
  return docks.find((d) => summary.toLowerCase().includes(d.label.toLowerCase()));
}

function nearestStaging(layout: LayoutIndex, from: { x: number; z: number }, pallets: SiteSnapshot['pallets']) {
  const withPallets = new Set(pallets.map((p) => p.position?.locationId));
  const floors = layout.locations.filter((l) => l.display === 'floor');
  const pool = floors.filter((l) => withPallets.has(l.id));
  const list = pool.length ? pool : floors;
  return list.reduce<Placed | undefined>((best, l) => (!best || Math.hypot(l.x - from.x, l.z - from.z) < Math.hypot(best.x - from.x, best.z - from.z) ? l : best), undefined);
}

const Forklift = memo(function Forklift({ siteId, forklift, layout, trucks, pallets, index, selected, hovered }: { siteId: string; forklift: SiteSnapshot['forklifts'][number]; layout: LayoutIndex; trucks: SnapshotTruck[]; pallets: SiteSnapshot['pallets']; index: number; selected: boolean; hovered: boolean }) {
  const handlers = useSelectHandlers(siteId, 'forklift', forklift.id);
  const dim = forklift.status === 'OFFLINE' || forklift.status === 'MAINTENANCE';
  const busy = forklift.status === 'BUSY' || forklift.status === 'ASSIGNED';
  const dock = busy ? dockFromSummary(forklift.taskSummary, layout, trucks) : undefined;
  const label = selected || hovered ? <SceneLabel y={4.2} text={forklift.code} sub={busy ? (forklift.taskSummary?.startsWith('Unloading') ? 'Unloading truck' : 'Loading truck') : forklift.status === 'CHARGING' ? 'Charging' : 'Idle'} selected={selected} /> : null;
  if (dock) {
    const spots = forkliftDockSpots(dock);
    const stg = nearestStaging(layout, dock, pallets);
    const far = stg ? { x: stg.x + outward(stg).x * 2.2, z: stg.z + outward(stg).z * 2.2 } : { x: dock.x + outward(dock).x * 9 + tangent(dock).x * 8, z: dock.z + outward(dock).z * 9 + tangent(dock).z * 8 };
    const loading = !forklift.taskSummary?.startsWith('Unloading');
    const a = loading ? far : spots.atTruck;
    const b = loading ? spots.atTruck : far;
    return (
      <ShuttleMover
        objectKey={objectKey('forklift', forklift.id)}
        a={a}
        b={b}
        phase={index * 5.3}
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
  const charger = forklift.position?.locationId ? layout.byLocation.get(forklift.position.locationId) : layout.locations.find((l) => l.type === 'CHARGER');
  if (!charger) return null;
  const o = outward(charger);
  const k = forklift.status === 'CHARGING' ? 0.4 : 3.2;
  return (
    <Animated objectKey={objectKey('forklift', forklift.id)} x={charger.x + o.x * k} z={charger.z + o.z * k} rotY={charger.rotY + Math.PI} speed={3}>
      <group {...handlers} scale={1.25}>
        <ForkliftModel dim={dim} carrying={false} />
      </group>
      {label}
    </Animated>
  );
});

/** Các layer động: dữ liệu lấy từ Business State (snapshot trong TanStack Query). */
export function DynamicLayers({ snapshot, layout }: { snapshot: SiteSnapshot; layout: LayoutIndex }) {
  const selection = useScene((s) => s.selection);
  const hover = useScene((s) => s.hover);
  const siteId = snapshot.site.id;
  const sel = (type: SelectableType, id: string) => selection?.type === type && selection.id === id;
  const hov = (type: SelectableType, id: string) => hover?.type === type && hover.id === id;

  // Đồng hồ cho xe đang tới (vị trí theo ETA)
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);

  const truckTargets = useMemo(() => {
    let waiting = 0;
    return snapshot.trucks.map((t) => ({ truck: t, target: truckTarget(t, layout, t.status === 'WAITING' ? waiting++ : waiting, now) }));
  }, [snapshot.trucks, layout, now]);

  // Xe biến khỏi snapshot (đã rời site) → chạy ra đường rồi biến mất
  const prevTrucks = useRef(new Map<string, SnapshotTruck>());
  const [ghosts, setGhosts] = useState<Array<{ id: string; truck: SnapshotTruck; from: { x: number; z: number; rotY: number } }>>([]);
  useEffect(() => {
    const current = new Map(snapshot.trucks.map((t) => [t.visitId, t]));
    const gone: typeof ghosts = [];
    for (const [id, t] of prevTrucks.current) {
      if (current.has(id) || !['HANDLING', 'AT_DOCK', 'READY_TO_LEAVE'].includes(t.status)) continue;
      const obj = getObject(objectKey('truck', id));
      if (obj) gone.push({ id: `${id}:${Date.now()}`, truck: t, from: { x: obj.position.x, z: obj.position.z, rotY: obj.rotation.y } });
    }
    prevTrucks.current = current;
    if (gone.length) setGhosts((g) => [...g, ...gone]);
  }, [snapshot.trucks]);

  const stagedPins = useMemo(() => {
    const locs = new Set<string>();
    for (const p of snapshot.pallets) {
      const loc = p.position?.locationId ? layout.byLocation.get(p.position.locationId) : undefined;
      if (p.lifecycle === 'STAGED' && loc && loc.display === 'floor' && !loc.label.startsWith('Yard')) locs.add(loc.id);
    }
    return [...locs].map((id) => layout.byLocation.get(id)!).slice(0, 6);
  }, [snapshot.pallets, layout]);

  const selectedTruck = selection?.type === 'truck' ? truckTargets.find((x) => x.truck.visitId === selection.id) : undefined;
  const ribbon = useMemo(() => {
    if (!selectedTruck || !['SCHEDULED', 'AT_GATE', 'DOCK_ASSIGNED'].includes(selectedTruck.truck.status)) return null;
    const { target } = selectedTruck;
    return [{ x: target.x, z: target.z }, ...target.plan({ x: target.x, z: target.z })];
  }, [selectedTruck]);

  return (
    <group>
      {snapshot.docks.map((d) => {
        const placed = layout.byLocation.get(d.locationId);
        return placed ? <DockDoor key={d.locationId} siteId={siteId} dock={d} placed={placed} selected={sel('dock', d.locationId)} /> : null;
      })}
      {truckTargets.map(({ truck, target }) => (target.visible ? <Truck key={truck.visitId} siteId={siteId} truck={truck} target={target} selected={sel('truck', truck.visitId)} hovered={hov('truck', truck.visitId)} /> : null))}
      {ghosts.map((g) => (
        <DepartingTruck key={g.id} ghost={g} layout={layout} onDone={() => setGhosts((all) => all.filter((x) => x.id !== g.id))} />
      ))}
      {truckTargets
        .filter(({ truck, target }) => truck.status === 'DOCK_ASSIGNED' && target.visible && truck.dockLocationId)
        .map(({ truck, target }) => {
          const dock = layout.byLocation.get(truck.dockLocationId!);
          return dock ? <DockingMarker key={`dm:${truck.visitId}`} dock={dock} from={{ x: target.x - outward(dock).x * 7.5, z: target.z - outward(dock).z * 7.5 }} /> : null;
        })}
      {ribbon ? <RouteRibbon points={ribbon} /> : null}
      {snapshot.forklifts.map((f, i) => (
        <Forklift key={f.id} siteId={siteId} forklift={f} layout={layout} trucks={snapshot.trucks} pallets={snapshot.pallets} index={i} selected={sel('forklift', f.id)} hovered={hov('forklift', f.id)} />
      ))}
      <Pallets siteId={siteId} pallets={snapshot.pallets} layout={layout} selectedId={selection?.type === 'pallet' ? selection.id : null} />
      {stagedPins.map((p) => (
        <group key={p.id} position={[p.x, 2.6, p.z]}>
          <MapPin />
        </group>
      ))}
      <Vehicles siteId={siteId} vehicles={snapshot.vehicles} layout={layout} selectedId={selection?.type === 'vehicle' ? selection.id : null} />
    </group>
  );
}
