import type { SiteSnapshot } from '@waretrack/shared-schemas';
import { ChevronRight, ClipboardList } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn, minutesFromNow } from '@/lib/utils';
import { locationLabels } from '@/scene/labels';
import { useScene } from '@/stores/scene';

const short = (carrier: string | null | undefined) => (carrier ?? '').split(' ')[0];
const DOT: Record<string, string> = { WareTrack: 'bg-brand', Bluepeak: 'bg-[#1e3a8a]', Nordline: 'bg-teal-500', Cargoviva: 'bg-orange-500' };

function Progress({ done, total, color = 'bg-ok' }: { done: number; total: number; color?: string }) {
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  return (
    <div className="w-16">
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className={cn('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
      </div>
      <div className="tabular mt-0.5 text-[11px] text-muted">
        {done}/{total}
      </div>
    </div>
  );
}

/** Trạng thái hiển thị như video: Loading / Unloading / Docking / En route / At gate / Available… */
function truckState(status: string, direction: 'INBOUND' | 'OUTBOUND' | undefined, t: (k: string) => string): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'SCHEDULED':
      return { label: t('v.truck.enRoute'), tone: 'info' };
    case 'AT_GATE':
    case 'WAITING':
      return { label: t('v.truck.atGate'), tone: 'warn' };
    case 'DOCK_ASSIGNED':
      return { label: t('v.truck.docking'), tone: 'info' };
    case 'READY_TO_LEAVE':
      return { label: t('v.truck.departing'), tone: 'ok' };
    default:
      return { label: direction === 'INBOUND' ? t('v.truck.unloading') : t('v.truck.loading'), tone: 'ok' };
  }
}

