import { RoundedBox, Text } from '@react-three/drei';
import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import { CanvasTexture, InstancedMesh, Object3D, RepeatWrapping, SRGBColorSpace, Vector3 } from 'three';

const UP = new Vector3(0, 1, 0);
import { useScene } from '@/stores/scene';
import { Building } from './Building';
import type { LayoutIndex, Placed } from './layoutIndex';
import { BushModel, ChargerModel, ContainerModel, TreeModel } from './models';

const deg = (d: number) => (d * Math.PI) / 180;
const YELLOW = '#f2b705';
type DecorProps = { kind?: string; color?: string | null; label?: string | null; size?: number; style?: string; lanes?: number; sidewalk?: boolean; x2?: number; z2?: number; green?: boolean };

/** Viền chữ nhật vạch sơn (ô staging, yard slot, bay dock) theo transform của vị trí. */
function LineRect({ p, color, thickness = 0.14, open = false, offsetZ = 0 }: { p: Placed; color: string; thickness?: number; open?: boolean; offsetZ?: number }) {
  return (
    <group position={[p.x, 0.035, p.z]} rotation={[0, p.rotY, 0]}>
      <group position={[0, 0, offsetZ]}>
        {[p.sx / 2, -p.sx / 2].map((x) => (
          <mesh key={x} position={[x, 0, 0]}>
            <boxGeometry args={[thickness, 0.02, p.sz]} />
            <meshStandardMaterial color={color} />
          </mesh>
        ))}
        <mesh position={[0, 0, p.sz / 2]}>
          <boxGeometry args={[p.sx + thickness, 0.02, thickness]} />
          <meshStandardMaterial color={color} />
        </mesh>
        {!open ? (
          <mesh position={[0, 0, -p.sz / 2]}>
            <boxGeometry args={[p.sx + thickness, 0.02, thickness]} />
            <meshStandardMaterial color={color} />
          </mesh>
        ) : null}
      </group>
    </group>
  );
}

/** Rack ngoài trời: cột xanh + thanh cam theo số tầng/khoang (instanced — mục 18.11). */
function Racks({ racks }: { racks: Placed[] }) {
  const uprights = useRef<InstancedMesh>(null);
  const beams = useRef<InstancedMesh>(null);
  const counts = useMemo(() => racks.reduce((s, r) => ({ u: s.u + (r.bays + 1) * 2, b: s.b + r.bays * (r.levels + 1) * 2 }), { u: 0, b: 0 }), [racks]);
  useLayoutEffect(() => {
    const o = new Object3D();
    let u = 0;
    let b = 0;
    const H = (r: Placed) => r.levels * 1.5 + 0.4;
    for (const r of racks) {
      const bay = r.sx / r.bays;
      for (let i = 0; i <= r.bays; i++) {
        for (const dz of [-r.sz / 2, r.sz / 2]) {
          o.position.set(-r.sx / 2 + i * bay, H(r) / 2, dz);
          o.position.applyAxisAngle(UP, r.rotY);
          o.position.x += r.x;
          o.position.z += r.z;
          o.rotation.set(0, r.rotY, 0);
          o.scale.set(1, H(r), 1);
          o.updateMatrix();
          uprights.current?.setMatrixAt(u++, o.matrix);
        }
      }
      for (let i = 0; i < r.bays; i++) {
        for (let l = 0; l <= r.levels; l++) {
          for (const dz of [-r.sz / 2, r.sz / 2]) {
            o.position.set(-r.sx / 2 + (i + 0.5) * bay, 0.12 + l * 1.5, dz);
            o.position.applyAxisAngle(UP, r.rotY);
            o.position.x += r.x;
            o.position.z += r.z;
            o.rotation.set(0, r.rotY, 0);
            o.scale.set(bay, 1, 1);
            o.updateMatrix();
            beams.current?.setMatrixAt(b++, o.matrix);
          }
        }
      }
    }
    if (uprights.current) uprights.current.instanceMatrix.needsUpdate = true;
    if (beams.current) beams.current.instanceMatrix.needsUpdate = true;
  }, [racks]);
  return (
    <group>
      <instancedMesh ref={uprights} args={[undefined, undefined, counts.u]} castShadow>
        <boxGeometry args={[0.12, 1, 0.12]} />
        <meshStandardMaterial color="#2f5fd0" />
      </instancedMesh>
      <instancedMesh ref={beams} args={[undefined, undefined, counts.b]} castShadow>
        <boxGeometry args={[1, 0.14, 0.1]} />
        <meshStandardMaterial color="#f08a24" />
      </instancedMesh>
    </group>
  );
}

