import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, type ReactNode } from 'react';
import type { Group } from 'three';
import type { TruckTarget, Waypoint } from './motion';
import { registerObject } from './registry';

const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

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
  /** Vừa xuất hiện ở ngoài bản đồ: chạy nhanh hơn cho tới khi bắt kịp vị trí nghiệp vụ. */
  const catchingUp = useRef(false);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    const group = ref.current;
    if (!group) return;
    if (lastKey.current === null && target.spawn) {
      group.position.set(target.spawn.x, 0, target.spawn.z);
      heading.current = target.spawn.rotY;
      group.rotation.y = target.spawn.rotY;
      const plan = target.plan(target.spawn);
      queue.current = plan.length ? plan : [{ x: target.x, z: target.z }];
      catchingUp.current = true;
    } else if (lastKey.current === null) {
      group.position.set(target.x, 0, target.z);
      heading.current = target.rotY;
      group.rotation.y = target.rotY;
    } else if (lastKey.current !== target.key) {
      const plan = target.plan({ x: group.position.x, z: group.position.z });
      queue.current = plan.length ? plan : [{ x: target.x, z: target.z }];
    } else if (Math.hypot(group.position.x - target.x, group.position.z - target.z) > 0.05) {
      queue.current = [{ x: target.x, z: target.z }];
    }
    lastKey.current = target.key;
    invalidate();
  }, [target, invalidate]);

  useEffect(() => {
    if (ref.current) return registerObject(objectKey, ref.current);
  }, [objectKey]);

  useFrame((_, rawDt) => {
    const group = ref.current;
    if (!group) return;
    const dt = Math.min(rawDt, 0.1);
    const next = queue.current[0];
    if (!next) {
      catchingUp.current = false;
      if (moving.current) {
        moving.current = false;
        onIdle?.();
      }
      // Dừng: xoay dần về hướng đích (đầu xe hướng ra ngoài khi đỗ)
      const diff = wrap(target.rotY - group.rotation.y);
      if (Math.abs(diff) > 0.005 && Math.hypot(group.position.x - target.x, group.position.z - target.z) < 1) {
        group.rotation.y += diff * Math.min(1, dt * 3);
        invalidate();
      }
      return;
    }
    moving.current = true;
    const dx = next.x - group.position.x;
    const dz = next.z - group.position.z;
    const dist = Math.hypot(dx, dz);
    let travelSpeed = next.reverse ? reverseSpeed : speed;
    if (catchingUp.current && !next.reverse) {
      // Còn xa đích thì chạy nhanh (tối đa ×3), tới gần thì về tốc độ thường
      let remaining = dist;
      for (let waypointIndex = 1; waypointIndex < queue.current.length; waypointIndex++) remaining += Math.hypot(queue.current[waypointIndex].x - queue.current[waypointIndex - 1].x, queue.current[waypointIndex].z - queue.current[waypointIndex - 1].z);
      travelSpeed = Math.max(speed, Math.min(speed * 3, (speed * remaining) / 40));
    }
    if (dist < 0.05) {
      queue.current.shift();
      invalidate();
      return;
    }
    const step = Math.min(dist, travelSpeed * dt);
    group.position.x += (dx / dist) * step;
    group.position.z += (dz / dist) * step;
    const want = Math.atan2(dx, dz) + (next.reverse ? Math.PI : 0);
    heading.current = heading.current + wrap(want - heading.current) * Math.min(1, dt * (next.reverse ? 2.2 : 4));
    group.rotation.y = heading.current;
    invalidate();
  });

  return (
    <group ref={ref} visible={target.visible}>
      {children}
    </group>
  );
}

/**
 * Xe nâng đang làm việc ở chế độ DemoDirector tự chạy: đi lại liên tục giữa hai điểm (xe tải ↔ khu staging),
 * nửa đường mang pallet. Chu kỳ theo thời gian thực, lệch pha theo mã xe để không trùng nhau.
 * (Chế độ thao tác tay dùng ForkliftDriver: chỉ chạy khi có pallet thật đổi chỗ.)
 */
export function ShuttleMover({ objectKey, startPoint, endPoint, phase, period = 18, render }: { objectKey: string; startPoint: { x: number; z: number }; endPoint: { x: number; z: number }; phase: number; period?: number; render: (carrying: boolean) => ReactNode }) {
  const ref = useRef<Group>(null);
  const carrying = useRef(false);
  const holder = useRef<Group>(null);
  const loaded = useRef<Group>(null);
  const empty = useRef<Group>(null);
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    if (ref.current) return registerObject(objectKey, ref.current);
  }, [objectKey]);
  useFrame(({ clock }) => {
    const group = ref.current;
    if (!group) return;
    const cycleProgress = ((clock.elapsedTime + phase) % period) / period;
    // 0–0.1 dừng lấy hàng · 0.1–0.45 chở tới B · 0.45–0.55 đặt hàng · 0.55–0.9 quay về · 0.9–1 chờ
    let travelFraction: number;
    let dir: 1 | -1 = 1;
    if (cycleProgress < 0.1) travelFraction = 0;
    else if (cycleProgress < 0.45) travelFraction = (cycleProgress - 0.1) / 0.35;
    else if (cycleProgress < 0.55) travelFraction = 1;
    else if (cycleProgress < 0.9) {
      travelFraction = 1 - (cycleProgress - 0.55) / 0.35;
      dir = -1;
    } else travelFraction = 0;
    const ease = travelFraction * travelFraction * (3 - 2 * travelFraction);
    group.position.set(startPoint.x + (endPoint.x - startPoint.x) * ease, 0, startPoint.z + (endPoint.z - startPoint.z) * ease);
    // Xe nâng chở hàng đi lùi ra khỏi xe tải rồi quay đầu: đơn giản hóa — luôn hướng càng về phía điểm đến
    const heading = Math.atan2(endPoint.x - startPoint.x, endPoint.z - startPoint.z);
    group.rotation.y = dir === 1 ? heading : heading + Math.PI;
    const isCarrying = cycleProgress >= 0.05 && cycleProgress < 0.5;
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