/** Bảng vận hành 2D (FR-11.03) như video: Docks x/y · Forklifts x/y · Trucks n — click dòng mở inspector (AC-05). */
export function OpsTable({ snapshot, expanded = false }: { snapshot: SiteSnapshot; expanded?: boolean }) {
  const { t } = useTranslation();
  const select = useScene((s) => s.select);
  const selection = useScene((s) => s.selection);
  const siteId = snapshot.site.id;
  const site = snapshot.site;
  const trucksById = new Map(snapshot.trucks.map((tr) => [tr.visitId, tr]));
  const shipmentByVisit = new Map(snapshot.activeShipments.filter((s) => s.visitId).map((s) => [s.visitId!, s]));
  const busyDocks = snapshot.docks.filter((d) => d.effectiveStatus === 'OCCUPIED' || d.effectiveStatus === 'RESERVED').length;
  const working = snapshot.forklifts.filter((f) => f.status === 'BUSY' || f.status === 'ASSIGNED').length;
  const enRoute = snapshot.trucks.filter((tr) => tr.status === 'SCHEDULED' && !tr.dockLocationId && (minutesFromNow(tr.etaAt) ?? 99) <= 10);
  const trucks = [...snapshot.trucks.filter((tr) => tr.status !== 'SCHEDULED'), ...snapshot.trucks.filter((tr) => tr.status === 'SCHEDULED' && (minutesFromNow(tr.etaAt) ?? 99) <= 15)];
  const row = (active: boolean) => cn('flex w-full items-center gap-3 rounded-lg px-2 py-[7px] text-left text-[13px] hover:bg-slate-50', active && 'bg-brand-soft/60');
  const dir = (visitId: string) => {
    const s = snapshot.activeShipments.find((x) => x.visitId === visitId);
    return (s?.direction as 'INBOUND' | 'OUTBOUND' | undefined) ?? undefined;
  };

  return (
    <div className={cn('card pointer-events-auto p-3', expanded ? 'w-full' : 'w-[480px]')}>
      <Tabs defaultValue="docks">
        <div className="mb-1.5 flex items-center gap-2">
          <ClipboardList size={18} className="text-brand" />
          <TabsList>
            <TabsTrigger value="docks">
              {t('v.ops.docks')} <span className="ml-1 text-muted">{busyDocks}/{snapshot.docks.length}</span>
            </TabsTrigger>
            <TabsTrigger value="forklifts">
              {t('v.ops.forklifts')} <span className="ml-1 text-muted">{working}/{snapshot.forklifts.length}</span>
            </TabsTrigger>
            <TabsTrigger value="trucks">
              {t('v.ops.trucks')} <span className="ml-1 text-muted">{trucks.length}</span>
            </TabsTrigger>
          </TabsList>
          <span className="ml-auto truncate text-xs font-medium text-muted">{site.name}</span>
        </div>
        <div className={cn('overflow-auto', expanded ? 'max-h-[60vh]' : 'max-h-[150px]')}>
          <TabsContent value="docks">
            {snapshot.docks.map((d) => {
              const truck = d.visitId ? trucksById.get(d.visitId) : snapshot.trucks.find((x) => x.dockLocationId === d.locationId);
              const shipment = truck ? shipmentByVisit.get(truck.visitId) : undefined;
              const state = truck ? truckState(truck.status, dir(truck.visitId), t) : { label: t('v.dock.available'), tone: 'neutral' as BadgeTone };
              return (
                <button key={d.locationId} className={row(selection?.id === d.locationId)} onClick={() => select({ siteId, type: truck ? 'truck' : 'dock', id: truck?.visitId ?? d.locationId })}>
                  <div className="w-14 leading-tight">
                    <div className="font-semibold">{locationLabels.get(d.locationId)?.label ?? d.code}</div>
                    <div className="text-[11px] text-muted">{site.code}</div>
                  </div>
                  <div className="flex-1 truncate">
                    {truck ? (
                      <span>
                        <span className={cn('mr-1.5 inline-block h-2 w-2 rounded-full', DOT[short(truck.carrier)] ?? 'bg-brand')} />
                        {truck.truckCode} · {short(truck.carrier)}
                      </span>
                    ) : (
                      <span className="text-muted">{t('v.ops.noTruck')}</span>
                    )}
                  </div>
                  <Badge tone={state.tone} className="w-[78px] justify-center">
                    {state.label}
                  </Badge>
                  <div className="w-16">{shipment && truck && ['HANDLING', 'AT_DOCK'].includes(truck.status) ? <Progress done={shipment.progress.done} total={shipment.progress.total} /> : truck?.status === 'SCHEDULED' ? <span className="text-xs text-muted">{Math.max(1, minutesFromNow(truck.etaAt) ?? 1)} min</span> : null}</div>
                  <ChevronRight size={14} className="text-muted" />
                </button>
              );
            })}
            {enRoute.map((tr) => (
              <button key={tr.visitId} className={row(selection?.id === tr.visitId)} onClick={() => select({ siteId, type: 'truck', id: tr.visitId })}>
                <div className="w-14 leading-tight">
                  <div className="font-semibold">{t('v.ops.inbound')}</div>
                  <div className="text-[11px] text-muted">{site.code}</div>
                </div>
                <div className="flex-1 truncate">
                  <span className={cn('mr-1.5 inline-block h-2 w-2 rounded-full', DOT[short(tr.carrier)] ?? 'bg-brand')} />
                  {tr.truckCode} · {short(tr.carrier)}
                </div>
                <Badge tone="info" className="w-[78px] justify-center">
                  {t('v.truck.enRoute')}
                </Badge>
                <span className="w-16 text-xs text-muted">{Math.max(1, minutesFromNow(tr.etaAt) ?? 1)} min</span>
                <ChevronRight size={14} className="text-muted" />
              </button>
            ))}
          </TabsContent>
          <TabsContent value="forklifts">
            {snapshot.forklifts.map((f) => {
              const busy = f.status === 'BUSY' || f.status === 'ASSIGNED';
              const label = busy ? (f.taskSummary?.startsWith('Unloading') ? t('v.truck.unloading') : t('v.truck.loading')) : f.status === 'CHARGING' ? t('v.fl.charging') : f.status === 'AVAILABLE' ? t('v.fl.idle') : t(`status.${f.status}`);
              return (
                <button key={f.id} className={row(selection?.id === f.id)} onClick={() => select({ siteId, type: 'forklift', id: f.id })}>
                  <div className="w-14 leading-tight">
                    <div className="font-semibold">{f.code}</div>
                    <div className="text-[11px] text-muted">{site.code}</div>
                  </div>
                  <div className="flex-1 truncate text-muted">{busy ? f.taskSummary : f.status === 'CHARGING' ? 'Charging at bay' : f.status === 'AVAILABLE' ? 'Waiting for work' : f.model}</div>
                  <Badge tone={busy ? 'ok' : f.status === 'CHARGING' ? 'warn' : 'neutral'} className="w-[78px] justify-center">
                    {label}
                  </Badge>
                  {f.batteryPct !== null ? (
                    <div className="w-16">
                      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-ok" style={{ width: `${f.batteryPct}%` }} />
                      </div>
                      <div className="tabular mt-0.5 text-[11px] text-muted">{f.batteryPct}%</div>
                    </div>
                  ) : null}
                  <ChevronRight size={14} className="text-muted" />
                </button>
              );
            })}
          </TabsContent>
          <TabsContent value="trucks">
            {trucks.map((tr) => {
              const dock = tr.dockLocationId ? snapshot.docks.find((d) => d.locationId === tr.dockLocationId) : undefined;
              const shipment = shipmentByVisit.get(tr.visitId);
              const state = truckState(tr.status, dir(tr.visitId), t);
              const atDock = ['HANDLING', 'AT_DOCK', 'READY_TO_LEAVE'].includes(tr.status);
              return (
                <button key={tr.visitId} className={row(selection?.id === tr.visitId)} onClick={() => select({ siteId, type: 'truck', id: tr.visitId })}>
                  <div className="w-[74px] leading-tight">
                    <div className="font-semibold">{tr.truckCode}</div>
                    <div className="text-[11px] text-muted">{short(tr.carrier)}</div>
                  </div>
                  <div className="flex-1 truncate">
                    <span className={cn('mr-1.5 inline-block h-2 w-2 rounded-full', DOT[short(tr.carrier)] ?? 'bg-brand')} />
                    {atDock ? `${site.code} · ${(dock ? locationLabels.get(dock.locationId)?.label : undefined) ?? dock?.code ?? ''}` : `${t('v.truck.to')} ${site.code}`}
                  </div>
                  <Badge tone={state.tone} className="w-[78px] justify-center">
                    {state.label}
                  </Badge>
                  <div className="w-16 text-xs text-muted">
                    {atDock && shipment ? <Progress done={shipment.progress.done} total={shipment.progress.total} /> : tr.status === 'DOCK_ASSIGNED' ? 'docking' : tr.status === 'SCHEDULED' || tr.status === 'AT_GATE' ? `${Math.max(1, minutesFromNow(tr.etaAt) ?? 2)} min` : ''}
                  </div>
                  <ChevronRight size={14} className="text-muted" />
                </button>
              );
            })}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
