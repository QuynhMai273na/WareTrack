import { RoundedBox, Text } from '@react-three/drei';
import type { LayoutObjectDto } from '@waretrack/shared-schemas';
import { memo, useMemo } from 'react';
import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute } from 'three';
import { PalletModel, useRibbed } from './models';

const NAVY = '#1f3f8f';

type Face = 'S' | 'E' | 'N' | 'W';
interface BuildingStyle {
  roof: 'gable' | 'sawtooth' | 'flat';
  ridge?: 'x' | 'z';
  bays?: number;
  roofColor: string;
  wallColor: string;
  band?: boolean;
  badge?: { u: number; v: number; size: number } | null;
  roofUnits?: Array<[number, number, number]>;
  office?: { face: Face; offset: number; width: number; height: number };
  doors?: Array<{ face: Face; offset: number; open?: boolean; cargo?: boolean; label?: string }>;
  sign?: { face: Face; offset: number; text: string; sub?: string };
  platform?: { face: Face; from: number; to: number; depth: number };
}

const FACE_ROT: Record<Face, number> = { S: 0, E: Math.PI / 2, N: Math.PI, W: -Math.PI / 2 };

/** Vị trí cục bộ (so với tâm nhà) của một điểm trên mặt `face` tại `offset` tính từ góc trái nhìn từ ngoài. */
function facePos(face: Face, offset: number, W: number, D: number): [number, number] {
  switch (face) {
    case 'S':
      return [-W / 2 + offset, D / 2];
    case 'N':
      return [W / 2 - offset, -D / 2];
    case 'E':
      return [W / 2, D / 2 - offset];
    case 'W':
      return [-W / 2, -D / 2 + offset];
  }
}

