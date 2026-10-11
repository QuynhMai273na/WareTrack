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
  const command = useScene((state) => state.cameraCommand);
  const focusRequest = useScene((state) => state.focusRequest);
  const selection = useScene((state) => state.selection);
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const invalidate = useThree((state) => state.invalidate);

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
    const controls = ref.current;
    if (!controls) return;
    // Tâm khu vận hành: tâm các tòa nhà (theo diện tích) lệch về phía dock — như khung hình video
    let ax = 0;
    let az = 0;
    let area = 0;
    for (const bd of layout.buildings) {
      const buildingArea = bd.sizeX * bd.sizeZ;
      ax += bd.posX * buildingArea;
      az += bd.posZ * buildingArea;
      area += buildingArea;
    }
    const docks = layout.locations.filter((location) => location.type === 'DOCK');
    let cx = area ? ax / area : layout.center.x;
    let cz = area ? az / area : layout.center.z;
    if (docks.length) {
      const dx = docks.reduce((sum, dock) => sum + dock.x, 0) / docks.length;
      const dz = docks.reduce((sum, dock) => sum + dock.z, 0) / docks.length;
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
    void controls.setLookAt(cx + 80, 95, cz + 80, cx, 0, cz, animate);
    void controls.zoomTo(zoom, animate);
  };

  /** Network overview: thu nhỏ để thấy cả mạng lưới site trên bản đồ chung. */
  const fitNetwork = () => {
    const controls = ref.current;
    if (!controls || network.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const networkEntry of network) {
      for (const bd of networkEntry.layout.buildings) {
        minX = Math.min(minX, networkEntry.offset.x + bd.posX - bd.sizeX / 2);
        maxX = Math.max(maxX, networkEntry.offset.x + bd.posX + bd.sizeX / 2);
        minZ = Math.min(minZ, networkEntry.offset.z + bd.posZ - bd.sizeZ / 2);
        maxZ = Math.max(maxZ, networkEntry.offset.z + bd.posZ + bd.sizeZ / 2);
      }
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const projected = (maxX - minX + (maxZ - minZ)) * Math.SQRT1_2 + 60;
    const zoom = Math.max(1.2, Math.min(20, (size.width * 0.8) / projected));
    void controls.setLookAt(cx + 80, 95, cz + 80, cx, 0, cz, true);
    void controls.zoomTo(zoom, true);
  };

  useEffect(() => {
    const controls = ref.current;
    if (!controls) return;
    controls.minPolarAngle = POLAR;
    controls.maxPolarAngle = POLAR;
    controls.minZoom = 1;
    controls.maxZoom = 60;
    controls.mouseButtons.left = CameraControlsImpl.ACTION.TRUCK;
    controls.mouseButtons.right = CameraControlsImpl.ACTION.ROTATE;
    controls.mouseButtons.wheel = CameraControlsImpl.ACTION.ZOOM;
    controls.touches.one = CameraControlsImpl.ACTION.TOUCH_TRUCK;
    controls.touches.two = CameraControlsImpl.ACTION.TOUCH_ZOOM_TRUCK;
    controls.dollyToCursor = true;
    fitHome(initialized.current);
    initialized.current = true;
    invalidate();
    // drei tạo lại CameraControls khi camera mặc định đổi sang OrthographicCamera → cấu hình lại theo camera.
    // Đổi site (layout khác) → camera BAY sang site đó trên bản đồ chung (không dựng lại scene).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, camera]);

  useEffect(() => {
    const controls = ref.current;
    if (!controls || !command) return;
    const zoom = (camera as { zoom: number }).zoom;
    switch (command.cmd) {
      case 'zoomIn':
        void controls.zoomTo(zoom * 1.35, true);
        break;
      case 'zoomOut':
        void controls.zoomTo(zoom / 1.35, true);
        break;
      case 'rotate':
        void controls.rotate(Math.PI / 2, 0, true);
        break;
      case 'reset':
        void controls.rotateAzimuthTo(Math.PI / 4, true);
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
      const controls = ref.current;
      const obj = getObject(objectKey(selection.type, selection.id));
      if (!controls || !obj) {
        if (tries++ < 40) setTimeout(attempt, 100);
        return;
      }
      const worldPosition = new Vector3();
      obj.getWorldPosition(worldPosition);
      void controls.moveTo(worldPosition.x, 0, worldPosition.z, true);
      const zoom = (camera as { zoom: number }).zoom;
      void controls.zoomTo(Math.max(zoom * 1.25, 22), true);
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
  const selection = useScene((state) => state.selection);
  const group = useRef<Group>(null);
  const invalidate = useThree((state) => state.invalidate);
  const size = selection?.type === 'truck' ? [3.6, 17] : selection?.type === 'dock' ? [5.4, 2] : selection?.type === 'vehicle' ? [2.6, 5.2] : [2.4, 3];

  useFrame(() => {
    const bracketGroup = group.current;
    if (!bracketGroup || !selection) return;
    const obj = getObject(objectKey(selection.type, selection.id));
    if (!obj) {
      bracketGroup.visible = false;
      return;
    }
    const worldPosition = new Vector3();
    obj.getWorldPosition(worldPosition);
    if (bracketGroup.position.distanceTo(worldPosition) > 0.01 || !bracketGroup.visible) {
      bracketGroup.visible = true;
      bracketGroup.position.copy(worldPosition);
      bracketGroup.rotation.y = obj.rotation.y;
      invalidate();
    }
  });

  if (!selection) return null;
  const [width, depth] = size;
  const armLength = Math.min(width, depth) * 0.35;
  const corners: Array<[number, number, number, number]> = [
    [-width / 2, -depth / 2, 1, 1],
    [width / 2, -depth / 2, -1, 1],
    [-width / 2, depth / 2, 1, -1],
    [width / 2, depth / 2, -1, -1],
  ];
  return (
    <group ref={group} visible={false}>
      {corners.map(([x, z, sx, sz], cornerIndex) => (
        <group key={cornerIndex} position={[x, 0.08, z + (selection.type === 'dock' ? 1.2 : 0)]}>
          <mesh position={[(sx * armLength) / 2, 0, 0]}>
            <boxGeometry args={[armLength, 0.06, 0.18]} />
            <meshBasicMaterial color="#2f6fe4" />
          </mesh>
          <mesh position={[0, 0, (sz * armLength) / 2]}>
            <boxGeometry args={[0.18, 0.06, armLength]} />
            <meshBasicMaterial color="#2f6fe4" />
          </mesh>
        </group>
      ))}
    </group>
  );
}
