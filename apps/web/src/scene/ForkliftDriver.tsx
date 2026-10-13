import { useFrame, useThree } from '@react-three/fiber';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Group } from 'three';
import { CARRY_HEIGHT, type DriveStep, FORK_REACH, homePlan, jobPlan, type PalletJob } from './forkliftJobs';
import { PalletModel } from './models';
import { registerObject, takePose } from './registry';

const DRIVE_SPEED = 3.8;
const REVERSE_SPEED = 1.6;
const TURN_RATE = 2.6;
const LIFT_SPEED = 1.4;

const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

type Obstacles = Parameters<typeof jobPlan>[2];

/**
 * Xe nâng đang chở pallet: chạy tới chỗ pallet, quay mặt vào, nâng càng, tiến vào xúc, lùi ra, chở tới chỗ mới,
 * đặt xuống rồi lùi ra; hết việc thì về chỗ đỗ và báo `onHome`. Pallet trên càng mang đúng màu của pallet thật.
 * Tiếp tục từ tư thế đang hiển thị của xe nâng (không nhảy chỗ khi chuyển chế độ).
 */
export function ForkliftDriver({
  objectKey,
  job,
  home,
  obstacles,
  onPickup,
  onDrop,
  onHome,
  children,
}: {
  objectKey: string;
  job: PalletJob | null;
  home: { x: number; z: number; rotY: number };
  obstacles: Obstacles;
  onPickup: (jobId: string) => void;
  onDrop: (jobId: string) => void;
  onHome: () => void;
  children: ReactNode;
}) {
  const ref = useRef<Group>(null);
  const cargoRef = useRef<Group>(null);
  const steps = useRef<DriveStep[]>([]);
  const heading = useRef(home.rotY);
  const liftHeight = useRef(CARRY_HEIGHT);
  const pauseLeft = useRef(0);
  const plannedFor = useRef<string | null>(null);
  const homeReported = useRef(false);
  const [cargo, setCargo] = useState<{ color: string; scale: number } | null>(null);
  const invalidate = useThree((state) => state.invalidate);
  // Giá trị mới nhất cho vòng lặp khung hình (không lập lại kế hoạch khi chỉ đổi tham chiếu)
  const latest = useRef({ job, home, obstacles, onPickup, onDrop, onHome });
  latest.current = { job, home, obstacles, onPickup, onDrop, onHome };

  useLayoutEffect(() => {
    const group = ref.current;
    if (!group) return;
    const pose = takePose(objectKey) ?? { x: home.x, z: home.z, rotY: home.rotY };
    group.position.set(pose.x, 0, pose.z);
    heading.current = pose.rotY;
    group.rotation.y = pose.rotY;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ref.current) return registerObject(objectKey, ref.current);
  }, [objectKey]);

  useEffect(() => {
    if (job) setCargo({ color: job.color, scale: job.scale });
    invalidate();
  }, [job, invalidate]);

  useFrame((_, rawDelta) => {
    const group = ref.current;
    if (!group) return;
    const delta = Math.min(rawDelta, 0.1);
    const { job: currentJob, home: homePose, obstacles: currentObstacles } = latest.current;
    const position = { x: group.position.x, z: group.position.z };

    // Lập kế hoạch khi rảnh: chuyến kế tiếp, hoặc về chỗ đỗ; đang về mà có chuyến mới thì đổi ngay
    if (currentJob && plannedFor.current !== currentJob.id && (steps.current.length === 0 || plannedFor.current === 'home')) {
      steps.current = jobPlan(currentJob, position, currentObstacles);
      plannedFor.current = currentJob.id;
      homeReported.current = false;
    } else if (!currentJob && steps.current.length === 0 && plannedFor.current !== 'home') {
      steps.current = homePlan(position, homePose, currentObstacles);
      plannedFor.current = 'home';
    }

    const step = steps.current[0];
    if (!step) {
      if (plannedFor.current === 'home' && !homeReported.current) {
        homeReported.current = true;
        latest.current.onHome();
      }
      return;
    }

    switch (step.kind) {
      case 'drive':
      case 'reverse': {
        const offsetX = step.x - position.x;
        const offsetZ = step.z - position.z;
        const remaining = Math.hypot(offsetX, offsetZ);
        if (remaining < 0.06) {
          steps.current.shift();
          break;
        }
        const reversing = step.kind === 'reverse';
        const wanted = Math.atan2(offsetX, offsetZ) + (reversing ? Math.PI : 0);
        const headingError = wrap(wanted - heading.current);
        // Lệch hướng nhiều thì xoay tại chỗ trước (xe nâng quay đầu gọn), lệch ít thì vừa chạy vừa lái
        if (!reversing && Math.abs(headingError) > 0.6 && remaining > 0.6) {
          heading.current += Math.sign(headingError) * Math.min(Math.abs(headingError), TURN_RATE * delta);
        } else {
          heading.current += headingError * Math.min(1, delta * 5);
          const travel = Math.min(remaining, (reversing ? REVERSE_SPEED : DRIVE_SPEED) * delta);
          group.position.x += (offsetX / remaining) * travel;
          group.position.z += (offsetZ / remaining) * travel;
        }
        break;
      }
      case 'turn': {
        const headingError = wrap(step.heading - heading.current);
        if (Math.abs(headingError) < 0.02) {
          heading.current = step.heading;
          steps.current.shift();
        } else heading.current += Math.sign(headingError) * Math.min(Math.abs(headingError), TURN_RATE * delta);
        break;
      }
      case 'lift': {
        const gap = step.y - liftHeight.current;
        if (Math.abs(gap) < 0.01) {
          liftHeight.current = step.y;
          steps.current.shift();
        } else liftHeight.current += Math.sign(gap) * Math.min(Math.abs(gap), LIFT_SPEED * delta);
        if (cargoRef.current) cargoRef.current.position.y = liftHeight.current;
        break;
      }
      case 'pause': {
        if (pauseLeft.current <= 0) pauseLeft.current = step.seconds;
        pauseLeft.current -= delta;
        if (pauseLeft.current <= 0) {
          pauseLeft.current = 0;
          steps.current.shift();
        }
        break;
      }
      case 'pickup': {
        if (cargoRef.current) cargoRef.current.visible = true;
        latest.current.onPickup(step.jobId);
        steps.current.shift();
        break;
      }
      case 'drop': {
        if (cargoRef.current) cargoRef.current.visible = false;
        latest.current.onDrop(step.jobId);
        steps.current.shift();
        break;
      }
    }
    group.rotation.y = heading.current;
    invalidate();
  });

  return (
    <group ref={ref}>
      {children}
      {/* Pallet trên càng: chỉ hiện từ lúc xúc tới lúc đặt; nâng theo tầng rack */}
      <group ref={cargoRef} position={[0, CARRY_HEIGHT, FORK_REACH]} visible={false}>
        {cargo ? <PalletModel boxColor={cargo.color} scale={cargo.scale * 0.85} /> : null}
      </group>
    </group>
  );
}
