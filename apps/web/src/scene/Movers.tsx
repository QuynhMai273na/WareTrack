import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, type ReactNode } from 'react';
import type { Group } from 'three';
import type { TruckTarget, Waypoint } from './motion';
import { registerObject } from './registry';

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Xe chạy theo lộ trình (lane graph — mục 18.9): đổi trạng thái → lập lộ trình từ vị trí đang hiển thị,
 * đi tiến/lùi với hướng đầu xe theo chiều chạy. State lưu trong ref, không ghi ngược (BR-30).
 */
export function PathFollower({ objectKey, target, speed = 7, reverseSpeed = 2.6, onIdle, children }: { objectKey: string; target: TruckTarget; speed?: number; reverseSpeed?: number; onIdle?: () => void; children: ReactNode }) {
  const ref = useRef<Group>(null);
  const queue = useRef<Waypoint[]>([]);
  const heading = useRef(target.rotY);
  const lastKey = useRef<string | null>(null);
  const moving = useRef(false);
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    const g = ref.current;
    if (!g) return;
    if (lastKey.current === null) {
      g.position.set(target.x, 0, target.z);
      heading.current = target.rotY;
      g.rotation.y = target.rotY;
    } else if (lastKey.current !== target.key) {
      const plan = target.plan({ x: g.position.x, z: g.position.z });
      queue.current = plan.length ? plan : [{ x: target.x, z: target.z }];
    } else if (Math.hypot(g.position.x - target.x, g.position.z - target.z) > 0.05) {
      queue.current = [{ x: target.x, z: target.z }];
    }
    lastKey.current = target.key;
    invalidate();
  }, [target, invalidate]);

  useEffect(() => {
    if (ref.current) return registerObject(objectKey, ref.current);
  }, [objectKey]);

  useFrame((_, rawDt) => {
    const g = ref.current;
    if (!g) return;
    const dt = Math.min(rawDt, 0.1);
    const next = queue.current[0];
    if (!next) {
      if (moving.current) {
        moving.current = false;
        onIdle?.();
      }
      // Dừng: xoay dần về hướng đích (đầu xe hướng ra ngoài khi đỗ)
      const diff = wrap(target.rotY - g.rotation.y);
      if (Math.abs(diff) > 0.005 && Math.hypot(g.position.x - target.x, g.position.z - target.z) < 1) {
        g.rotation.y += diff * Math.min(1, dt * 3);
        invalidate();
      }
      return;
    }
    moving.current = true;
    const dx = next.x - g.position.x;
    const dz = next.z - g.position.z;
    const dist = Math.hypot(dx, dz);
    const v = next.reverse ? reverseSpeed : speed;
    if (dist < 0.05) {
      queue.current.shift();
      invalidate();
      return;
    }
    const step = Math.min(dist, v * dt);
    g.position.x += (dx / dist) * step;
    g.position.z += (dz / dist) * step;
    const want = Math.atan2(dx, dz) + (next.reverse ? Math.PI : 0);
    heading.current = heading.current + wrap(want - heading.current) * Math.min(1, dt * (next.reverse ? 2.2 : 4));
    g.rotation.y = heading.current;
    invalidate();
  });

  return (
    <group ref={ref} visible={target.visible}>
      {children}
    </group>
  );
}

/**
 * Xe nâng đang làm việc: đi lại giữa hai điểm (xe tải ↔ khu staging), nửa đường mang pallet.
 * Chu kỳ theo thời gian thực, lệch pha theo mã xe để không trùng nhau.
 */
export function ShuttleMover({ objectKey, a, b, phase, period = 18, render }: { objectKey: string; a: { x: number; z: number }; b: { x: number; z: number }; phase: number; period?: number; render: (carrying: boolean) => ReactNode }) {
  const ref = useRef<Group>(null);
  const carrying = useRef(false);
  const holder = useRef<Group>(null);
  const loaded = useRef<Group>(null);
  const empty = useRef<Group>(null);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (ref.current) return registerObject(objectKey, ref.current);
  }, [objectKey]);
  useFrame(({ clock }) => {
    const g = ref.current;
    if (!g) return;
    const t = ((clock.elapsedTime + phase) % period) / period;
    // 0–0.1 dừng lấy hàng · 0.1–0.45 chở tới B · 0.45–0.55 đặt hàng · 0.55–0.9 quay về · 0.9–1 chờ
    let f: number;
    let dir: 1 | -1 = 1;
    if (t < 0.1) f = 0;
    else if (t < 0.45) f = (t - 0.1) / 0.35;
    else if (t < 0.55) f = 1;
    else if (t < 0.9) {
      f = 1 - (t - 0.55) / 0.35;
      dir = -1;
    } else f = 0;
    const ease = f * f * (3 - 2 * f);
    g.position.set(a.x + (b.x - a.x) * ease, 0, a.z + (b.z - a.z) * ease);
    // Xe nâng chở hàng đi lùi ra khỏi xe tải rồi quay đầu: đơn giản hóa — luôn hướng càng về phía điểm đến
    const heading = Math.atan2(b.x - a.x, b.z - a.z);
    g.rotation.y = dir === 1 ? heading : heading + Math.PI;
    const isCarrying = t >= 0.05 && t < 0.5;
    if (isCarrying !== carrying.current) {
      carrying.current = isCarrying;
      if (loaded.current) loaded.current.visible = isCarrying;
      if (empty.current) empty.current.visible = !isCarrying;
    }
    invalidate();
  });
  return (
    <group ref={ref}>
      <group ref={holder}>
        <group ref={loaded} visible={false}>
          {render(true)}
        </group>
        <group ref={empty}>{render(false)}</group>
      </group>
    </group>
  );
}
