import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, type ReactNode } from 'react';
import { Group, Vector3 } from 'three';
import { registerObject } from './registry';

/**
 * Animation State (mục 18.4, 18.9): pose hiển thị nội suy về target lấy từ Business State.
 * Lưu trong ref (không phải React state), không bao giờ ghi ngược API/cache (BR-30).
 * Event mới khi đang tween → retarget từ vị trí hiện tại; xa quá hoặc lần đầu → snap.
 */
export function Animated({ objectKey, x, z, rotY, speed = 6, children }: { objectKey: string; x: number; z: number; rotY: number; speed?: number; children: ReactNode }) {
  const ref = useRef<Group>(null);
  const target = useRef(new Vector3(x, 0, z));
  const targetRot = useRef(rotY);
  const initialized = useRef(false);
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    target.current.set(x, 0, z);
    targetRot.current = rotY;
    const g = ref.current;
    if (g && !initialized.current) {
      g.position.copy(target.current);
      g.rotation.y = rotY;
      initialized.current = true;
    }
    invalidate();
  }, [x, z, rotY, invalidate]);

  useEffect(() => {
    if (ref.current) return registerObject(objectKey, ref.current);
  }, [objectKey]);

  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    const dist = g.position.distanceTo(target.current);
    if (dist < 0.02 && Math.abs(g.rotation.y - targetRot.current) < 0.01) return;
    if (dist > 120 || dt > 0.5) {
      g.position.copy(target.current); // tab ẩn / quá xa → snap
      g.rotation.y = targetRot.current;
      return;
    }
    const step = Math.min(dist, speed * dt * Math.max(1, dist / 10));
    g.position.add(target.current.clone().sub(g.position).normalize().multiplyScalar(step));
    g.rotation.y += (targetRot.current - g.rotation.y) * Math.min(1, dt * 4);
    invalidate();
  });

  return <group ref={ref}>{children}</group>;
}
