import { RoundedBox, Text } from '@react-three/drei';
import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import { CanvasTexture, InstancedMesh, Object3D, RepeatWrapping, SRGBColorSpace, Vector3 } from 'three';

const UP = new Vector3(0, 1, 0);
import { useScene } from '@/stores/scene';
import { Building } from './Building';
import type { LayoutIndex, Placed } from './layoutIndex';
import { BushModel, ChargerModel, ContainerModel, TreeModel } from './models';

const deg = (degrees: number) => (degrees * Math.PI) / 180;
const YELLOW = '#f2b705';
type DecorProps = { kind?: string; color?: string | null; label?: string | null; size?: number; style?: string; lanes?: number; sidewalk?: boolean; x2?: number; z2?: number; green?: boolean };

/** Viền chữ nhật vạch sơn (ô staging, yard slot, bay dock) theo transform của vị trí. */
function LineRect({ placement, color, thickness = 0.14, open = false, offsetZ = 0 }: { placement: Placed; color: string; thickness?: number; open?: boolean; offsetZ?: number }) {
  return (
    <group position={[placement.x, 0.035, placement.z]} rotation={[0, placement.rotY, 0]}>
      <group position={[0, 0, offsetZ]}>
        {[placement.sx / 2, -placement.sx / 2].map((x) => (
          <mesh key={x} position={[x, 0, 0]}>
            <boxGeometry args={[thickness, 0.02, placement.sz]} />
            <meshStandardMaterial color={color} />
          </mesh>
        ))}
        <mesh position={[0, 0, placement.sz / 2]}>
          <boxGeometry args={[placement.sx + thickness, 0.02, thickness]} />
          <meshStandardMaterial color={color} />
        </mesh>
        {!open ? (
          <mesh position={[0, 0, -placement.sz / 2]}>
            <boxGeometry args={[placement.sx + thickness, 0.02, thickness]} />
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
  const counts = useMemo(() => racks.reduce((totals, rack) => ({ uprightCount: totals.uprightCount + (rack.bays + 1) * 2, beamCount: totals.beamCount + rack.bays * (rack.levels + 1) * 2 }), { uprightCount: 0, beamCount: 0 }), [racks]);
  useLayoutEffect(() => {
    const instanceTransform = new Object3D();
    let uprightIndex = 0;
    let beamIndex = 0;
    const rackHeight = (rack: Placed) => rack.levels * 1.5 + 0.4;
    for (const rack of racks) {
      const bay = rack.sx / rack.bays;
      for (let bayIndex = 0; bayIndex <= rack.bays; bayIndex++) {
        for (const dz of [-rack.sz / 2, rack.sz / 2]) {
          instanceTransform.position.set(-rack.sx / 2 + bayIndex * bay, rackHeight(rack) / 2, dz);
          instanceTransform.position.applyAxisAngle(UP, rack.rotY);
          instanceTransform.position.x += rack.x;
          instanceTransform.position.z += rack.z;
          instanceTransform.rotation.set(0, rack.rotY, 0);
          instanceTransform.scale.set(1, rackHeight(rack), 1);
          instanceTransform.updateMatrix();
          uprights.current?.setMatrixAt(uprightIndex++, instanceTransform.matrix);
        }
      }
      for (let bayIndex = 0; bayIndex < rack.bays; bayIndex++) {
        for (let levelIndex = 0; levelIndex <= rack.levels; levelIndex++) {
          for (const dz of [-rack.sz / 2, rack.sz / 2]) {
            instanceTransform.position.set(-rack.sx / 2 + (bayIndex + 0.5) * bay, 0.12 + levelIndex * 1.5, dz);
            instanceTransform.position.applyAxisAngle(UP, rack.rotY);
            instanceTransform.position.x += rack.x;
            instanceTransform.position.z += rack.z;
            instanceTransform.rotation.set(0, rack.rotY, 0);
            instanceTransform.scale.set(bay, 1, 1);
            instanceTransform.updateMatrix();
            beams.current?.setMatrixAt(beamIndex++, instanceTransform.matrix);
          }
        }
      }
    }
    if (uprights.current) uprights.current.instanceMatrix.needsUpdate = true;
    if (beams.current) beams.current.instanceMatrix.needsUpdate = true;
  }, [racks]);
  return (
    <group>
      <instancedMesh ref={uprights} args={[undefined, undefined, counts.uprightCount]} castShadow>
        <boxGeometry args={[0.12, 1, 0.12]} />
        <meshStandardMaterial color="#2f5fd0" />
      </instancedMesh>
      <instancedMesh ref={beams} args={[undefined, undefined, counts.beamCount]} castShadow>
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
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#e8ebf8';
  context.fillRect(0, 0, 64, 64);
  context.fillStyle = '#7f95d8';
  context.fillRect(12, 16, 40, 26);
  windowTex = new CanvasTexture(canvas);
  windowTex.wrapS = windowTex.wrapT = RepeatWrapping;
  windowTex.colorSpace = SRGBColorSpace;
  return windowTex;
}

function Neighbor({ width, depth, height, style }: { width: number; depth: number; height: number; style: string }) {
  const texX = useMemo(() => {
    const texture = windowsTexture().clone();
    texture.repeat.set(Math.round(width / 3.2), Math.round(height / 3.4));
    texture.needsUpdate = true;
    return texture;
  }, [width, height]);
  const texZ = useMemo(() => {
    const texture = windowsTexture().clone();
    texture.repeat.set(Math.round(depth / 3.2), Math.round(height / 3.4));
    texture.needsUpdate = true;
    return texture;
  }, [depth, height]);
  if (style === 'warehouse') {
    return (
      <group>
        <mesh position={[0, height / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[width, height, depth]} />
          <meshStandardMaterial color="#dfe3ee" />
        </mesh>
        <mesh position={[0, height + 0.4, 0]} castShadow>
          <boxGeometry args={[width + 0.6, 0.8, depth + 0.6]} />
          <meshStandardMaterial color="#cfd5e4" />
        </mesh>
      </group>
    );
  }
  return (
    <group>
      <mesh position={[0, height / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[width, height, depth]} />
        <meshStandardMaterial color="#e8ebf8" />
      </mesh>
      <mesh position={[0, height / 2, depth / 2 + 0.02]}>
        <planeGeometry args={[width, height]} />
        <meshStandardMaterial map={texX} />
      </mesh>
      <mesh position={[width / 2 + 0.02, height / 2, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[depth, height]} />
        <meshStandardMaterial map={texZ} />
      </mesh>
      <mesh position={[0, height + 0.3, 0]}>
        <boxGeometry args={[width + 0.3, 0.6, depth + 0.3]} />
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
  const postCount = Math.max(2, Math.floor(len / 3) + 1);
  useLayoutEffect(() => {
    const postTransform = new Object3D();
    for (let postIndex = 0; postIndex < postCount; postIndex++) {
      const progress = postIndex / (postCount - 1);
      postTransform.position.set(x1 + dx * progress, 1, z1 + dz * progress);
      postTransform.updateMatrix();
      posts.current?.setMatrixAt(postIndex, postTransform.matrix);
    }
    if (posts.current) posts.current.instanceMatrix.needsUpdate = true;
  }, [x1, z1, dx, dz, postCount]);
  const angle = Math.atan2(dx, dz);
  return (
    <group>
      <instancedMesh ref={posts} args={[undefined, undefined, postCount]} castShadow>
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

function Road({ width, depth, lanes, sidewalk }: { width: number; depth: number; lanes: number; sidewalk: boolean }) {
  const dashes = Math.floor(depth / 9);
  return (
    <group>
      <mesh position={[0, 0.02, 0]} receiveShadow>
        <boxGeometry args={[width, 0.04, depth]} />
        <meshStandardMaterial color="#d3d9f0" />
      </mesh>
      {/* Vạch giữa đứt + 2 vạch mép */}
      {lanes >= 2
        ? Array.from({ length: dashes }).map((_, dashIndex) => (
            <mesh key={dashIndex} position={[0, 0.045, -depth / 2 + 4.5 + dashIndex * 9]}>
              <boxGeometry args={[0.28, 0.01, 3.4]} />
              <meshStandardMaterial color="#ffffff" />
            </mesh>
          ))
        : null}
      {[width / 2 - 0.6, -width / 2 + 0.6].map((x) => (
        <mesh key={x} position={[x, 0.045, 0]}>
          <boxGeometry args={[0.18, 0.01, depth]} />
          <meshStandardMaterial color="#f4f6fd" />
        </mesh>
      ))}
      {sidewalk
        ? [width / 2 + 0.9, -width / 2 - 0.9].map((x) => (
            <mesh key={x} position={[x, 0.1, 0]} receiveShadow>
              <boxGeometry args={[1.8, 0.2, depth]} />
              <meshStandardMaterial color="#f3f5fc" />
            </mesh>
          ))
        : null}
    </group>
  );
}

function Decor({ decorObject }: { decorObject: LayoutIndex['decor'][number] }) {
  const decorProps = (decorObject.props ?? {}) as DecorProps;
  const rot = deg(decorObject.rotY);
  switch (decorProps.kind) {
    case 'tree':
      return (
        <group position={[decorObject.posX, 0, decorObject.posZ]}>
          <TreeModel size={decorProps.size ?? 1} />
        </group>
      );
    case 'bush':
      return (
        <group position={[decorObject.posX, 0, decorObject.posZ]}>
          <BushModel />
        </group>
      );
    case 'container':
      return (
        <group position={[decorObject.posX, 0, decorObject.posZ]} rotation={[0, rot, 0]}>
          <ContainerModel color={decorProps.color ?? '#2bb3a3'} label={decorProps.label ?? null} />
        </group>
      );
    case 'road':
      return (
        <group position={[decorObject.posX, 0, decorObject.posZ]} rotation={[0, rot, 0]}>
          <Road width={decorObject.sizeX} depth={decorObject.sizeZ} lanes={decorProps.lanes ?? 2} sidewalk={decorProps.sidewalk ?? true} />
        </group>
      );
    case 'crosswalk':
      return (
        <group position={[decorObject.posX, 0.05, decorObject.posZ]}>
          {Array.from({ length: Math.floor(Math.max(decorObject.sizeX, decorObject.sizeZ) / 1.4) }).map((_, stripeIndex) => (
            <mesh key={stripeIndex} position={decorObject.sizeX > decorObject.sizeZ ? [-decorObject.sizeX / 2 + 0.7 + stripeIndex * 1.4, 0, 0] : [0, 0, -decorObject.sizeZ / 2 + 0.7 + stripeIndex * 1.4]}>
              <boxGeometry args={decorObject.sizeX > decorObject.sizeZ ? [0.7, 0.01, decorObject.sizeZ] : [decorObject.sizeX, 0.01, 0.7]} />
              <meshStandardMaterial color="#ffffff" />
            </mesh>
          ))}
        </group>
      );
    case 'fence':
      return <Fence x1={decorObject.posX} z1={decorObject.posZ} x2={decorProps.x2 ?? decorObject.posX} z2={decorProps.z2 ?? decorObject.posZ} green={decorProps.green} />;
    case 'pad':
      return (
        <RoundedBox args={[decorObject.sizeX, 0.06, decorObject.sizeZ]} radius={0.03} position={[decorObject.posX, 0.03, decorObject.posZ]} receiveShadow>
          <meshStandardMaterial color={decorProps.color ?? '#dff3e6'} />
        </RoundedBox>
      );
    case 'neighbor':
      return (
        <group position={[decorObject.posX, 0, decorObject.posZ]}>
          <Neighbor width={decorObject.sizeX} depth={decorObject.sizeZ} height={decorObject.sizeY} style={decorProps.style ?? 'office'} />
        </group>
      );
    case 'silo':
      return (
        <group position={[decorObject.posX, 0, decorObject.posZ]}>
          <mesh position={[0, decorObject.sizeY / 2, 0]} castShadow>
            <cylinderGeometry args={[3.2, 3.2, decorObject.sizeY, 28]} />
            <meshStandardMaterial color="#f3f5fa" />
          </mesh>
          <mesh position={[0, decorObject.sizeY, 0]} castShadow>
            <sphereGeometry args={[3.2, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
            <meshStandardMaterial color="#eef1f7" />
          </mesh>
        </group>
      );
    case 'shed':
      return (
        <group position={[decorObject.posX, 0, decorObject.posZ]} rotation={[0, rot, 0]}>
          <RoundedBox args={[decorObject.sizeX, decorObject.sizeY, decorObject.sizeZ]} radius={0.15} position={[0, decorObject.sizeY / 2, 0]} castShadow receiveShadow>
            <meshStandardMaterial color={decorProps.color ?? '#3b6fe0'} />
          </RoundedBox>
          <mesh position={[0, decorObject.sizeY + 0.3, 0]} castShadow>
            <boxGeometry args={[decorObject.sizeX + 0.5, 0.6, decorObject.sizeZ + 0.5]} />
            <meshStandardMaterial color="#2c5bd0" />
          </mesh>
        </group>
      );
    case 'cones':
      return (
        <group position={[decorObject.posX, 0, decorObject.posZ]}>
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
  const byType = (locationType: string) => layout.locations.filter((location) => location.type === locationType);
  const racks = useMemo(() => layout.locations.filter((location) => location.type === 'STORAGE' && location.display === 'rack'), [layout]);
  const floors = useMemo(() => layout.locations.filter((location) => location.display === 'floor'), [layout]);
  const docks = useMemo(() => byType('DOCK'), [layout]); // eslint-disable-line react-hooks/exhaustive-deps
  const yardSlots = useMemo(() => byType('YARD_SLOT'), [layout]); // eslint-disable-line react-hooks/exhaustive-deps
  const parking = useMemo(() => byType('PARKING_SLOT'), [layout]); // eslint-disable-line react-hooks/exhaustive-deps
  const chargers = useMemo(() => byType('CHARGER'), [layout]); // eslint-disable-line react-hooks/exhaustive-deps
  const gates = useMemo(() => byType('GATE_LANE'), [layout]); // eslint-disable-line react-hooks/exhaustive-deps
  const quarantine = useMemo(() => byType('QUARANTINE'), [layout]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <group>
      {layout.zones.map((zone) => {
        const color = ((zone.props ?? {}) as { color?: string }).color;
        if (!color || color === 'transparent') return null;
        return (
          <mesh key={zone.id} position={[zone.posX, 0.006, zone.posZ]} receiveShadow>
            <boxGeometry args={[zone.sizeX, 0.01, zone.sizeZ]} />
            <meshStandardMaterial color={color} />
          </mesh>
        );
      })}
      {layout.decor.map((decorObject) => (
        <Decor key={decorObject.id} decorObject={decorObject} />
      ))}
      {layout.buildings.map((bd) => (
        <Building key={bd.id} layoutObject={bd} />
      ))}
      {/* Bay dock: khung vàng phía trước cửa (mở về phía nhà) */}
      {docks.map((dock) => (
        <LineRect key={dock.id} placement={dock} color={YELLOW} thickness={0.16} open offsetZ={dock.sz / 2 + 0.4} />
      ))}
      {yardSlots.map((yardSlot) => (
        <LineRect key={yardSlot.id} placement={yardSlot} color={YELLOW} />
      ))}
      {floors.map((floorSpot) => (
        <LineRect key={floorSpot.id} placement={floorSpot} color={YELLOW} thickness={0.1} />
      ))}
      {parking.map((parkingSlot) => (
        <LineRect key={parkingSlot.id} placement={parkingSlot} color="#ffffff" thickness={0.08} />
      ))}
      {quarantine.map((quarantineArea) => (
        <mesh key={quarantineArea.id} position={[quarantineArea.x, 0.02, quarantineArea.z]}>
          <boxGeometry args={[quarantineArea.sx, 0.02, quarantineArea.sz]} />
          <meshStandardMaterial color="#fbc4c4" />
        </mesh>
      ))}
      {racks.length > 0 ? <Racks racks={racks} /> : null}
      {chargers.map((charger) => (
        <group
          key={charger.id}
          position={[charger.x, 0, charger.z]}
          rotation={[0, charger.rotY, 0]}
          onClick={(event) => {
            event.stopPropagation();
            if (siteId) useScene.getState().select({ siteId, type: 'charger', id: charger.id });
          }}
        >
          <group position={[0, 0, -charger.sz / 2 - 0.1]}>
            <ChargerModel active />
          </group>
          <Text position={[0, 0.07, 0.4]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.7} color="#166534">
            {charger.code}
          </Text>
        </group>
      ))}
      {gates.map((gate) => (
        <group key={gate.id} position={[gate.x, 0, gate.z]} rotation={[0, gate.rotY, 0]}>
          <RoundedBox args={[1.6, 2.6, 1.6]} radius={0.15} position={[-gate.sx / 2 - 1.2, 1.3, 0]} castShadow>
            <meshStandardMaterial color="#f3f5fb" />
          </RoundedBox>
          <mesh position={[-gate.sx / 2 - 0.3, 0.6, 0]} castShadow>
            <boxGeometry args={[0.35, 1.2, 0.35]} />
            <meshStandardMaterial color="#334155" />
          </mesh>
          <mesh position={[0, 1.05, 0]}>
            <boxGeometry args={[gate.sx, 0.12, 0.12]} />
            <meshStandardMaterial color="#ef4444" />
          </mesh>
        </group>
      ))}
    </group>
  );
});