/** Mái hai dốc một nhịp: hai tấm dốc vân tôn + hai đầu hồi tam giác màu tường. Trục nóc theo X cục bộ. */
function GableBay({ length, span, rise, roofColor, wallColor, ribRepeat }: { length: number; span: number; rise: number; roofColor: string; wallColor: string; ribRepeat: number }) {
  const ribs = useRibbed(ribRepeat, 1);
  const slope = Math.hypot(span / 2, rise);
  const angle = Math.atan2(rise, span / 2);
  const gable = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute([-span / 2, 0, 0, span / 2, 0, 0, 0, rise, 0], 3));
    g.computeVertexNormals();
    return g;
  }, [span, rise]);
  return (
    <group>
      {[1, -1].map((s) => (
        <mesh key={s} position={[0, rise / 2, (s * span) / 4]} rotation={[s * angle, 0, 0]} castShadow receiveShadow>
          <boxGeometry args={[length + 0.6, 0.25, slope + 0.5]} />
          <meshStandardMaterial color={roofColor} map={ribs} roughness={0.55} />
        </mesh>
      ))}
      {[1, -1].map((s) => (
        <mesh key={s} geometry={gable} position={[(s * length) / 2, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
          <meshStandardMaterial color={wallColor} side={DoubleSide} />
        </mesh>
      ))}
      {/* Viền navy trên đầu hồi */}
      {[1, -1].map((s) =>
        [1, -1].map((t) => (
          <mesh key={`${s}${t}`} position={[(s * (length + 0.3)) / 2, rise / 2, (t * span) / 4]} rotation={[t * angle, 0, 0]}>
            <boxGeometry args={[0.3, 0.32, slope + 0.5]} />
            <meshStandardMaterial color={NAVY} />
          </mesh>
        )),
      )}
    </group>
  );
}

/** Cửa trang trí: khung navy, mở thì thấy bên trong tối + pallet carton (video). */
function WallDoor({ open, cargo, label }: { open?: boolean; cargo?: boolean; label?: string }) {
  const doorH = open ? 1.2 : 4.0;
  return (
    <group>
      {[-2.2, 2.2].map((x) => (
        <mesh key={x} position={[x, 2.35, 0.15]} castShadow>
          <boxGeometry args={[0.32, 4.7, 0.36]} />
          <meshStandardMaterial color={NAVY} />
        </mesh>
      ))}
      <mesh position={[0, 4.7, 0.15]}>
        <boxGeometry args={[4.75, 0.32, 0.36]} />
        <meshStandardMaterial color={NAVY} />
      </mesh>
      <mesh position={[0, 2.25, 0.02]}>
        <boxGeometry args={[4.1, 4.4, 0.02]} />
        <meshStandardMaterial color="#5b6684" />
      </mesh>
      <mesh position={[0, 4.5 - doorH / 2, 0.06]}>
        <boxGeometry args={[4.1, doorH, 0.05]} />
        <meshStandardMaterial color="#dde3ef" />
      </mesh>
      {open && cargo ? (
        <group position={[0, 0.7, -0.4]}>
          <PalletModel scale={1.2} tiers={2} />
        </group>
      ) : null}
      {label ? (
        <group position={[-1.6, 5.35, 0.25]}>
          <RoundedBox args={[0.9, 0.7, 0.08]} radius={0.08}>
            <meshStandardMaterial color="#2f6fe4" />
          </RoundedBox>
          <Text position={[0, 0, 0.06]} fontSize={0.38} fontWeight={700} color="#ffffff">
            {label}
          </Text>
        </group>
      ) : null}
    </group>
  );
}

/** Cụm máy lạnh trên mái phẳng (video kho lạnh: hộp trắng 2–3 quạt). */
function RoofUnit({ fans }: { fans: number }) {
  const w = 1.6 * fans + 0.6;
  return (
    <group>
      <RoundedBox args={[w, 0.9, 2]} radius={0.12} position={[0, 0.45, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#f1f4fa" />
      </RoundedBox>
      {Array.from({ length: fans }).map((_, i) => (
        <group key={i} position={[-w / 2 + 1.1 + i * 1.6, 0.92, 0]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[0.62, 24]} />
            <meshStandardMaterial color="#9aa5ba" />
          </mesh>
          <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.18, 0.5, 20]} />
            <meshStandardMaterial color="#5f6a82" />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function Badge({ size, label }: { size: number; label: string }) {
  return (
    <group>
      <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[size, 40]} />
        <meshStandardMaterial color="#ffffff" />
      </mesh>
      <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[size * 0.84, size * 0.92, 40]} />
        <meshStandardMaterial color={NAVY} />
      </mesh>
      <mesh position={[0, 0.35, -size * 0.12]} rotation={[0, Math.PI / 6, 0]} castShadow>
        <cylinderGeometry args={[size * 0.36, size * 0.36, 0.6, 6]} />
        <meshStandardMaterial color="#2f6fe4" />
      </mesh>
      {label ? (
        <Text position={[0, 0.07, size * 0.55]} rotation={[-Math.PI / 2, 0, 0]} fontSize={size * 0.24} fontWeight={700} color={NAVY} anchorX="center" anchorY="middle">
          {label}
        </Text>
      ) : null}
    </group>
  );
}

/** Nhà kho theo style của layout (mục 18.1): mái hai dốc nhiều nhịp / răng cưa / mái phẳng. */
export const Building = memo(function Building({ o }: { o: LayoutObjectDto }) {
  const props = (o.props ?? {}) as { label?: string; roofColor?: string; wallColor?: string; style?: BuildingStyle | null };
  const style: BuildingStyle = props.style ?? { roof: 'gable', ridge: 'x', bays: 1, roofColor: props.roofColor ?? '#2f6fe4', wallColor: props.wallColor ?? '#eef2fb', badge: { u: 0.5, v: 0.5, size: 3 } };
  const W = o.sizeX;
  const D = o.sizeZ;
  const H = o.sizeY;
  const wallX = useRibbed(W / 0.9, 1);
  const wallZ = useRibbed(D / 0.9, 1);
  const flat = style.roof === 'flat';
  const ridge = style.ridge ?? 'x';
  const bays = style.bays ?? 1;
  const code = (props.label ?? '').split(' ')[0];
  const wall = style.wallColor;
  const roofLight = useMemo(() => new Color(style.roofColor).lerp(new Color('#ffffff'), 0.06).getStyle(), [style.roofColor]);

  // Mái hai dốc: chia nhịp theo phương vuông góc với nóc
  const spanTotal = ridge === 'x' ? D : W;
  const length = ridge === 'x' ? W : D;
  const span = spanTotal / bays;
  const rise = Math.min(3.2, span * 0.15);
  return (
    <group position={[o.posX, 0, o.posZ]}>
      {/* Thân nhà + 4 mặt tường vân tôn */}
      <mesh position={[0, H / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[W, H, D]} />
        <meshStandardMaterial color={wall} roughness={0.7} />
      </mesh>
      {(['S', 'N'] as const).map((f) => (
        <mesh key={f} position={[0, H / 2, (f === 'S' ? 1 : -1) * (D / 2 + 0.005)]} rotation={[0, f === 'S' ? 0 : Math.PI, 0]} receiveShadow>
          <planeGeometry args={[W, H]} />
          <meshStandardMaterial color={wall} map={flat ? null : wallX} roughness={0.7} />
        </mesh>
      ))}
      {(['E', 'W'] as const).map((f) => (
        <mesh key={f} position={[(f === 'E' ? 1 : -1) * (W / 2 + 0.005), H / 2, 0]} rotation={[0, f === 'E' ? Math.PI / 2 : -Math.PI / 2, 0]} receiveShadow>
          <planeGeometry args={[D, H]} />
          <meshStandardMaterial color={wall} map={flat ? null : wallZ} roughness={0.7} />
        </mesh>
      ))}
      {/* Cột góc navy + chân tường */}
      {[-W / 2, W / 2].map((x) =>
        [-D / 2, D / 2].map((z) => (
          <mesh key={`${x}${z}`} position={[x, H / 2, z]} castShadow>
            <boxGeometry args={[0.45, H + 0.05, 0.45]} />
            <meshStandardMaterial color={NAVY} />
          </mesh>
        )),
      )}
      {style.band ? (
        <>
          <mesh position={[0, H - 0.5, D / 2 + 0.03]}>
            <boxGeometry args={[W + 0.1, 0.55, 0.06]} />
            <meshStandardMaterial color={NAVY} />
          </mesh>
          <mesh position={[W / 2 + 0.03, H - 0.5, 0]}>
            <boxGeometry args={[0.06, 0.55, D + 0.1]} />
            <meshStandardMaterial color={NAVY} />
          </mesh>
        </>
      ) : (
        <mesh position={[0, H - 0.2, D / 2 + 0.04]}>
          <boxGeometry args={[W + 0.3, 0.4, 0.08]} />
          <meshStandardMaterial color={NAVY} />
        </mesh>
      )}

      {/* Mái */}
      {flat ? (
        <group position={[0, H, 0]}>
          <mesh position={[0, 0.05, 0]} receiveShadow>
            <boxGeometry args={[W, 0.1, D]} />
            <meshStandardMaterial color="#f7f8fc" />
          </mesh>
          {/* Lan can */}
          {[
            [0, D / 2, W, 0.3],
            [0, -D / 2, W, 0.3],
          ].map(([x, z, w, d], i) => (
            <mesh key={i} position={[x, 0.45, z]} castShadow>
              <boxGeometry args={[w + 0.3, 0.9, d]} />
              <meshStandardMaterial color="#eef1f8" />
            </mesh>
          ))}
          {[W / 2, -W / 2].map((x) => (
            <mesh key={x} position={[x, 0.45, 0]} castShadow>
              <boxGeometry args={[0.3, 0.9, D]} />
              <meshStandardMaterial color="#eef1f8" />
            </mesh>
          ))}
          {(style.roofUnits ?? []).map(([u, v, fans], i) => (
            <group key={i} position={[-W / 2 + u * W, 0.1, -D / 2 + v * D]}>
              <RoofUnit fans={fans} />
            </group>
          ))}
          {style.badge ? (
            <group position={[-W / 2 + style.badge.u * W, 0.12, -D / 2 + style.badge.v * D]}>
              <mesh position={[0, 0.25, 0]} rotation={[0, Math.PI / 6, 0]} castShadow>
                <cylinderGeometry args={[style.badge.size * 0.6, style.badge.size * 0.6, 0.5, 6]} />
                <meshStandardMaterial color="#2f6fe4" />
              </mesh>
            </group>
          ) : null}
        </group>
      ) : (
        <group position={[0, H, 0]} rotation={[0, ridge === 'x' ? 0 : Math.PI / 2, 0]}>
          {Array.from({ length: bays }).map((_, i) => (
            <group key={i} position={[0, 0, -spanTotal / 2 + span * (i + 0.5)]}>
              <GableBay length={length} span={span} rise={rise} roofColor={i % 2 === 0 ? style.roofColor : roofLight} wallColor={wall} ribRepeat={length / 1.1} />
            </group>
          ))}
          {/* Máng xối giữa các nhịp */}
          {Array.from({ length: bays - 1 }).map((_, i) => (
            <mesh key={i} position={[0, 0.05, -spanTotal / 2 + span * (i + 1)]}>
              <boxGeometry args={[length + 0.6, 0.18, 0.5]} />
              <meshStandardMaterial color="#1f3f8f" />
            </mesh>
          ))}
        </group>
      )}
      {/* Huy hiệu trên mái dốc phía nam (nhịp cuối) */}
      {!flat && style.badge ? (
        <group
          position={
            ridge === 'x'
              ? [-W / 2 + style.badge.u * W, H + rise * 0.5 + 0.2, D / 2 - span * 0.25]
              : [W / 2 - span * 0.25, H + rise * 0.5 + 0.2, -D / 2 + style.badge.v * D]
          }
          rotation={ridge === 'x' ? [Math.atan2(rise, span / 2), 0, 0] : [0, 0, -Math.atan2(rise, span / 2)]}
        >
          <Badge size={style.badge.size} label={code} />
        </group>
      ) : null}

      {/* Cửa trang trí */}
      {(style.doors ?? []).map((d, i) => {
        const [x, z] = facePos(d.face, d.offset, W, D);
        return (
          <group key={i} position={[x, 0, z]} rotation={[0, FACE_ROT[d.face], 0]}>
            <WallDoor open={d.open} cargo={d.cargo} label={d.label} />
          </group>
        );
      })}
      {/* Khối văn phòng kính */}
      {style.office
        ? (() => {
            const of = style.office;
            const [x, z] = facePos(of.face, of.offset + of.width / 2, W, D);
            return (
              <group position={[x, 0, z]} rotation={[0, FACE_ROT[of.face], 0]}>
                <mesh position={[0, of.height / 2, 0.8]} castShadow>
                  <boxGeometry args={[of.width, of.height, 1.6]} />
                  <meshStandardMaterial color="#3d6fd9" metalness={0.3} roughness={0.15} />
                </mesh>
                {Array.from({ length: Math.floor(of.width / 1.5) + 1 }).map((_, i) => (
                  <mesh key={i} position={[-of.width / 2 + i * 1.5, of.height / 2, 1.61]}>
                    <boxGeometry args={[0.08, of.height, 0.02]} />
                    <meshStandardMaterial color="#c7d6f5" />
                  </mesh>
                ))}
                {Array.from({ length: Math.floor(of.height / 1.6) }).map((_, i) => (
                  <mesh key={`h${i}`} position={[0, 1.6 * (i + 1), 1.61]}>
                    <boxGeometry args={[of.width, 0.08, 0.02]} />
                    <meshStandardMaterial color="#c7d6f5" />
                  </mesh>
                ))}
              </group>
            );
          })()
        : null}
      {/* Sàn dock nâng viền vàng (kho lạnh) */}
      {style.platform
        ? (() => {
            const pf = style.platform;
            const len = pf.to - pf.from;
            const [x, z] = facePos(pf.face, pf.from + len / 2, W, D);
            return (
              <group position={[x, 0, z]} rotation={[0, FACE_ROT[pf.face], 0]}>
                <mesh position={[0, 0.6, pf.depth / 2]} castShadow receiveShadow>
                  <boxGeometry args={[len, 1.2, pf.depth]} />
                  <meshStandardMaterial color="#e9edf6" />
                </mesh>
                <mesh position={[0, 1.22, pf.depth - 0.15]}>
                  <boxGeometry args={[len, 0.05, 0.3]} />
                  <meshStandardMaterial color="#f2b705" />
                </mesh>
                <mesh position={[len / 2 - 0.15, 1.22, pf.depth / 2]}>
                  <boxGeometry args={[0.3, 0.05, pf.depth]} />
                  <meshStandardMaterial color="#f2b705" />
                </mesh>
              </group>
            );
          })()
        : null}
      {/* Biển tên trên tường */}
      {style.sign
        ? (() => {
            const sg = style.sign;
            const [x, z] = facePos(sg.face, sg.offset, W, D);
            return (
              <group position={[x, H - 2.2, z]} rotation={[0, FACE_ROT[sg.face], 0]}>
                <RoundedBox args={[7.4, 2, 0.1]} radius={0.15} position={[1.6, 0, 0.1]}>
                  <meshStandardMaterial color="#ffffff" />
                </RoundedBox>
                <RoundedBox args={[1.2, 1.2, 0.1]} radius={0.15} position={[-1.4, 0, 0.18]}>
                  <meshStandardMaterial color="#2f6fe4" />
                </RoundedBox>
                <Text position={[-0.5, 0.25, 0.2]} fontSize={0.62} fontWeight={700} color={NAVY} anchorX="left" anchorY="middle">
                  {sg.text}
                </Text>
                {sg.sub ? (
                  <Text position={[-0.5, -0.4, 0.2]} fontSize={0.34} color="#3b5bb5" anchorX="left" anchorY="middle">
                    {sg.sub}
                  </Text>
                ) : null}
              </group>
            );
          })()
        : null}
    </group>
  );
});
