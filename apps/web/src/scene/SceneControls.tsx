import { CameraControls, CameraControlsImpl } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Group, Vector3 } from 'three';
import { useScene } from '@/stores/scene';
import type { LayoutIndex } from './layoutIndex';
import { getObject, objectKey } from './registry';

const POLAR = 0.95; // ~55° từ phương thẳng đứng — góc isometric (mục 18.2)

/** Camera isometric: kéo trái = pan, kéo phải = xoay, cuộn = zoom; nút: zoom ±, xoay 90°, reset, home. */
/** operations = tỉ lệ cố định theo video (khu vận hành); whole = vừa khít toàn bộ site (xem trước sơ đồ). */
export type CameraFraming = 'operations' | 'whole';

export function CameraRig({
  layout,
  offset,
  network,
  framing = 'operations',
}: {
  layout: LayoutIndex;
  offset: { x: number; z: number };
  network: Array<{ layout: LayoutIndex; offset: { x: number; z: number } }>;
  framing?: CameraFraming;
}) {
  const initialized = useRef(false);
  const ref = useRef<CameraControlsImpl>(null);
  const command = useScene((s) => s.cameraCommand);
  const focusRequest = useScene((s) => s.focusRequest);
  const selection = useScene((s) => s.selection);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);

  /**
   * Khung nhìn ban đầu: tập trung vào khu vận hành (nhà kho + dock + bãi chờ), không phải toàn bộ khu đất.
   * Với camera isometric 45°, bề ngang chiếu của hình chữ nhật w×d ≈ (w + d)·cos45°.
   */
  /** Vừa khít mọi nhà kho + vị trí của site (bản xem trước sơ đồ). */
  const fitWholeSite = (animate: boolean) => {
    const controls = ref.current;
    if (!controls) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const include = (x: number, z: number) => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    };
    for (const building of layout.buildings) {
      include(building.posX - building.sizeX / 2, building.posZ - building.sizeZ / 2);
      include(building.posX + building.sizeX / 2, building.posZ + building.sizeZ / 2);
    }
    for (const location of layout.locations) include(location.x, location.z);
    if (!Number.isFinite(minX)) return;
    const centerX = (minX + maxX) / 2 + offset.x;
    const centerZ = (minZ + maxZ) / 2 + offset.z;
    const projectedWidth = (maxX - minX + (maxZ - minZ)) * Math.SQRT1_2 + 30;
    const zoom = Math.max(2, Math.min(24, (size.width * 0.9) / projectedWidth));
    void controls.setLookAt(centerX + 80, 95, centerZ + 80, centerX, 0, centerZ, animate);
    void controls.zoomTo(zoom, animate);
  };

  const fitHome = (animate: boolean) => {
    if (framing === 'whole') return fitWholeSite(animate);
    const c = ref.current;
    if (!c) return;
    // Tâm khu vận hành: tâm các tòa nhà (theo diện tích) lệch về phía dock — như khung hình video
    let ax = 0;
    let az = 0;
    let area = 0;
    for (const bd of layout.buildings) {
      const a = bd.sizeX * bd.sizeZ;
      ax += bd.posX * a;
      az += bd.posZ * a;
      area += a;
    }
    const docks = layout.locations.filter((l) => l.type === 'DOCK');
    let cx = area ? ax / area : layout.center.x;
    let cz = area ? az / area : layout.center.z;
    if (docks.length) {
      const dx = docks.reduce((s, d) => s + d.x, 0) / docks.length;
      const dz = docks.reduce((s, d) => s + d.z, 0) / docks.length;
      cx = cx * 0.7 + dx * 0.3;
      cz = cz * 0.7 + dz * 0.3 + 6;
    }
    // Tỉ lệ cố định theo video (đo trên khung hình: tòa nhà WH-01 ≈ 670 px khi màn hình rộng 1600 px)
    const zoom = Math.max(4, Math.min(40, 19 * (size.width / 1600)));
    // Dịch tâm sang phải màn hình một chút (panel inspector chiếm bên phải) → tòa nhà nằm lệch trái
    const shift = (size.width * 0.07) / zoom;
    cx += shift * Math.SQRT1_2;
    cz -= shift * Math.SQRT1_2;
    cx += offset.x;
    cz += offset.z;
    void c.setLookAt(cx + 80, 95, cz + 80, cx, 0, cz, animate);
    void c.zoomTo(zoom, animate);
  };

  /** Network overview: thu nhỏ để thấy cả mạng lưới site trên bản đồ chung. */
  const fitNetwork = () => {
    const c = ref.current;
    if (!c || network.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const n of network) {
      for (const bd of n.layout.buildings) {
        minX = Math.min(minX, n.offset.x + bd.posX - bd.sizeX / 2);
        maxX = Math.max(maxX, n.offset.x + bd.posX + bd.sizeX / 2);
        minZ = Math.min(minZ, n.offset.z + bd.posZ - bd.sizeZ / 2);
        maxZ = Math.max(maxZ, n.offset.z + bd.posZ + bd.sizeZ / 2);
      }
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const projected = (maxX - minX + (maxZ - minZ)) * Math.SQRT1_2 + 60;
    const zoom = Math.max(1.2, Math.min(20, (size.width * 0.8) / projected));
    void c.setLookAt(cx + 80, 95, cz + 80, cx, 0, cz, true);
    void c.zoomTo(zoom, true);
  };

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.minPolarAngle = POLAR;
    c.maxPolarAngle = POLAR;
    c.minZoom = 1;
    c.maxZoom = 60;
    c.mouseButtons.left = CameraControlsImpl.ACTION.TRUCK;
    c.mouseButtons.right = CameraControlsImpl.ACTION.ROTATE;
    c.mouseButtons.wheel = CameraControlsImpl.ACTION.ZOOM;
    c.touches.one = CameraControlsImpl.ACTION.TOUCH_TRUCK;
    c.touches.two = CameraControlsImpl.ACTION.TOUCH_ZOOM_TRUCK;
    c.dollyToCursor = true;
    fitHome(initialized.current);
    initialized.current = true;
    invalidate();
    // drei tạo lại CameraControls khi camera mặc định đổi sang OrthographicCamera → cấu hình lại theo camera.
    // Đổi site (layout khác) → camera BAY sang site đó trên bản đồ chung (không dựng lại scene).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, camera]);

  useEffect(() => {
    const c = ref.current;
    if (!c || !command) return;
    const zoom = (camera as { zoom: number }).zoom;
    switch (command.cmd) {
      case 'zoomIn':
        void c.zoomTo(zoom * 1.35, true);
        break;
      case 'zoomOut':
        void c.zoomTo(zoom / 1.35, true);
        break;
      case 'rotate':
        void c.rotate(Math.PI / 2, 0, true);
        break;
      case 'reset':
        void c.rotateAzimuthTo(Math.PI / 4, true);
        break;
      case 'home':
        fitHome(true);
        break;
      case 'network':
        fitNetwork();
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  // Fly-to khi chọn đối tượng (mục 18.6) — bay tới vị trí HIỂN THỊ hiện tại
  useEffect(() => {
    if (!selection) return;
    // Chọn ngay sau khi chuyển trang (từ tìm kiếm / trang Vehicles): đối tượng có thể chưa được dựng → thử lại tối đa ~4s
    let cancelled = false;
    let tries = 0;
    const attempt = () => {
      if (cancelled) return;
      const c = ref.current;
      const obj = getObject(objectKey(selection.type, selection.id));
      if (!c || !obj) {
        if (tries++ < 40) setTimeout(attempt, 100);
        return;
      }
      const p = new Vector3();
      obj.getWorldPosition(p);
      void c.moveTo(p.x, 0, p.z, true);
      const zoom = (camera as { zoom: number }).zoom;
      void c.zoomTo(Math.max(zoom * 1.25, 22), true);
    };
    attempt();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  return <CameraControls ref={ref} makeDefault smoothTime={0.35} />;
}

/** Khung chọn 4 góc bám theo vị trí hiển thị của đối tượng (UC-20 E2). */
export function SelectionBracket() {
  const selection = useScene((s) => s.selection);
  const group = useRef<Group>(null);
  const invalidate = useThree((s) => s.invalidate);
  const size = selection?.type === 'truck' ? [3.6, 17] : selection?.type === 'dock' ? [5.4, 2] : selection?.type === 'vehicle' ? [2.6, 5.2] : [2.4, 3];

  useFrame(() => {
    const g = group.current;
    if (!g || !selection) return;
    const obj = getObject(objectKey(selection.type, selection.id));
    if (!obj) {
      g.visible = false;
      return;
    }
    const p = new Vector3();
    obj.getWorldPosition(p);
    if (g.position.distanceTo(p) > 0.01 || !g.visible) {
      g.visible = true;
      g.position.copy(p);
      g.rotation.y = obj.rotation.y;
      invalidate();
    }
  });

  if (!selection) return null;
  const [w, d] = size;
  const L = Math.min(w, d) * 0.35;
  const corners: Array<[number, number, number, number]> = [
    [-w / 2, -d / 2, 1, 1],
    [w / 2, -d / 2, -1, 1],
    [-w / 2, d / 2, 1, -1],
    [w / 2, d / 2, -1, -1],
  ];
  return (
    <group ref={group} visible={false}>
      {corners.map(([x, z, sx, sz], i) => (
        <group key={i} position={[x, 0.08, z + (selection.type === 'dock' ? 1.2 : 0)]}>
          <mesh position={[(sx * L) / 2, 0, 0]}>
            <boxGeometry args={[L, 0.06, 0.18]} />
            <meshBasicMaterial color="#2f6fe4" />
          </mesh>
          <mesh position={[0, 0, (sz * L) / 2]}>
            <boxGeometry args={[0.18, 0.06, L]} />
            <meshBasicMaterial color="#2f6fe4" />
          </mesh>
        </group>
      ))}
    </group>
  );
}
