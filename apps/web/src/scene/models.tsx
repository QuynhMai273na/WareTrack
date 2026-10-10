import { RoundedBox, Text } from '@react-three/drei';
import { memo, useMemo } from 'react';
import { BoxGeometry, BufferAttribute, type BufferGeometry, CanvasTexture, Color, RepeatWrapping, SRGBColorSpace } from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Asset low-poly dựng bằng geometry thủ tục (DEC-56): khối bo góc + chi tiết nhỏ để gần với phong cách video
 * (xe tải có cabin/kính/lưới tản nhiệt, xe nâng có người lái, pallet có thanh gỗ và thùng carton dán băng keo).
 * Kích thước giữ nguyên footprint cũ để placement không đổi; có thể thay bằng GLB Blender cùng kích thước.
 */

const CARRIER_COLORS: Record<string, { cab: string; stripe: string; text: string; brand: string }> = {
  'WareTrack Freight': { cab: '#2f6fe4', stripe: '#2f6fe4', text: '#2f6fe4', brand: 'WareTrack' },
  'Bluepeak Foods': { cab: '#f8fafc', stripe: '#1e3a8a', text: '#1e3a8a', brand: 'Bluepeak' },
  'Nordline Logistics': { cab: '#f8fafc', stripe: '#14b8a6', text: '#0f766e', brand: 'Nordline' },
  Cargoviva: { cab: '#f8fafc', stripe: '#f97316', text: '#ea580c', brand: 'Cargoviva' },
  'Marlin Line': { cab: '#0f766e', stripe: '#2dd4bf', text: '#0f766e', brand: 'Marlin' },
};

const GLASS = '#1f2a44';
const TIRE = '#1b1f2a';
const HUB = '#cbd5e1';

/** Vân tôn (corrugated) cho tường/mái/container — một texture dùng chung, nhân bản theo kích thước. */
let ribTexture: CanvasTexture | null = null;
export function corrugatedTexture(): CanvasTexture {
  if (ribTexture) return ribTexture;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 8;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.45, '#ffffff');
  grad.addColorStop(0.6, '#c9d0e2');
  grad.addColorStop(0.8, '#e6eaf4');
  grad.addColorStop(1, '#ffffff');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 8);
  ribTexture = new CanvasTexture(c);
  ribTexture.wrapS = RepeatWrapping;
  ribTexture.wrapT = RepeatWrapping;
  ribTexture.colorSpace = SRGBColorSpace;
  ribTexture.anisotropy = 4;
  return ribTexture;
}

export function useRibbed(repeatX: number, repeatY = 1) {
  return useMemo(() => {
    const t = corrugatedTexture().clone();
    t.repeat.set(repeatX, repeatY);
    t.needsUpdate = true;
    return t;
  }, [repeatX, repeatY]);
}

function Wheel({ x, z, r = 0.5, w = 0.42 }: { x: number; z: number; r?: number; w?: number }) {
  return (
    <group position={[x, r, z]} rotation={[0, 0, Math.PI / 2]}>
      <mesh castShadow>
        <cylinderGeometry args={[r, r, w, 18]} />
        <meshStandardMaterial color={TIRE} roughness={0.9} />
      </mesh>
      <mesh position={[0, (Math.sign(x) * w) / 2 + Math.sign(x) * 0.01, 0]}>
        <cylinderGeometry args={[r * 0.5, r * 0.5, 0.02, 14]} />
        <meshStandardMaterial color={HUB} metalness={0.4} roughness={0.4} />
      </mesh>
    </group>
  );
}