/** Lưới cửa sổ cho tòa nhà lân cận (texture dùng chung). */
let windowTex: CanvasTexture | null = null;
function windowsTexture() {
  if (windowTex) return windowTex;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e8ebf8';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#7f95d8';
  g.fillRect(12, 16, 40, 26);
  windowTex = new CanvasTexture(c);
  windowTex.wrapS = windowTex.wrapT = RepeatWrapping;
  windowTex.colorSpace = SRGBColorSpace;
  return windowTex;
}

function Neighbor({ w, d, h, style }: { w: number; d: number; h: number; style: string }) {
  const texX = useMemo(() => {
    const t = windowsTexture().clone();
    t.repeat.set(Math.round(w / 3.2), Math.round(h / 3.4));
    t.needsUpdate = true;
    return t;
  }, [w, h]);
  const texZ = useMemo(() => {
    const t = windowsTexture().clone();
    t.repeat.set(Math.round(d / 3.2), Math.round(h / 3.4));
    t.needsUpdate = true;
    return t;
  }, [d, h]);
  if (style === 'warehouse') {
    return (
      <group>
        <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[w, h, d]} />
          <meshStandardMaterial color="#dfe3ee" />
        </mesh>
        <mesh position={[0, h + 0.4, 0]} castShadow>
          <boxGeometry args={[w + 0.6, 0.8, d + 0.6]} />
          <meshStandardMaterial color="#cfd5e4" />
        </mesh>
      </group>
    );
  }
  return (
    <group>
      <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color="#e8ebf8" />
      </mesh>
      <mesh position={[0, h / 2, d / 2 + 0.02]}>
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial map={texX} />
      </mesh>
      <mesh position={[w / 2 + 0.02, h / 2, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[d, h]} />
        <meshStandardMaterial map={texZ} />
      </mesh>
      <mesh position={[0, h + 0.3, 0]}>
        <boxGeometry args={[w + 0.3, 0.6, d + 0.3]} />
        <meshStandardMaterial color="#f1f3fb" />
      </mesh>
    </group>
  );
}

/** Hàng rào lưới (+ dải cỏ xanh dọc hàng rào như video). */
function Fence({ x1, z1, x2, z2, green }: { x1: number; z1: number; x2: number; z2: number; green?: boolean }) {
  const posts = useRef<InstancedMesh>(null);
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  const n = Math.max(2, Math.floor(len / 3) + 1);
  useLayoutEffect(() => {
    const o = new Object3D();
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      o.position.set(x1 + dx * t, 1, z1 + dz * t);
      o.updateMatrix();
      posts.current?.setMatrixAt(i, o.matrix);
    }
    if (posts.current) posts.current.instanceMatrix.needsUpdate = true;
  }, [x1, z1, dx, dz, n]);
  const angle = Math.atan2(dx, dz);
  return (
    <group>
      <instancedMesh ref={posts} args={[undefined, undefined, n]} castShadow>
        <cylinderGeometry args={[0.06, 0.06, 2, 6]} />
        <meshStandardMaterial color="#a3adc4" />
      </instancedMesh>
      <group position={[x1 + dx / 2, 0, z1 + dz / 2]} rotation={[0, angle, 0]}>
        {[0.25, 1.95].map((y) => (
          <mesh key={y} position={[0, y, 0]}>
            <boxGeometry args={[0.05, 0.05, len]} />
            <meshStandardMaterial color="#a3adc4" />
          </mesh>
        ))}
        <mesh position={[0, 1.1, 0]}>
          <boxGeometry args={[0.02, 1.7, len]} />
          <meshStandardMaterial color="#cfd7ea" transparent opacity={0.4} />
        </mesh>
        {green ? (
          <mesh position={[-1.6, 0.04, 0]} receiveShadow>
            <boxGeometry args={[2.8, 0.06, len]} />
            <meshStandardMaterial color="#bfe9cf" />
          </mesh>
        ) : null}
      </group>
    </group>
  );
}

