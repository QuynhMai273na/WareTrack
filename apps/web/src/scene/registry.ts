import type { Object3D } from 'three';

/** Registry objectKey → Object3D để camera fly-to và selection bracket bám vị trí HIỂN THỊ (mục 18.6). */
const objects = new Map<string, Object3D>();

export const objectKey = (type: string, id: string) => `${type}:${id}`;

export function registerObject(key: string, obj: Object3D) {
  objects.set(key, obj);
  return () => {
    if (objects.get(key) === obj) objects.delete(key);
  };
}

export function getObject(key: string): Object3D | undefined {
  return objects.get(key);
}
