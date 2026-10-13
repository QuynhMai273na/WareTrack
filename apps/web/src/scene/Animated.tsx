import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, type ReactNode } from 'react';
import { Group, Vector3 } from 'three';
import { registerObject, takePose } from './registry';

/**
 * Animation State (mục 18.4, 18.9): pose hiển thị nội suy về target lấy từ Business State.
 * Lưu trong ref (không phải React state), không bao giờ ghi ngược API/cache (BR-30).
 * Event mới khi đang tween → retarget từ vị trí hiện tại; xa quá hoặc lần đầu → snap.
 * `snap`: luôn đứng đúng chỗ, không tự trượt (pallet chỉ di chuyển khi xe nâng chở).
 * `continueFromLastPose`: lần đầu xuất hiện thì bắt đầu từ tư thế cuối của object cùng khóa (không nhảy chỗ khi đổi chế độ vẽ).
 */
export function Animated({ objectKey, x, z, rotY, speed = 6, snap = false, continueFromLastPose = false, visible = true, children }: { objectKey: string; x: number; z: number; rotY: number; speed?: number; snap?: boolean; continueFromLastPose?: boolean; visible?: boolean; children: ReactNode }) {
  const ref = useRef<Group>(null);
  const target = useRef(new Vector3(x, 0, z));
  const targetRot = useRef(rotY);
  const initialized = useRef(false);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    target.current.set(x, 0, z);
    targetRot.current = rotY;
    const group = ref.current;
    if (group && !initialized.current) {
      const lastPose = continueFromLastPose ? takePose(objectKey) : undefined;
      group.position.set(lastPose?.x ?? x, 0, lastPose?.z ?? z);
      group.rotation.y = lastPose?.rotY ?? rotY;
      initialized.current = true;
    } else if (group && snap) {
      group.position.copy(target.current);
      group.rotation.y = rotY;
    }
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, z, rotY, invalidate]);

  useEffect(() => {
    if (ref.current) return registerObject(objectKey, ref.current);
  }, [objectKey]);

  useFrame((_, dt) => {
    const group = ref.current;
    if (!group) return;
    const dist = group.position.distanceTo(target.current);
    if (dist < 0.02 && Math.abs(group.rotation.y - targetRot.current) < 0.01) return;
    if (dist > 120 || dt > 0.5) {
      group.position.copy(target.current); // tab ẩn / quá xa → snap
      group.rotation.y = targetRot.current;
      return;
    }
    const step = Math.min(dist, speed * dt * Math.max(1, dist / 10));
    group.position.add(target.current.clone().sub(group.position).normalize().multiplyScalar(step));
    group.rotation.y += (targetRot.current - group.rotation.y) * Math.min(1, dt * 4);
    invalidate();
  });

  return (
    <group ref={ref} visible={visible}>
      {children}
    </group>
  );
}