/** Xe tải hộp: dài theo trục Z, cabin ở phía +Z (footprint ~15 m). */
export const TruckModel = memo(function TruckModel({ carrier, opacity = 1, type }: { carrier: string | null; opacity?: number; type: string }) {
  const c = CARRIER_COLORS[carrier ?? ''] ?? { cab: '#2f6fe4', stripe: '#2f6fe4', text: '#2f6fe4', brand: carrier?.split(' ')[0] ?? 'WareTrack' };
  const transparent = opacity < 1;
  const mat = { transparent, opacity };
  const trailer = type === 'REEFER' ? '#f4f7fb' : '#ffffff';
  const cabDark = useMemo(() => new Color(c.cab).multiplyScalar(0.82).getStyle(), [c.cab]);
  return (
    <group>
      {/* Thùng hàng bo góc + dải màu hãng + logo */}
      <RoundedBox args={[2.55, 3.1, 11]} radius={0.12} smoothness={3} position={[0, 2.45, -1.6]} castShadow receiveShadow>
        <meshStandardMaterial color={trailer} roughness={0.55} {...mat} />
      </RoundedBox>
      {/* Xe mờ (vị trí ước lượng) chỉ vẽ chữ một bên để không thấy chữ ngược xuyên qua thùng */}
      {(transparent ? [1] : [1, -1]).map((s) => (
        <group key={s}>
          <mesh position={[s * 1.285, 1.35, -1.6]}>
            <boxGeometry args={[0.02, 0.42, 10.8]} />
            <meshStandardMaterial color={c.stripe} {...mat} />
          </mesh>
          <Text position={[s * 1.3, 2.7, -1.2]} rotation={[0, (s * Math.PI) / 2, 0]} fontSize={0.95} fontWeight={700} color={c.text} anchorX="center" anchorY="middle">
            {c.brand}
          </Text>
        </group>
      ))}
      {type === 'REEFER' ? (
        <RoundedBox args={[1.8, 1.2, 0.5]} radius={0.08} position={[0, 3.3, 4.05]} castShadow>
          <meshStandardMaterial color="#e2e8f0" {...mat} />
        </RoundedBox>
      ) : null}
      {/* Cửa sau */}
      <mesh position={[0, 2.45, -7.12]}>
        <boxGeometry args={[2.3, 2.9, 0.04]} />
        <meshStandardMaterial color="#e5e9f2" {...mat} />
      </mesh>
      {/* Khung gầm */}
      <mesh position={[0, 0.78, 0.4]} castShadow>
        <boxGeometry args={[1.9, 0.32, 13.4]} />
        <meshStandardMaterial color="#2b3446" {...mat} />
      </mesh>
      {/* Cabin */}
      <group position={[0, 0, 5.35]}>
        <RoundedBox args={[2.5, 2.2, 2.3]} radius={0.22} smoothness={4} position={[0, 2.05, 0]} castShadow>
          <meshStandardMaterial color={c.cab} roughness={0.4} {...mat} />
        </RoundedBox>
        <RoundedBox args={[2.5, 0.9, 2.5]} radius={0.15} position={[0, 0.95, 0.08]} castShadow>
          <meshStandardMaterial color={cabDark} roughness={0.5} {...mat} />
        </RoundedBox>
        {/* Kính chắn gió + kính bên */}
        <mesh position={[0, 2.35, 1.16]}>
          <boxGeometry args={[2.2, 1.0, 0.04]} />
          <meshStandardMaterial color={GLASS} metalness={0.3} roughness={0.15} {...mat} />
        </mesh>
        {[1, -1].map((s) => (
          <mesh key={s} position={[s * 1.26, 2.4, 0.35]}>
            <boxGeometry args={[0.03, 0.8, 1.1]} />
            <meshStandardMaterial color={GLASS} metalness={0.3} roughness={0.15} {...mat} />
          </mesh>
        ))}
        {/* Lưới tản nhiệt, đèn, cản */}
        <mesh position={[0, 1.15, 1.34]}>
          <boxGeometry args={[1.3, 0.55, 0.04]} />
          <meshStandardMaterial color="#334155" {...mat} />
        </mesh>
        {[0.95, -0.95].map((x) => (
          <mesh key={x} position={[x, 1.1, 1.35]}>
            <boxGeometry args={[0.38, 0.2, 0.04]} />
            <meshStandardMaterial color="#fef9c3" emissive="#fde68a" emissiveIntensity={0.4} {...mat} />
          </mesh>
        ))}
        <RoundedBox args={[2.6, 0.32, 0.3]} radius={0.08} position={[0, 0.55, 1.3]}>
          <meshStandardMaterial color="#cbd5e1" metalness={0.3} roughness={0.4} {...mat} />
        </RoundedBox>
        {/* Gương */}
        {[1.42, -1.42].map((x) => (
          <mesh key={x} position={[x, 2.4, 0.9]}>
            <boxGeometry args={[0.08, 0.45, 0.14]} />
            <meshStandardMaterial color="#1f2937" {...mat} />
          </mesh>
        ))}
      </group>
      {/* Bánh xe: trục trước + 2 trục sau đầu kéo + 2 trục rơ-moóc */}
      {[5.6, 3.3, 2.2, -5.0, -6.1].map((z) => (
        <group key={z}>
          <Wheel x={1.08} z={z} />
          <Wheel x={-1.08} z={z} />
        </group>
      ))}
    </group>
  );
});

