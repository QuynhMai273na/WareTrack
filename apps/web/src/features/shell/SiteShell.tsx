import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Navigate, Outlet, useOutletContext, useParams } from 'react-router';
import { useSites } from '@/lib/queries';
import { useSiteRealtime } from '@/realtime/useSiteRealtime';
import { useScene } from '@/stores/scene';
import { TopBar } from './TopBar';

export interface SiteContext {
  siteId: string;
  siteCode: string;
  timeZone: string;
}

export const useSiteContext = () => useOutletContext<SiteContext>();

/**
 * Ngữ cảnh site (UC-21): URL /sites/:siteCode quyết định site hiện hành — đổi site đồng thời đổi
 * query, socket room và scene; selection của site cũ bị xóa.
 */
export function SiteShell() {
  const { siteCode = '' } = useParams();
  const { data: sites, isLoading } = useSites();
  const site = sites?.find((s) => s.code === siteCode);
  const setSite = useScene((s) => s.setSite);
  const qc = useQueryClient();

  useEffect(() => {
    if (!site) return;
    const previous = useScene.getState().siteId;
    if (previous && previous !== site.id) void qc.cancelQueries({ queryKey: ['site', previous] });
    setSite(site.id);
    try {
      localStorage.setItem('wt.lastSite', site.code);
    } catch {
      /* bỏ qua */
    }
  }, [site, setSite, qc]);

  useSiteRealtime(site?.id);

  if (isLoading) return <div className="flex h-full items-center justify-center text-muted">Loading…</div>;
  if (!site) return <Navigate to={sites?.[0] ? `/sites/${sites[0].code}` : '/login'} replace />;

  return (
    <div className="relative h-full">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20">
        <TopBar siteCode={site.code} timeZone={site.timezone} siteId={site.id} />
      </div>
      <Outlet context={{ siteId: site.id, siteCode: site.code, timeZone: site.timezone } satisfies SiteContext} />
    </div>
  );
}
