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
function truckState(status: string, direction: 'INBOUND' | 'OUTBOUND' | undefined, t: (key: string) => string): { label: string; tone: BadgeTone } {
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
  const select = useScene((state) => state.select);
  const selection = useScene((state) => state.selection);
  const siteId = snapshot.site.id;
  const site = snapshot.site;
  const trucksById = new Map(snapshot.trucks.map((truck) => [truck.visitId, truck]));
  const shipmentByVisit = new Map(snapshot.activeShipments.filter((shipment) => shipment.visitId).map((shipment) => [shipment.visitId!, shipment]));
  const busyDocks = snapshot.docks.filter((dock) => dock.effectiveStatus === 'OCCUPIED' || dock.effectiveStatus === 'RESERVED').length;
  const working = snapshot.forklifts.filter((forklift) => forklift.status === 'BUSY' || forklift.status === 'ASSIGNED').length;
  const enRoute = snapshot.trucks.filter((truck) => truck.status === 'SCHEDULED' && !truck.dockLocationId && (minutesFromNow(truck.etaAt) ?? 99) <= 10);
  const trucks = [...snapshot.trucks.filter((truck) => truck.status !== 'SCHEDULED'), ...snapshot.trucks.filter((truck) => truck.status === 'SCHEDULED' && (minutesFromNow(truck.etaAt) ?? 99) <= 15)];
  const row = (active: boolean) => cn('flex w-full items-center gap-3 rounded-lg px-2 py-[7px] text-left text-[13px] hover:bg-slate-50', active && 'bg-brand-soft/60');
  const dir = (visitId: string) => {
    const shipment = snapshot.activeShipments.find((candidate) => candidate.visitId === visitId);
    return (shipment?.direction as 'INBOUND' | 'OUTBOUND' | undefined) ?? undefined;
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
            {snapshot.docks.map((dock) => {
              const truck = dock.visitId ? trucksById.get(dock.visitId) : snapshot.trucks.find((candidate) => candidate.dockLocationId === dock.locationId);
              const shipment = truck ? shipmentByVisit.get(truck.visitId) : undefined;
              const state = truck ? truckState(truck.status, dir(truck.visitId), t) : { label: t('v.dock.available'), tone: 'neutral' as BadgeTone };
              return (
                <button key={dock.locationId} className={row(selection?.id === dock.locationId)} onClick={() => select({ siteId, type: truck ? 'truck' : 'dock', id: truck?.visitId ?? dock.locationId })}>
                  <div className="w-14 leading-tight">
                    <div className="font-semibold">{locationLabels.get(dock.locationId)?.label ?? dock.code}</div>
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
            {enRoute.map((truck) => (
              <button key={truck.visitId} className={row(selection?.id === truck.visitId)} onClick={() => select({ siteId, type: 'truck', id: truck.visitId })}>
                <div className="w-14 leading-tight">
                  <div className="font-semibold">{t('v.ops.inbound')}</div>
                  <div className="text-[11px] text-muted">{site.code}</div>
                </div>
                <div className="flex-1 truncate">
                  <span className={cn('mr-1.5 inline-block h-2 w-2 rounded-full', DOT[short(truck.carrier)] ?? 'bg-brand')} />
                  {truck.truckCode} · {short(truck.carrier)}
                </div>
                <Badge tone="info" className="w-[78px] justify-center">
                  {t('v.truck.enRoute')}
                </Badge>
                <span className="w-16 text-xs text-muted">{Math.max(1, minutesFromNow(truck.etaAt) ?? 1)} min</span>
                <ChevronRight size={14} className="text-muted" />
              </button>
            ))}
          </TabsContent>
          <TabsContent value="forklifts">
            {snapshot.forklifts.map((forklift) => {
              const busy = forklift.status === 'BUSY' || forklift.status === 'ASSIGNED';
              const label = busy ? (forklift.taskSummary?.startsWith('Unloading') ? t('v.truck.unloading') : t('v.truck.loading')) : forklift.status === 'CHARGING' ? t('v.fl.charging') : forklift.status === 'AVAILABLE' ? t('v.fl.idle') : t(`status.${forklift.status}`);
              return (
                <button key={forklift.id} className={row(selection?.id === forklift.id)} onClick={() => select({ siteId, type: 'forklift', id: forklift.id })}>
                  <div className="w-14 leading-tight">
                    <div className="font-semibold">{forklift.code}</div>
                    <div className="text-[11px] text-muted">{site.code}</div>
                  </div>
                  <div className="flex-1 truncate text-muted">{busy ? forklift.taskSummary : forklift.status === 'CHARGING' ? 'Charging at bay' : forklift.status === 'AVAILABLE' ? 'Waiting for work' : forklift.model}</div>
                  <Badge tone={busy ? 'ok' : forklift.status === 'CHARGING' ? 'warn' : 'neutral'} className="w-[78px] justify-center">
                    {label}
                  </Badge>
                  {forklift.batteryPct !== null ? (
                    <div className="w-16">
                      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-ok" style={{ width: `${forklift.batteryPct}%` }} />
                      </div>
                      <div className="tabular mt-0.5 text-[11px] text-muted">{forklift.batteryPct}%</div>
                    </div>
                  ) : null}
                  <ChevronRight size={14} className="text-muted" />
                </button>
              );
            })}
          </TabsContent>
          <TabsContent value="trucks">
            {trucks.map((truck) => {
              const dock = truck.dockLocationId ? snapshot.docks.find((candidate) => candidate.locationId === truck.dockLocationId) : undefined;
              const shipment = shipmentByVisit.get(truck.visitId);
              const state = truckState(truck.status, dir(truck.visitId), t);
              const atDock = ['HANDLING', 'AT_DOCK', 'READY_TO_LEAVE'].includes(truck.status);
              return (
                <button key={truck.visitId} className={row(selection?.id === truck.visitId)} onClick={() => select({ siteId, type: 'truck', id: truck.visitId })}>
                  <div className="w-[74px] leading-tight">
                    <div className="font-semibold">{truck.truckCode}</div>
                    <div className="text-[11px] text-muted">{short(truck.carrier)}</div>
                  </div>
                  <div className="flex-1 truncate">
                    <span className={cn('mr-1.5 inline-block h-2 w-2 rounded-full', DOT[short(truck.carrier)] ?? 'bg-brand')} />
                    {atDock ? `${site.code} · ${(dock ? locationLabels.get(dock.locationId)?.label : undefined) ?? dock?.code ?? ''}` : `${t('v.truck.to')} ${site.code}`}
                  </div>
                  <Badge tone={state.tone} className="w-[78px] justify-center">
                    {state.label}
                  </Badge>
                  <div className="w-16 text-xs text-muted">
                    {atDock && shipment ? <Progress done={shipment.progress.done} total={shipment.progress.total} /> : truck.status === 'DOCK_ASSIGNED' ? 'docking' : truck.status === 'SCHEDULED' || truck.status === 'AT_GATE' ? `${Math.max(1, minutesFromNow(truck.etaAt) ?? 2)} min` : ''}
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
