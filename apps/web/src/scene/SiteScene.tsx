import { AdaptiveDpr, Environment, Html, Lightformer, OrthographicCamera, PerformanceMonitor } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import type { PublishedLayout, SiteSnapshot } from '@waretrack/shared-schemas';
import { memo, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { type DirectionalLight, NeutralToneMapping } from 'three';
import { useScene } from '@/stores/scene';
import { DynamicLayers } from './DynamicLayers';
import { indexLayout, type LayoutIndex } from './layoutIndex';
import { type CameraFraming, CameraRig, SelectionBracket } from './SceneControls';
import { StaticLayout } from './StaticLayout';

export interface NetworkSite {
  siteId: string;
  code: string;
  name: string;
  offset: { x: number; z: number };
  layout: PublishedLayout;
  snapshot: SiteSnapshot | undefined;
}

/** Nắng chiếu xiên từ tây-bắc, bóng đổ mềm phủ site đang xem (khung shadow theo site hiện hành). */
function SunLight({ center, half }: { center: { x: number; z: number }; half: number }) {
  const ref = useRef<DirectionalLight>(null);
  const { x, z } = center;
  useEffect(() => {
    const light = ref.current;
    if (!light) return;
    light.target.position.set(x, 0, z);
    light.target.updateMatrixWorld();
    light.shadow.camera.updateProjectionMatrix();
  }, [x, z, half]);
  return (
    <directionalLight
      ref={ref}
      position={[x - 70, 110, z - 30]}
      intensity={2.2}
      color="#fffaf2"
      castShadow
      shadow-mapSize={[2048, 2048]}
      shadow-camera-left={-half}
      shadow-camera-right={half}
      shadow-camera-top={half}
      shadow-camera-bottom={-half}
      shadow-camera-near={1}
      shadow-camera-far={400}
      shadow-bias={-0.0004}
      shadow-normalBias={0.04}
    />
  );
}

/** Một site trên bản đồ chung: layout tĩnh + lớp động (xe, pallet, xe nâng) dịch theo gốc tọa độ của site. */
const SiteOnMap = memo(function SiteOnMap({ site, index }: { site: NetworkSite; index: LayoutIndex }) {
  return (
    <group position={[site.offset.x, 0, site.offset.z]}>
      <StaticLayout layout={index} siteId={site.siteId} />
      {site.snapshot ? <DynamicLayers snapshot={site.snapshot} layout={index} /> : null}
    </group>
  );
});

/** Nhãn tên site — chỉ hiện khi thu nhỏ (Network overview); bấm để bay tới site đó. */
function SiteTags({ sites, indexes, currentSiteId, onPick }: { sites: NetworkSite[]; indexes: Map<string, LayoutIndex>; currentSiteId: string; onPick?: (code: string) => void }) {
  const [visible, setVisible] = useState(false);
  useFrame(({ camera }) => {
    const isZoomedOut = (camera as { zoom: number }).zoom < 9;
    if (isZoomedOut !== visible) setVisible(isZoomedOut);
  });
  if (!visible) return null;
  return (
    <>
      {sites.map((site) => {
        const ix = indexes.get(site.siteId);
        if (!ix) return null;
        return (
          <Html key={site.siteId} position={[site.offset.x + ix.center.x, 24, site.offset.z + ix.center.z]} center zIndexRange={[20, 0]}>
            <button
              onClick={() => onPick?.(site.code)}
              className={`flex items-center gap-2 whitespace-nowrap rounded-xl border bg-white/95 py-1 pl-1 pr-3 text-sm font-semibold shadow-md transition hover:-translate-y-0.5 ${site.siteId === currentSiteId ? 'border-brand' : 'border-line'}`}
            >
              <span className="rounded-lg bg-brand px-1.5 py-1 text-[11px] font-bold text-white">{site.code}</span>
              {site.name}
            </button>
          </Html>
        );
      })}
    </>
  );
}

/**
 * Bản đồ mạng lưới (FR-12): mọi site nằm chung một scene isometric — kéo để đi từ kho này sang kho khác,
 * đổi site thì camera bay tới (video: "Network overview — zoom out to all sites").
 * frameloop="demand": chỉ render khi có thay đổi/animation (mục 18.11).
 */
export function SiteScene({
  sites,
  currentSiteId,
  onPickSite,
  onLowFps,
  framing = 'operations',
}: {
  sites: NetworkSite[];
  currentSiteId: string;
  onPickSite?: (code: string) => void;
  onLowFps?: () => void;
  framing?: CameraFraming;
}) {
  const select = useScene((state) => state.select);
  const [dpr, setDpr] = useState(1.5);
  const layoutsKey = sites.map((site) => `${site.siteId}:${site.layout.versionId}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const indexes = useMemo(() => new Map(sites.map((site) => [site.siteId, indexLayout(site.layout)])), [layoutsKey]);
  const current = sites.find((site) => site.siteId === currentSiteId) ?? sites[0];
  const currentIndex = current ? indexes.get(current.siteId) : undefined;
  const network = useMemo(() => sites.map((site) => ({ layout: indexes.get(site.siteId)!, offset: site.offset })).filter((networkEntry) => networkEntry.layout), [sites, indexes]);
  if (!current || !currentIndex) return null;
  const bounds = currentIndex.bounds;
  const center = { x: current.offset.x + currentIndex.center.x, z: current.offset.z + currentIndex.center.z };
  const half = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2 + 30;
  return (
    <Canvas
      shadows="soft"
      frameloop="demand"
      dpr={dpr}
      gl={{ antialias: true, preserveDrawingBuffer: false, toneMapping: NeutralToneMapping, toneMappingExposure: 1.05 }}
      onPointerMissed={() => select(null)}
    >
      <PerformanceMonitor onDecline={() => setDpr(1)} onFallback={() => onLowFps?.()} flipflops={3} />
      <AdaptiveDpr pixelated={false} />
      <color attach="background" args={['#e7eaf6']} />
      <OrthographicCamera makeDefault position={[center.x + 80, 95, center.z + 80]} zoom={6} near={-2000} far={4000} />
      <hemisphereLight args={['#ffffff', '#c9d1ea', 1.1]} />
      <ambientLight intensity={0.35} color="#eef2ff" />
      <SunLight center={center} half={half} />
      <Environment resolution={128} frames={1}>
        <Lightformer form="rect" intensity={2.2} color="#ffffff" position={[0, 6, 0]} rotation-x={Math.PI / 2} scale={[12, 12, 1]} />
        <Lightformer form="rect" intensity={1.2} color="#dbe4ff" position={[-6, 2, 4]} rotation-y={Math.PI / 2} scale={[10, 4, 1]} />
        <Lightformer form="rect" intensity={0.8} color="#fff4e0" position={[6, 2, -4]} rotation-y={-Math.PI / 2} scale={[10, 4, 1]} />
      </Environment>
      <Suspense fallback={null}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[center.x, -0.02, center.z]} receiveShadow>
          <planeGeometry args={[6000, 6000]} />
          <meshStandardMaterial color="#eceef8" roughness={1} />
        </mesh>
        {sites.map((site) => {
          const index = indexes.get(site.siteId);
          return index ? <SiteOnMap key={site.siteId} site={site} index={index} /> : null;
        })}
        <SelectionBracket />
        {sites.length > 1 ? <SiteTags sites={sites} indexes={indexes} currentSiteId={currentSiteId} onPick={onPickSite} /> : null}
      </Suspense>
      <CameraRig layout={currentIndex} offset={current.offset} network={network} framing={framing} />
    </Canvas>
  );
}
