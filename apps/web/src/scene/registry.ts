import type { Object3D } from 'three';

/** Registry objectKey → Object3D để camera fly-to và selection bracket bám vị trí HIỂN THỊ (mục 18.6). */
const objects = new Map<string, Object3D>();
/** Tư thế cuối cùng của object vừa gỡ khỏi scene — xe vừa rời snapshot vẫn biết chỗ để chạy tiếp ra ngoài. */
const lastPoses = new Map<string, { x: number; z: number; rotY: number; visible: boolean }>();

export const objectKey = (type: string, id: string) => `${type}:${id}`;

export function registerObject(key: string, obj: Object3D) {
  objects.set(key, obj);
  lastPoses.delete(key);
  return () => {
    if (objects.get(key) !== obj) return;
    lastPoses.set(key, { x: obj.position.x, z: obj.position.z, rotY: obj.rotation.y, visible: obj.visible });
    objects.delete(key);
  };
}

export function getObject(key: string): Object3D | undefined {
  return objects.get(key);
}

/** Tư thế hiển thị hiện tại, hoặc tư thế cuối cùng nếu object vừa bị gỡ (đọc một lần rồi xóa). */
export function takePose(key: string): { x: number; z: number; rotY: number; visible: boolean } | undefined {
  const obj = objects.get(key);
  if (obj) return { x: obj.position.x, z: obj.position.z, rotY: obj.rotation.y, visible: obj.visible };
  const pose = lastPoses.get(key);
  lastPoses.delete(key);
  return pose;
}