/** Xe nâng: thân vàng bo góc, đối trọng, khung bảo vệ, người lái, cột nâng 2 ray, càng; mặt trước hướng +Z. */
export const ForkliftModel = memo(function ForkliftModel({ dim, carrying }: { dim?: boolean; carrying?: boolean }) {
  const body = dim ? '#cbd5e1' : '#f5b400';
  const dark = '#262d3b';
  return (
    <group>
      <RoundedBox args={[1.25, 0.85, 1.95]} radius={0.14} smoothness={3} position={[0, 0.72, 0]} castShadow>
        <meshStandardMaterial color={body} roughness={0.45} />
      </RoundedBox>
      {/* Đối trọng phía sau */}
      <RoundedBox args={[1.3, 0.95, 0.55]} radius={0.16} position={[0, 0.82, -0.9]} castShadow>
        <meshStandardMaterial color={dark} roughness={0.6} />
      </RoundedBox>
      {/* Ghế + người lái (áo cam phản quang, mũ trắng) */}
      <mesh position={[0, 1.35, -0.35]}>
        <boxGeometry args={[0.55, 0.3, 0.5]} />
        <meshStandardMaterial color="#1f2937" />
      </mesh>
      <RoundedBox args={[0.5, 0.6, 0.36]} radius={0.12} position={[0, 1.75, -0.25]} castShadow>
        <meshStandardMaterial color="#f97316" />
      </RoundedBox>
      <mesh position={[0, 2.2, -0.22]} castShadow>
        <sphereGeometry args={[0.17, 14, 12]} />
        <meshStandardMaterial color="#f2c7a5" />
      </mesh>
      <mesh position={[0, 2.33, -0.22]}>
        <sphereGeometry args={[0.18, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color="#f8fafc" />
      </mesh>
      {/* Khung bảo vệ 4 cột + mái lưới */}
      {[-0.55, 0.55].map((x) =>
        [-0.75, 0.45].map((z) => (
          <mesh key={`${x}${z}`} position={[x, 1.85, z]} castShadow>
            <boxGeometry args={[0.07, 1.4, 0.07]} />
            <meshStandardMaterial color={dark} />
          </mesh>
        )),
      )}
      <mesh position={[0, 2.57, -0.15]} castShadow>
        <boxGeometry args={[1.2, 0.07, 1.35]} />
        <meshStandardMaterial color={dark} />
      </mesh>
      {/* Cột nâng 2 ray + thanh ngang + giá càng */}
      {[-0.36, 0.36].map((x) => (
        <mesh key={x} position={[x, 1.55, 1.08]} castShadow>
          <boxGeometry args={[0.12, 2.9, 0.14]} />
          <meshStandardMaterial color="#3b4252" />
        </mesh>
      ))}
      {[0.6, 1.7, 2.9].map((y) => (
        <mesh key={y} position={[0, y, 1.08]}>
          <boxGeometry args={[0.84, 0.08, 0.1]} />
          <meshStandardMaterial color="#3b4252" />
        </mesh>
      ))}
      <mesh position={[0, 0.5, 1.22]}>
        <boxGeometry args={[0.95, 0.5, 0.06]} />
        <meshStandardMaterial color="#4b5563" />
      </mesh>
      {[-0.3, 0.3].map((x) => (
        <mesh key={x} position={[x, 0.24, 1.8]} castShadow>
          <boxGeometry args={[0.12, 0.05, 1.15]} />
          <meshStandardMaterial color="#6b7280" metalness={0.4} roughness={0.4} />
        </mesh>
      ))}
      {carrying ? <PalletModel position={[0, 0.27, 1.8]} scale={0.85} /> : null}
      <Wheel x={0.6} z={0.6} r={0.32} w={0.24} />
      <Wheel x={-0.6} z={0.6} r={0.32} w={0.24} />
      <Wheel x={0.58} z={-0.7} r={0.27} w={0.22} />
      <Wheel x={-0.58} z={-0.7} r={0.27} w={0.22} />
    </group>
  );
});

/** Gộp nhiều khối thành 1 geometry có màu theo đỉnh — 1 draw call / pallet (mục 18.11). */
const palletGeoCache = new Map<string, BufferGeometry>();
function coloredBox(w: number, h: number, d: number, x: number, y: number, z: number, color: string, rounded = 0): BufferGeometry {
  const base = rounded > 0 ? new RoundedBoxGeometry(w, h, d, 2, rounded) : new BoxGeometry(w, h, d);
  const g = base.index ? base.toNonIndexed() : base;
  g.translate(x, y, z);
  const c = new Color(color);
  const n = g.getAttribute('position').count;
  const cols = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    cols[i * 3] = c.r;
    cols[i * 3 + 1] = c.g;
    cols[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new BufferAttribute(cols, 3));
  g.deleteAttribute('uv');
  return g;
}

function palletGeometry(boxColor: string, tiers: number): BufferGeometry {
  const key = `${boxColor}:${tiers}`;
  const hit = palletGeoCache.get(key);
  if (hit) return hit;
  const parts: BufferGeometry[] = [];
  for (const x of [-0.5, 0, 0.5]) parts.push(coloredBox(0.14, 0.12, 1.0, x, 0.06, 0, '#a8794a'));
  for (const z of [-0.42, -0.21, 0, 0.21, 0.42]) parts.push(coloredBox(1.2, 0.04, 0.15, 0, 0.14, z, '#c4935f'));
  if (boxColor === '#3b6fe0') {
    parts.push(coloredBox(1.14, 0.5 * tiers + 0.02, 0.96, 0, 0.17 + (0.5 * tiers) / 2, 0, boxColor, 0.06));
    for (let t = 0; t < tiers; t++) parts.push(coloredBox(1.16, 0.04, 0.98, 0, 0.42 + t * 0.5, 0, '#5d88ea'));
  } else {
    const tape = new Color(boxColor).lerp(new Color('#ffffff'), 0.35).getStyle();
    const shade = new Color(boxColor).multiplyScalar(0.9).getStyle();
    for (let t = 0; t < tiers; t++)
      for (const x of [-0.29, 0.29])
        for (const z of [-0.24, 0.24]) {
          parts.push(coloredBox(0.55, 0.48, 0.46, x, 0.42 + t * 0.5, z, (t + (x > 0 ? 1 : 0)) % 2 ? shade : boxColor, 0.03));
          parts.push(coloredBox(0.1, 0.006, 0.47, x, 0.42 + t * 0.5 + 0.243, z, tape));
        }
  }
  const merged = mergeGeometries(parts, false)!;
  merged.computeVertexNormals();
  palletGeoCache.set(key, merged);
  return merged;
}

/** Pallet gỗ (3 thanh đế + ván mặt) + thùng carton dán băng keo; tone xanh = hàng quấn màng (video). */
export const PalletModel = memo(function PalletModel({
  position = [0, 0, 0],
  scale = 1,
  boxColor = '#d9a86c',
  tiers = 2,
}: {
  position?: [number, number, number];
  scale?: number;
  boxColor?: string;
  tiers?: number;
  opacity?: number;
}) {
  const geo = useMemo(() => palletGeometry(boxColor, tiers), [boxColor, tiers]);
  return (
    <mesh geometry={geo} position={position} scale={scale} castShadow receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.8} />
    </mesh>
  );
});

/** Cây hai tầng tán (video: cây tròn xanh mint). */
export const TreeModel = memo(function TreeModel({ size = 1 }: { size?: number }) {
  return (
    <group scale={size}>
      <mesh position={[0, 1.1, 0]} castShadow>
        <cylinderGeometry args={[0.16, 0.22, 2.2, 8]} />
        <meshStandardMaterial color="#8a6a4a" />
      </mesh>
      <mesh position={[0, 3.2, 0]} castShadow>
        <sphereGeometry args={[1.45, 18, 14]} />
        <meshStandardMaterial color="#6cc58a" roughness={0.8} />
      </mesh>
      <mesh position={[0.35, 4.15, -0.15]} castShadow>
        <sphereGeometry args={[0.95, 16, 12]} />
        <meshStandardMaterial color="#82d39d" roughness={0.8} />
      </mesh>
    </group>
  );
});

export const BushModel = memo(function BushModel() {
  return (
    <mesh position={[0, 0.45, 0]} castShadow scale={[1.3, 0.75, 1]}>
      <sphereGeometry args={[0.8, 14, 10]} />
      <meshStandardMaterial color="#79cf96" roughness={0.85} />
    </mesh>
  );
});

/** Container 40ft có vân tôn + chữ hãng. */
export const ContainerModel = memo(function ContainerModel({ color, label }: { color: string; label: string | null }) {
  const ribs = useRibbed(28, 1);
  return (
    <group>
      <RoundedBox args={[2.5, 2.6, 12]} radius={0.08} position={[0, 1.3, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={color} map={ribs} roughness={0.6} />
      </RoundedBox>
      {label
        ? [1, -1].map((s) => (
            <Text key={s} position={[s * 1.27, 1.55, 0]} rotation={[0, (s * Math.PI) / 2, 0]} fontSize={0.85} fontWeight={700} color="#ffffff" anchorX="center">
              {label}
            </Text>
          ))
        : null}
    </group>
  );
});

/** Trạm sạc xe nâng: tủ trắng có đèn xanh (video: dãy tủ sạc cạnh xe nâng). */
export const ChargerModel = memo(function ChargerModel({ active }: { active?: boolean }) {
  return (
    <group>
      <RoundedBox args={[0.8, 1.4, 0.6]} radius={0.08} position={[0, 0.7, 0]} castShadow>
        <meshStandardMaterial color="#f8fafc" roughness={0.4} />
      </RoundedBox>
      <mesh position={[0, 1.05, 0.31]}>
        <boxGeometry args={[0.36, 0.08, 0.02]} />
        <meshStandardMaterial color="#22c55e" emissive="#22c55e" emissiveIntensity={active ? 1.2 : 0.5} />
      </mesh>
    </group>
  );
});

/** Ghim định vị (video: pin xanh trên pallet / dock đang chú ý). */
export const MapPin = memo(function MapPin({ color = '#2f6fe4', scale = 1 }: { color?: string; scale?: number }) {
  return (
    <group scale={scale}>
      <mesh position={[0, 0.9, 0]} rotation={[Math.PI, 0, 0]} castShadow>
        <coneGeometry args={[0.42, 1.4, 20]} />
        <meshStandardMaterial color={color} roughness={0.35} />
      </mesh>
      <mesh position={[0, 1.75, 0]} castShadow>
        <sphereGeometry args={[0.62, 22, 18]} />
        <meshStandardMaterial color={color} roughness={0.35} />
      </mesh>
      <mesh position={[0, 1.78, 0.42]}>
        <sphereGeometry args={[0.26, 16, 12]} />
        <meshStandardMaterial color="#ffffff" />
      </mesh>
    </group>
  );
});

/** Ô tô lưu bãi (sedan/SUV low-poly). */
export const CarModel = memo(function CarModel({ color }: { color: string }) {
  return (
    <group>
      <RoundedBox args={[1.8, 0.62, 4.3]} radius={0.22} smoothness={3} position={[0, 0.62, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={color} roughness={0.35} metalness={0.15} />
      </RoundedBox>
      <RoundedBox args={[1.6, 0.55, 2.2]} radius={0.2} smoothness={3} position={[0, 1.15, -0.25]} castShadow>
        <meshStandardMaterial color={color} roughness={0.35} metalness={0.15} />
      </RoundedBox>
      <mesh position={[0, 1.17, -0.25]}>
        <boxGeometry args={[1.62, 0.36, 2.0]} />
        <meshStandardMaterial color={GLASS} metalness={0.3} roughness={0.15} />
      </mesh>
      {[1.35, -1.35].map((z) => (
        <group key={z}>
          <Wheel x={0.82} z={z} r={0.34} w={0.2} />
          <Wheel x={-0.82} z={z} r={0.34} w={0.2} />
        </group>
      ))}
    </group>
  );
});