function Road({ w, d, lanes, sidewalk }: { w: number; d: number; lanes: number; sidewalk: boolean }) {
  const dashes = Math.floor(d / 9);
  return (
    <group>
      <mesh position={[0, 0.02, 0]} receiveShadow>
        <boxGeometry args={[w, 0.04, d]} />
        <meshStandardMaterial color="#d3d9f0" />
      </mesh>
      {/* Vạch giữa đứt + 2 vạch mép */}
      {lanes >= 2
        ? Array.from({ length: dashes }).map((_, i) => (
            <mesh key={i} position={[0, 0.045, -d / 2 + 4.5 + i * 9]}>
              <boxGeometry args={[0.28, 0.01, 3.4]} />
              <meshStandardMaterial color="#ffffff" />
            </mesh>
          ))
        : null}
      {[w / 2 - 0.6, -w / 2 + 0.6].map((x) => (
        <mesh key={x} position={[x, 0.045, 0]}>
          <boxGeometry args={[0.18, 0.01, d]} />
          <meshStandardMaterial color="#f4f6fd" />
        </mesh>
      ))}
      {sidewalk
        ? [w / 2 + 0.9, -w / 2 - 0.9].map((x) => (
            <mesh key={x} position={[x, 0.1, 0]} receiveShadow>
              <boxGeometry args={[1.8, 0.2, d]} />
              <meshStandardMaterial color="#f3f5fc" />
            </mesh>
          ))
        : null}
    </group>
  );
}

