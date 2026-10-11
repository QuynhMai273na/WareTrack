import { useQueries } from '@tanstack/react-query';
import type { PublishedLayout, SiteSnapshot } from '@waretrack/shared-schemas';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import type { SelectableType } from '@/stores/scene';
import { api } from '@/lib/api';
import { useLayout, useSites, useSnapshot } from '@/lib/queries';
import { indexLayout } from '@/scene/layoutIndex';
import { useScene } from '@/stores/scene';
import { useSiteContext } from '../shell/SiteShell';
import { CameraButtons } from './CameraButtons';
import { Inspector } from './Inspector';
import { KpiBar } from './KpiBar';
import { OpsTable } from './OpsTable';
import { Tracker } from './Tracker';

const SiteScene = lazy(() => import('@/scene/SiteScene').then((sceneModule) => ({ default: sceneModule.SiteScene })));

function webglAvailable() {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/**
 * Dashboard & 3D Operations Monitoring (mục 9 BRD, mục 18): scene là nền, overlay theo bố cục video.
 * 2D luôn đủ chức năng khi không có 3D (AC-10, FR-12.07).
 */
export function DashboardPage() {
  const { t } = useTranslation();
  const { siteId, siteCode, timeZone } = useSiteContext();
  const { data: snapshot } = useSnapshot(siteId);
  const { data: layout, isError: noLayout } = useLayout(siteId);
  const mode = useScene((state) => state.mode);
  const setMode = useScene((state) => state.setMode);
  const [lowFps, setLowFps] = useState(false);
  const [params, setParams] = useSearchParams();
  const select = useScene((state) => state.select);
  const navigate = useNavigate();
  const { data: sites } = useSites();

  // Bản đồ chung: layout + snapshot của MỌI site (site đang xem cập nhật realtime, site khác làm mới định kỳ)
  const others = (sites ?? []).filter((otherSite) => otherSite.siteType !== 'VEHICLE_YARD' || otherSite.id === siteId);
  const layoutQs = useQueries({ queries: others.map((otherSite) => ({ queryKey: ['site', otherSite.id, 'layout'], queryFn: () => api<PublishedLayout>(`/sites/${otherSite.id}/layout`), staleTime: Infinity, retry: false })) });
  const snapQs = useQueries({
    queries: others.map((otherSite) => ({ queryKey: ['site', otherSite.id, 'snapshot'], queryFn: () => api<SiteSnapshot>(`/sites/${otherSite.id}/snapshot`), staleTime: otherSite.id === siteId ? Infinity : 15_000, refetchInterval: (otherSite.id === siteId ? false : 20_000) as number | false })),
  });
  const network = useMemo(
    () =>
      others
        .map((otherSite, siteIndex) => ({ siteId: otherSite.id, code: otherSite.code, name: otherSite.name, offset: otherSite.map ?? { x: 0, z: 0 }, layout: layoutQs[siteIndex]?.data, snapshot: otherSite.id === siteId ? snapshot : snapQs[siteIndex]?.data }))
        .filter((networkSite): networkSite is typeof networkSite & { layout: PublishedLayout } => !!networkSite.layout),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [others.map((otherSite) => otherSite.id).join(), layoutQs.map((layoutQuery) => layoutQuery.dataUpdatedAt).join(), snapQs.map((snapshotQuery) => snapshotQuery.dataUpdatedAt).join(), snapshot, siteId],
  );

  // Chọn đối tượng của site khác trên bản đồ → chuyển sang site đó rồi giữ lựa chọn
  const pending = useRef<{ siteId: string; type: SelectableType; id: string } | null>(null);
  const selection = useScene((state) => state.selection);
  useEffect(() => {
    if (selection && selection.siteId !== siteId) {
      const target = sites?.find((site) => site.id === selection.siteId);
      if (target) {
        pending.current = selection;
        navigate(`/sites/${target.code}`);
      }
    }
  }, [selection, siteId, sites, navigate]);
  useEffect(() => {
    if (pending.current?.siteId === siteId) {
      const pendingSelection = pending.current;
      pending.current = null;
      setTimeout(() => select(pendingSelection), 50);
    }
  }, [siteId, select]);

  // Liên kết sâu ?select=forklift:<id> (từ thông báo) → chọn đối tượng rồi bỏ tham số khỏi URL
  useEffect(() => {
    const raw = params.get('select');
    if (!raw) return;
    const [type, id] = raw.split(':');
    if (type && id) select({ siteId, type: type as SelectableType, id });
    setParams({}, { replace: true });
  }, [params, setParams, select, siteId]);

  useEffect(() => {
    if (!webglAvailable()) setMode('2d');
  }, [setMode]);

  // Nạp nhãn vị trí (Bay 1, Yard slot S01…) cho panel 2D kể cả khi không mở 3D
  useEffect(() => {
    if (layout) indexLayout(layout);
  }, [layout]);

  const show3d = mode === '3d' && !!layout && !noLayout;

  return (
    <div className="relative h-full overflow-hidden">
      <div className="absolute inset-0">
        {show3d && network.length > 0 ? (
          <Suspense fallback={<div className="flex h-full items-center justify-center text-muted">{t('common.loading')}</div>}>
            <SiteScene sites={network} currentSiteId={siteId} onPickSite={(code) => navigate(`/sites/${code}`)} onLowFps={() => setLowFps(true)} />
          </Suspense>
        ) : null}
      </div>

      {snapshot ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col px-4 pb-4 pt-[72px]">
          <div className="flex items-start justify-between gap-4">
            <KpiBar kpis={snapshot.kpis} siteCode={siteCode} />
            <div className="flex items-start gap-3">
              <CameraButtons />
              <Inspector snapshot={snapshot} timeZone={timeZone} />
            </div>
          </div>
          {lowFps && mode === '3d' ? (
            <div className="card pointer-events-auto mx-auto mt-3 px-4 py-2 text-sm">
              3D đang chậm trên thiết bị này —{' '}
              <button className="font-medium text-brand" onClick={() => setMode('2d')}>
                chuyển sang 2D
              </button>
            </div>
          ) : null}
          {mode === '2d' ? (
            <div className="mt-4 flex flex-1 items-start">
              <OpsTable snapshot={snapshot} expanded />
            </div>
          ) : (
            <div className="flex-1" />
          )}
          <div className="flex items-end justify-between gap-4">
            <Tracker snapshot={snapshot} timeZone={timeZone} />
            {mode === '3d' ? <OpsTable snapshot={snapshot} /> : null}
          </div>
        </div>
      ) : (
        <div className="flex h-full items-center justify-center text-muted">{t('common.loading')}</div>
      )}
    </div>
  );
}