function Decor({ o }: { o: LayoutIndex['decor'][number] }) {
  const p = (o.props ?? {}) as DecorProps;
  const rot = deg(o.rotY);
  switch (p.kind) {
    case 'tree':
      return (
        <group position={[o.posX, 0, o.posZ]}>
          <TreeModel size={p.size ?? 1} />
        </group>
      );
    case 'bush':
      return (
        <group position={[o.posX, 0, o.posZ]}>
          <BushModel />
        </group>
      );
    case 'container':
      return (
        <group position={[o.posX, 0, o.posZ]} rotation={[0, rot, 0]}>
          <ContainerModel color={p.color ?? '#2bb3a3'} label={p.label ?? null} />
        </group>
      );
    case 'road':
      return (
        <group position={[o.posX, 0, o.posZ]} rotation={[0, rot, 0]}>
          <Road w={o.sizeX} d={o.sizeZ} lanes={p.lanes ?? 2} sidewalk={p.sidewalk ?? true} />
        </group>
      );
    case 'crosswalk':
      return (
        <group position={[o.posX, 0.05, o.posZ]}>
          {Array.from({ length: Math.floor(Math.max(o.sizeX, o.sizeZ) / 1.4) }).map((_, i) => (
            <mesh key={i} position={o.sizeX > o.sizeZ ? [-o.sizeX / 2 + 0.7 + i * 1.4, 0, 0] : [0, 0, -o.sizeZ / 2 + 0.7 + i * 1.4]}>
              <boxGeometry args={o.sizeX > o.sizeZ ? [0.7, 0.01, o.sizeZ] : [o.sizeX, 0.01, 0.7]} />
              <meshStandardMaterial color="#ffffff" />
            </mesh>
          ))}
        </group>
      );
    case 'fence':
      return <Fence x1={o.posX} z1={o.posZ} x2={p.x2 ?? o.posX} z2={p.z2 ?? o.posZ} green={p.green} />;
    case 'pad':
      return (
        <RoundedBox args={[o.sizeX, 0.06, o.sizeZ]} radius={0.03} position={[o.posX, 0.03, o.posZ]} receiveShadow>
          <meshStandardMaterial color={p.color ?? '#dff3e6'} />
        </RoundedBox>
      );
    case 'neighbor':
      return (
        <group position={[o.posX, 0, o.posZ]}>
          <Neighbor w={o.sizeX} d={o.sizeZ} h={o.sizeY} style={p.style ?? 'office'} />
        </group>
      );
    case 'silo':
      return (
        <group position={[o.posX, 0, o.posZ]}>
          <mesh position={[0, o.sizeY / 2, 0]} castShadow>
            <cylinderGeometry args={[3.2, 3.2, o.sizeY, 28]} />
            <meshStandardMaterial color="#f3f5fa" />
          </mesh>
          <mesh position={[0, o.sizeY, 0]} castShadow>
            <sphereGeometry args={[3.2, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
            <meshStandardMaterial color="#eef1f7" />
          </mesh>
        </group>
      );
    case 'shed':
      return (
        <group position={[o.posX, 0, o.posZ]} rotation={[0, rot, 0]}>
          <RoundedBox args={[o.sizeX, o.sizeY, o.sizeZ]} radius={0.15} position={[0, o.sizeY / 2, 0]} castShadow receiveShadow>
            <meshStandardMaterial color={p.color ?? '#3b6fe0'} />
          </RoundedBox>
          <mesh position={[0, o.sizeY + 0.3, 0]} castShadow>
            <boxGeometry args={[o.sizeX + 0.5, 0.6, o.sizeZ + 0.5]} />
            <meshStandardMaterial color="#2c5bd0" />
          </mesh>
        </group>
      );
    case 'cones':
      return (
        <group position={[o.posX, 0, o.posZ]}>
          {[0, 1.2, 2.4].map((x) => (
            <mesh key={x} position={[x, 0.35, 0]} castShadow>
              <coneGeometry args={[0.25, 0.7, 10]} />
              <meshStandardMaterial color="#f97316" />
            </mesh>
          ))}
        </group>
      );
    default:
      return null;
  }
}

/** Layout tĩnh của site — dựng từ LayoutObject (mục 18.1). Không chứa trạng thái nghiệp vụ. */
export const StaticLayout = memo(function StaticLayout({ layout, siteId }: { layout: LayoutIndex; siteId?: string }) {
  const byType = (t: string) => layout.locations.filter((l) => l.type === t);
  const racks = useMemo(() => layout.locations.filter((l) => l.type === 'STORAGE' && l.display === 'rack'), [layout]);
  const floors = useMemo(() => layout.locations.filter((l) => l.display === 'floor'), [layout]);
  const docks = useMemo(() => byType('DOCK'), [layout]); // eslint-disable-line react-hooks/exhaustive-deps
  const yardSlots = useMemo(() => byType('YARD_SLOT'), [layout]); // eslint-disable-line react-hooks/exhaustive-deps
  const parking = useMemo(() => byType('PARKING_SLOT'), [layout]); // eslint-disable-line react-hooks/exhaustive-deps
  const chargers = useMemo(() => byType('CHARGER'), [layout]); // eslint-disable-line react-hooks/exhaustive-deps
  const gates = useMemo(() => byType('GATE_LANE'), [layout]); // eslint-disable-line react-hooks/exhaustive-deps
  const quarantine = useMemo(() => byType('QUARANTINE'), [layout]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <group>
      {layout.zones.map((z) => {
        const color = ((z.props ?? {}) as { color?: string }).color;
        if (!color || color === 'transparent') return null;
        return (
          <mesh key={z.id} position={[z.posX, 0.006, z.posZ]} receiveShadow>
            <boxGeometry args={[z.sizeX, 0.01, z.sizeZ]} />
            <meshStandardMaterial color={color} />
          </mesh>
        );
      })}
      {layout.decor.map((d) => (
        <Decor key={d.id} o={d} />
      ))}
      {layout.buildings.map((bd) => (
        <Building key={bd.id} o={bd} />
      ))}
      {/* Bay dock: khung vàng phía trước cửa (mở về phía nhà) */}
      {docks.map((d) => (
        <LineRect key={d.id} p={d} color={YELLOW} thickness={0.16} open offsetZ={d.sz / 2 + 0.4} />
      ))}
      {yardSlots.map((s) => (
        <LineRect key={s.id} p={s} color={YELLOW} />
      ))}
      {floors.map((s) => (
        <LineRect key={s.id} p={s} color={YELLOW} thickness={0.1} />
      ))}
      {parking.map((s) => (
        <LineRect key={s.id} p={s} color="#ffffff" thickness={0.08} />
      ))}
      {quarantine.map((s) => (
        <mesh key={s.id} position={[s.x, 0.02, s.z]}>
          <boxGeometry args={[s.sx, 0.02, s.sz]} />
          <meshStandardMaterial color="#fbc4c4" />
        </mesh>
      ))}
      {racks.length > 0 ? <Racks racks={racks} /> : null}
      {chargers.map((c) => (
        <group
          key={c.id}
          position={[c.x, 0, c.z]}
          rotation={[0, c.rotY, 0]}
          onClick={(e) => {
            e.stopPropagation();
            if (siteId) useScene.getState().select({ siteId, type: 'charger', id: c.id });
          }}
        >
          <group position={[0, 0, -c.sz / 2 - 0.1]}>
            <ChargerModel active />
          </group>
          <Text position={[0, 0.07, 0.4]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.7} color="#166534">
            {c.code}
          </Text>
        </group>
      ))}
      {gates.map((g) => (
        <group key={g.id} position={[g.x, 0, g.z]} rotation={[0, g.rotY, 0]}>
          <RoundedBox args={[1.6, 2.6, 1.6]} radius={0.15} position={[-g.sx / 2 - 1.2, 1.3, 0]} castShadow>
            <meshStandardMaterial color="#f3f5fb" />
          </RoundedBox>
          <mesh position={[-g.sx / 2 - 0.3, 0.6, 0]} castShadow>
            <boxGeometry args={[0.35, 1.2, 0.35]} />
            <meshStandardMaterial color="#334155" />
          </mesh>
          <mesh position={[0, 1.05, 0]}>
            <boxGeometry args={[g.sx, 0.12, 0.12]} />
            <meshStandardMaterial color="#ef4444" />
          </mesh>
        </group>
      ))}
    </group>
  );
});
