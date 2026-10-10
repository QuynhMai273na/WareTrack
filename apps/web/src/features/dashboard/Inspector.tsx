import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SiteSnapshot } from '@waretrack/shared-schemas';
import { ArrowUpRight, BatteryCharging, Car, Crosshair, DoorOpen, Forklift, Truck, Warehouse, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { SkuIcon } from '@/components/SkuIcon';
import { Badge } from '@/components/ui/badge';
import { api, describeError } from '@/lib/api';
import { useAvailability, useEquipment, usePallet, useShipment, useSiteSettings, useSites, useVehicleStay, useVisit, useVisits } from '@/lib/queries';
import { cn, formatTime, minutesFromNow } from '@/lib/utils';
import { locationLabels } from '@/scene/labels';
import { useAuth } from '@/stores/auth';
import { useScene } from '@/stores/scene';
import { STAY_TONE } from '../vehicles/VehiclesPage';

const short = (carrier: string | null | undefined) => (carrier ?? '').split(' ')[0];
type Tone = 'ok' | 'warn' | 'info' | 'bad' | 'neutral';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-line/70 py-[7px] text-[13px] last:border-0">
      <span className="text-muted">{label}</span>
      <span className="font-medium">{children}</span>
    </div>
  );
}

function Header({ icon, kicker, title, sub, onClose, openTo }: { icon: ReactNode; kicker: string; title: string; sub?: string | null; onClose?: () => void; openTo?: string }) {
  const focus = useScene((s) => s.select);
  const selection = useScene((s) => s.selection);
  return (
    <div className="mb-3 flex items-start gap-3">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-soft/70 text-brand">{icon}</div>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-brand">{kicker}</div>
        <div className="truncate text-[17px] font-bold">{title}</div>
        {sub ? <div className="truncate text-xs text-muted">{sub}</div> : null}
      </div>
      <div className="flex gap-1">
        <button className="flex h-7 w-7 items-center justify-center rounded-lg border border-line text-muted hover:bg-slate-50" onClick={() => selection && focus({ ...selection })} aria-label="Focus">
          <Crosshair size={14} />
        </button>
        {openTo ? (
          <Link to={openTo} className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-white hover:bg-brand/90" aria-label="Open">
            <ArrowUpRight size={14} />
          </Link>
        ) : null}
        {onClose ? (
          <button className="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-slate-100" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function StatusLine({ tone, label, text }: { tone: Tone; label: string; text?: string | null }) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <Badge tone={tone} className="px-2.5 py-1 text-[13px]">
        {label}
      </Badge>
      {text ? <span className="truncate text-xs text-muted">{text}</span> : null}
    </div>
  );
}

function Bar({ value, right, color = 'bg-ok' }: { value: number; right?: string; color?: string }) {
  return (
    <div className="mb-2 flex items-center gap-3">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
        <div className={cn('h-full rounded-full', color)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      {right ? <span className="tabular text-xs text-muted">{right}</span> : null}
    </div>
  );
}

/** Xe tải (video: kicker hãng · TRK-2205 · tài xế · biển số · trạng thái · tiến độ · Shipment/Customer/Destination/ETA/Speed/Bay/Cargo). */
function TruckInspector({ snapshot, visitId, timeZone }: { snapshot: SiteSnapshot; visitId: string; timeZone: string }) {
  const { t } = useTranslation();
  const select = useScene((s) => s.select);
  const { data: v } = useVisit(snapshot.site.id, visitId);
  const snap = snapshot.trucks.find((x) => x.visitId === visitId);
  const shipmentRef = snapshot.activeShipments.find((s) => s.visitId === visitId);
  const { data: shipment } = useShipment(snapshot.site.id, shipmentRef?.id);
  if (!snap) return null;
  const site = snapshot.site;
  const dock = snapshot.docks.find((d) => d.locationId === snap.dockLocationId);
  const progress = shipmentRef?.progress ?? { done: 0, total: 0 };
  const inbound = (shipment?.direction ?? v?.direction) === 'INBOUND';
  const etaMin = minutesFromNow(snap.etaAt);
  const workStep = shipment?.steps.find((s) => s.key === (inbound ? 'UNLOADING' : 'LOADING'));
  const doneIn = minutesFromNow(workStep?.eta ?? null);
  let status: { tone: Tone; label: string; text: string; bar: number; right: string };
  switch (snap.status) {
    case 'SCHEDULED':
      status = { tone: 'info', label: t('v.truck.enRoute'), text: `${t('v.truck.to')} ${site.code} · ETA ${Math.max(1, etaMin ?? 1)} min`, bar: Math.max(10, 100 - (etaMin ?? 5) * 12), right: `${Math.max(1, etaMin ?? 1)} min left` };
      break;
    case 'AT_GATE':
    case 'WAITING':
      status = { tone: 'warn', label: t('v.truck.atGate'), text: `${t('v.truck.gateCheck')} · ${site.code}`, bar: 15, right: '' };
      break;
    case 'DOCK_ASSIGNED':
      status = { tone: 'info', label: t('v.truck.docking'), text: `${t('v.truck.reversing')} ${dock?.code ?? ''} · ${site.code}`, bar: 60, right: t('v.truck.approaching') };
      break;
    case 'READY_TO_LEAVE':
      status = { tone: 'ok', label: t('v.truck.departing'), text: `${site.code} · ${dock?.code ?? ''}`, bar: 100, right: `${progress.done}/${progress.total}` };
      break;
    default:
      status = {
        tone: 'ok',
        label: inbound ? t('v.truck.unloading') : t('v.truck.loading'),
        text: `${site.code} · ${dock?.code ?? ''} · ${progress.done}/${progress.total} ${t('v.pallets')}`,
        bar: progress.total ? (progress.done / progress.total) * 100 : 0,
        right: `${progress.done}/${progress.total}`,
      };
  }
  // Tốc độ hiển thị suy ra từ trạng thái (không có GPS — DEC-55)
  const speed = snap.status === 'SCHEDULED' ? 22 : snap.status === 'DOCK_ASSIGNED' ? 6 : 0;
  const eta =
    snap.status === 'SCHEDULED' && snap.etaAt
      ? `${formatTime(snap.etaAt, timeZone)} (${Math.max(1, etaMin ?? 1)} min)`
      : ['HANDLING', 'AT_DOCK'].includes(snap.status) && doneIn !== null
        ? t('v.truck.doneIn', { n: Math.max(1, doneIn) })
        : snap.status === 'DOCK_ASSIGNED'
          ? `${formatTime(new Date(Date.now() + 60_000).toISOString(), timeZone)} (1 min)`
          : '—';
  return (
    <>
      <Header icon={<Truck size={22} />} kicker={v?.truck.carrier?.name ?? snap.carrier ?? 'Carrier'} title={snap.truckCode} sub={`${v?.driver?.fullName ?? '—'} · ${v?.truck.plateNumber ?? snap.plate}`} onClose={() => select(null)} openTo={`/sites/${site.code}/yard`} />
      <StatusLine tone={status.tone} label={status.label} text={status.text} />
      <Bar value={status.bar} right={status.right} color={snap.status === 'SCHEDULED' || snap.status === 'DOCK_ASSIGNED' ? 'bg-brand' : 'bg-ok'} />
      <Row label={t('v.truck.shipment')}>{shipment ? <span className="text-brand">#{shipment.code}</span> : '—'}</Row>
      <Row label={t('v.truck.customer')}>{shipment?.partner?.name ?? '—'}</Row>
      <Row label={t('v.truck.destination')}>{inbound ? `${site.code} ${site.name}` : (shipment?.destinationText ?? '—')}</Row>
      <Row label="ETA">{eta}</Row>
      <Row label={t('v.truck.speed')}>{speed} km/h</Row>
      <Row label={t('v.truck.bay')}>
        {dock ? (
          <button className="text-brand hover:underline" onClick={() => select({ siteId: site.id, type: 'dock', id: dock.locationId })}>
            {dock.code} · {site.code}
          </button>
        ) : (
          '—'
        )}
      </Row>
      <Row label={t('v.truck.cargo')}>
        {progress.done}/{progress.total || '—'} {t('v.pallets')} · {progress.done ? `${(progress.done * 0.4).toFixed(1)} t` : '0 kg'}
      </Row>
    </>
  );
}

const FORKLIFT_TEXT: Record<string, string> = { CHARGING: 'Charging at bay', AVAILABLE: 'Waiting for work', OFFLINE: 'Off shift', MAINTENANCE: 'Under maintenance' };

function ForkliftInspector({ snapshot, id }: { snapshot: SiteSnapshot; id: string }) {
  const { t } = useTranslation();
  const select = useScene((s) => s.select);
  const f = snapshot.forklifts.find((x) => x.id === id);
  const { data: details } = useEquipment(snapshot.site.id);
  const d = details?.find((x) => x.id === id);
  const [manage, setManage] = useState(false);
  if (!f) return null;
  const busy = f.status === 'BUSY' || f.status === 'ASSIGNED';
  const unloading = f.taskSummary?.startsWith('Unloading');
  const label = busy ? (unloading ? t('v.fl.unloadingTruck') : t('v.fl.loadingTruck')) : f.status === 'CHARGING' ? t('v.fl.charging') : f.status === 'AVAILABLE' ? t('v.fl.idle') : t(`status.${f.status}`);
  const charger = d?.chargerLocationId ? locationLabels.get(d.chargerLocationId) : undefined;
  return (
    <>
      <Header icon={<Forklift size={22} />} kicker={`${t('v.fl.kicker')} · ${snapshot.site.code}`} title={f.code} sub={`${d?.operator ?? '—'} · ${f.model ?? ''}`} onClose={() => select(null)} openTo={`/sites/${snapshot.site.code}/tasks`} />
      <StatusLine tone={busy ? 'ok' : f.status === 'CHARGING' ? 'warn' : 'neutral'} label={label} text={busy ? f.taskSummary : FORKLIFT_TEXT[f.status]} />
      {f.batteryPct !== null ? <Bar value={f.batteryPct} right={`${t('v.fl.battery')} ${f.batteryPct}%`} /> : null}
      <Row label={t('v.fl.carrying')}>{busy && !unloading ? t('v.fl.pallet') : t('v.fl.empty')}</Row>
      <Row label={t('v.fl.moves')}>{d?.movesToday ?? '—'}</Row>
      <Row label={t('v.truck.speed')}>{busy ? `${(d?.speedKmh || 4.5).toFixed(1)} km/h` : '0.0 km/h'}</Row>
      <Row label={t('v.fl.charger')}>
        {d?.chargerLocationId ? (
          <button className="text-brand hover:underline" onClick={() => select({ siteId: snapshot.site.id, type: 'charger', id: d.chargerLocationId! })}>
            {charger?.code ?? '—'}
          </button>
        ) : (
          '—'
        )}
      </Row>
      <Row label={t('v.siteLabel')}>{snapshot.site.name}</Row>
      <button className="mt-2 text-xs font-medium text-brand hover:underline" onClick={() => setManage((m) => !m)}>
        {manage ? t('v.fl.hideActions') : t('v.fl.manage')}
      </button>
      {manage ? <ForkliftActions siteId={snapshot.site.id} id={f.id} status={f.status} version={f.version} /> : null}
    </>
  );
}

const EQUIPMENT_NEXT: Record<string, string[]> = {
  AVAILABLE: ['CHARGING', 'OFFLINE', 'MAINTENANCE'],
  CHARGING: ['AVAILABLE', 'MAINTENANCE'],
  OFFLINE: ['AVAILABLE', 'MAINTENANCE'],
  ASSIGNED: ['MAINTENANCE'],
  BUSY: ['MAINTENANCE'],
  MAINTENANCE: ['AVAILABLE'],
};

/** Đổi trạng thái thủ công (#158, mục 9.7) và nhập pin (#159, DEC-55 — chưa có cảm biến). */
function ForkliftActions({ siteId, id, status, version }: { siteId: string; id: string; status: string; version: number }) {
  const { t } = useTranslation();
  const can = useAuth((s) => s.can);
  const qc = useQueryClient();
  const [battery, setBattery] = useState('');
  const run = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) => api(`/sites/${siteId}/equipment/${id}/${path}`, { method: 'POST', body }),
    onSuccess: () => {
      setBattery('');
      void qc.invalidateQueries({ queryKey: ['site', siteId, 'equipment'] });
    },
  });
  if (!can(siteId, 'equipment.status.update')) return null;
  const next = (EQUIPMENT_NEXT[status] ?? []).filter((s) => s !== 'MAINTENANCE' || can(siteId, 'equipment.manage'));
  return (
    <div className="mt-2 space-y-2 border-t border-line pt-2">
      <div className="flex flex-wrap gap-1.5">
        {next.map((s) => (
          <button
            key={s}
            disabled={run.isPending}
            onClick={() => {
              const reason = s === 'MAINTENANCE' ? window.prompt(t('yard.reason')) : undefined;
              if (s === 'MAINTENANCE' && !reason) return;
              run.mutate({ path: 'status', body: { toStatus: s, ...(reason ? { reason } : {}), expectedVersion: version } });
            }}
            className={cn('rounded-lg border px-2.5 py-1 text-xs font-medium hover:border-brand', s === 'MAINTENANCE' ? 'border-bad/40 text-bad' : 'border-line')}
          >
            {t(`inspector.toStatus.${s}`)}
          </button>
        ))}
      </div>
      <form className="flex gap-1.5" onSubmit={(e) => (e.preventDefault(), battery && run.mutate({ path: 'telemetry', body: { batteryPct: Number(battery) } }))}>
        <input className="h-8 w-24 rounded-lg border border-line px-2 text-xs outline-none focus:border-brand" inputMode="numeric" placeholder={`${t('inspector.battery')} %`} value={battery} onChange={(e) => setBattery(e.target.value.replace(/\D/g, '').slice(0, 3))} />
        <button type="submit" className="rounded-lg bg-brand-soft px-2.5 text-xs font-medium text-brand" disabled={!battery || run.isPending}>
          {t('inspector.updateBattery')}
        </button>
      </form>
      {run.isError ? <p className="rounded-lg bg-bad-soft px-2 py-1.5 text-xs text-bad">{describeError(run.error)}</p> : null}
    </div>
  );
}

const LIFECYCLE_LABEL: Record<string, string> = { STAGED: 'Staged', IN_STOCK: 'In stock', RECEIVING: 'Receiving', PICKED: 'Picked', LOADED: 'Loaded', DISPATCHED: 'Dispatched' };

/** Pallet (video: "PALLET · PPE · Safety Helmet · PAL-1026 · PPE-HLM-Y · Staged · WH-01 · Yard slot S01"). */
function PalletInspector({ snapshot, id, timeZone }: { snapshot: SiteSnapshot; id: string; timeZone: string }) {
  const { t } = useTranslation();
  const select = useScene((s) => s.select);
  const { data: hu } = usePallet(snapshot.site.id, id);
  const snap = snapshot.pallets.find((p) => p.id === id);
  if (!hu && !snap) return null;
  const c = hu?.contents[0];
  const loc = hu?.location ? `${snapshot.site.code} · ${hu.location.name ?? locationLabels.get(hu.location.id)?.label ?? hu.location.code}` : '—';
  const received = c?.receivedAt ? `${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(new Date(c.receivedAt))}, ${formatTime(c.receivedAt, timeZone)}` : '—';
  const lifecycle = hu?.lifecycle ?? snap?.lifecycle ?? '';
  return (
    <>
      <Header icon={<SkuIcon code={c?.sku.code ?? ''} size={30} />} kicker={`${t('v.pallet.kicker')} · ${(c?.sku.category ?? 'General').toUpperCase()}`} title={c?.sku.name ?? snap?.label ?? ''} sub={`${hu?.code ?? snap?.code} · ${c?.sku.code ?? ''}`} onClose={() => select(null)} openTo={`/sites/${snapshot.site.code}/inventory`} />
      <StatusLine tone={lifecycle === 'STAGED' ? 'ok' : 'info'} label={LIFECYCLE_LABEL[lifecycle] ?? lifecycle} text={loc} />
      <Row label={t('v.pallet.qty')}>
        {c ? Number(c.qtyOnHand).toLocaleString('en-US') : '—'} {t('v.units')}
      </Row>
      <Row label={t('v.pallet.weight')}>{hu?.grossWeightKg ? `${Math.round(hu.grossWeightKg)} kg` : '—'}</Row>
      <Row label={t('v.pallet.location')}>{loc}</Row>
      <Row label={t('v.pallet.lot')}>{c?.lotNumber ?? '—'}</Row>
      <Row label={t('v.pallet.received')}>{received}</Row>
      <Row label={t('v.siteLabel')}>{snapshot.site.name}</Row>
    </>
  );
}

/** Dock (video: "DOCK BAY · In 2 · Dock door with leveller · Booked · TRK-2481 due in 3 min"). */
function DockInspector({ snapshot, id }: { snapshot: SiteSnapshot; id: string }) {
  const { t } = useTranslation();
  const select = useScene((s) => s.select);
  const dock = snapshot.docks.find((d) => d.locationId === id);
  const { data: visits } = useVisits(snapshot.site.id);
  if (!dock) return null;
  const truck = snapshot.trucks.find((x) => x.dockLocationId === id);
  const since = Date.now() - 12 * 3600_000;
  const trucksToday = visits?.filter((v) => v.dock?.id === id && v.arrivedAt && new Date(v.arrivedAt).getTime() > since).length ?? 0;
  const eta = truck?.etaAt ? minutesFromNow(truck.etaAt) : null;
  const status: { tone: Tone; label: string; text: string } =
    dock.effectiveStatus === 'RESERVED'
      ? { tone: 'warn', label: t('v.dock.booked'), text: truck ? `${truck.truckCode} ${t('v.dock.dueIn', { n: Math.max(1, eta ?? 3) })}` : '' }
      : dock.effectiveStatus === 'OCCUPIED'
        ? { tone: 'ok', label: t('v.dock.busy'), text: truck ? `${truck.truckCode} · ${t(`status.${truck.status}`)}` : '' }
        : dock.effectiveStatus === 'OUT_OF_SERVICE'
          ? { tone: 'bad', label: t('status.OUT_OF_SERVICE'), text: '' }
          : { tone: 'neutral', label: t('v.dock.available'), text: t('v.dock.ready') };
  return (
    <>
      <Header icon={<DoorOpen size={22} />} kicker={`${t('v.dock.kicker')} · ${snapshot.site.code}`} title={dock.code} sub={t('v.dock.leveller')} onClose={() => select(null)} />
      <StatusLine tone={status.tone} label={status.label} text={status.text} />
      <Row label={t('v.dock.truck')}>
        {truck ? (
          <button className="text-brand hover:underline" onClick={() => select({ siteId: snapshot.site.id, type: 'truck', id: truck.visitId })}>
            {truck.truckCode} · {short(truck.carrier)}
          </button>
        ) : (
          '—'
        )}
      </Row>
      <Row label={t('v.dock.rearDoors')}>{dock.effectiveStatus === 'OCCUPIED' ? t('v.dock.open') : '—'}</Row>
      <Row label={t('v.dock.trucksToday')}>{trucksToday}</Row>
      <Row label={t('v.siteLabel')}>{snapshot.site.name}</Row>
    </>
  );
}

/** Trạm sạc (video: "CHARGER · C1 · 48 V lithium-ion forklift charger · Free · FL-10 is out"). Số phiên/điện năng là ước tính (DEC-55). */
function ChargerInspector({ snapshot, id }: { snapshot: SiteSnapshot; id: string }) {
  const { t } = useTranslation();
  const select = useScene((s) => s.select);
  const { data: details } = useEquipment(snapshot.site.id);
  const owner = details?.find((d) => d.chargerLocationId === id);
  const f = owner ? snapshot.forklifts.find((x) => x.id === owner.id) : undefined;
  const code = locationLabels.get(id)?.code ?? '—';
  const charging = f?.status === 'CHARGING';
  const sessions = owner ? 3 + (owner.movesToday % 6) : 0;
  return (
    <>
      <Header icon={<BatteryCharging size={22} />} kicker={`${t('v.charger.kicker')} · ${snapshot.site.code}`} title={code} sub={t('v.charger.model')} onClose={() => select(null)} />
      <StatusLine tone={charging ? 'warn' : 'neutral'} label={charging ? t('v.fl.charging') : t('v.charger.free')} text={f ? (charging ? `${f.code} · ${f.batteryPct ?? 0}%` : `${f.code} ${t('v.charger.isOut')} · ${f.taskSummary ?? t('v.fl.idle')}`) : ''} />
      <Row label={t('v.charger.forklift')}>
        {f ? (
          <button className="text-brand hover:underline" onClick={() => select({ siteId: snapshot.site.id, type: 'forklift', id: f.id })}>
            {f.code} · {t('v.fl.battery').toLowerCase()} {f.batteryPct ?? 0}%
          </button>
        ) : (
          '—'
        )}
      </Row>
      <Row label={t('v.charger.sessions')}>{sessions}</Row>
      <Row label={t('v.charger.energy')}>{(sessions * 5.73).toFixed(1)} kWh</Row>
      <Row label={t('v.charger.rate')}>{t('v.charger.rateValue')}</Row>
      <Row label={t('v.siteLabel')}>{snapshot.site.name}</Row>
    </>
  );
}

const SITE_KICKER: Record<string, string> = { DEPOT: 'Depot', DISTRIBUTION_CENTER: 'Distribution center', COLD_STORE: 'Cold store', CROSS_DOCK: 'Cross-dock', AUTOMATED_DC: 'Automated DC', VEHICLE_YARD: 'Vehicle yard', MIXED: 'Mixed site' };

/** Panel site (video: "DEPOT · WH-01 · Riverside Hub · Operational · 1 docked · 1 arriving · 3 staged …"). */
function SiteInspector({ snapshot }: { snapshot: SiteSnapshot }) {
  const { t } = useTranslation();
  const select = useScene((s) => s.select);
  const { data: sites } = useSites();
  const can = useAuth((s) => s.can);
  const { data: availability } = useAvailability(can(snapshot.site.id, 'inventory.read') ? snapshot.site.id : undefined);
  const { data: settings } = useSiteSettings(snapshot.site.id);
  const site = sites?.find((s) => s.id === snapshot.site.id);
  const k = (key: string) => snapshot.kpis.find((x) => x.key === key);
  const docked = snapshot.trucks.filter((x) => x.status === 'AT_DOCK' || x.status === 'HANDLING').length;
  const arriving = snapshot.trucks.filter((x) => x.status === 'SCHEDULED' && (minutesFromNow(x.etaAt) ?? 99) <= 15).length;
  // "staged" = pallet chờ xuất ở làn staging (không tính kho bãi ngoài trời "Yard …")
  const staged = snapshot.pallets.filter((p) => p.lifecycle === 'STAGED' && p.position?.locationId && !(locationLabels.get(p.position.locationId)?.label ?? '').startsWith('Yard')).length;
  const working = snapshot.forklifts.filter((f) => f.status === 'BUSY' || f.status === 'ASSIGNED');
  const busyDocks = snapshot.docks.filter((d) => d.effectiveStatus === 'OCCUPIED' || d.effectiveStatus === 'RESERVED').length;
  const stock = k('STOCK_ON_HAND_PALLETS');
  const vehicles = k('VEHICLES_STORED');
  const featured = settings?.dashboardSkus?.length
    ? settings.dashboardSkus.map((c) => availability?.find((a) => a.sku.code === c)).filter((a): a is NonNullable<typeof a> => !!a)
    : (availability ?? []).slice(0, 4);
  const tile = (label: string, value: ReactNode, unit?: string, bar?: number) => (
    <div className="rounded-xl bg-slate-50 px-3 py-2.5">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="tabular text-[15px] font-bold">
        {value} {unit ? <span className="text-xs font-normal text-muted">{unit}</span> : null}
      </div>
      {bar !== undefined ? (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-200">
          <div className={cn('h-full rounded-full', bar >= 99 ? 'bg-ok' : 'bg-brand')} style={{ width: `${Math.min(100, bar)}%` }} />
        </div>
      ) : null}
    </div>
  );
  return (
    <>
      <div className="mb-3 flex items-start gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-soft/70 text-brand">
          <Warehouse size={22} />
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-brand">
            {SITE_KICKER[snapshot.site.siteType] ?? snapshot.site.siteType} · {snapshot.site.code}
          </div>
          <div className="truncate text-[17px] font-bold">{snapshot.site.name}</div>
          <div className="truncate text-xs text-muted">{site?.addressLine}</div>
        </div>
        <button className="flex h-7 w-7 items-center justify-center rounded-lg border border-line text-muted hover:bg-slate-50" onClick={() => select(null)} aria-label="Focus">
          <Crosshair size={14} />
        </button>
      </div>
      <div className="mb-3 flex items-center gap-2 text-xs">
        <Badge tone="ok" className="px-2.5 py-1 text-[13px]">
          {t('v.site.operational')}
        </Badge>
        <span className="text-muted">
          {t('v.site.docked', { n: docked })} · {t('v.site.arriving', { n: arriving })} · {t('v.site.staged', { n: staged })}
        </span>
      </div>
      {vehicles ? (
        <div className="grid grid-cols-2 gap-2">
          {tile(t('kpi.VEHICLES_STORED'), vehicles.value ?? 0)}
          {tile(t('kpi.YARD_OCCUPANCY'), `${k('YARD_OCCUPANCY')?.sub?.used ?? 0} / ${k('YARD_OCCUPANCY')?.total ?? 0}`, undefined, k('YARD_OCCUPANCY')?.value ?? 0)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {tile(t('v.site.stock'), (stock?.value ?? 0).toLocaleString('en-US'), `/ ${(stock?.total ?? 0).toLocaleString('en-US')}`, stock?.total ? ((stock.value ?? 0) / stock.total) * 100 : 0)}
          {tile(t('v.site.bays'), busyDocks, `/ ${snapshot.docks.length} ${t('v.site.busy')}`, snapshot.docks.length ? (busyDocks / snapshot.docks.length) * 100 : 0)}
          {tile(t('v.site.outboundToday'), k('OUTBOUND_TODAY')?.value ?? 0, t('v.site.trucks'))}
          {tile(t('v.site.putaways'), k('PUTAWAY_COMPLETED')?.value ?? 0, t('v.pallets'))}
        </div>
      )}
      {featured.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-xs">
            <span className="font-semibold">{t('v.site.inventory')}</span>
            <span className="text-muted">{t('v.units')}</span>
          </div>
          {featured.map((a) => (
            <div key={a.sku.id} className="flex items-center gap-2.5 py-[5px] text-[13px]">
              <SkuIcon code={a.sku.code} size={20} />
              <span className="flex-1 truncate">{a.sku.name}</span>
              <span className="tabular w-14 text-right font-semibold">{Number(a.available).toLocaleString('en-US')}</span>
              <Badge tone={a.lowStock ? 'warn' : 'ok'} className="w-[74px] justify-center">
                {a.lowStock ? t('v.site.lowStock') : t('v.site.inStock')}
              </Badge>
            </div>
          ))}
        </div>
      ) : null}
      {snapshot.forklifts.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-xs">
            <span className="font-semibold">{t('v.site.fleet')}</span>
            <span className="text-muted">{t('v.site.working', { n: working.length, t: snapshot.forklifts.length })}</span>
          </div>
          {working.slice(0, 1).map((f) => (
            <button key={f.id} onClick={() => select({ siteId: snapshot.site.id, type: 'forklift', id: f.id })} className="flex w-full items-center gap-2 py-1 text-left text-[13px]">
              <span className="w-12 font-semibold">{f.code}</span>
              <span className="flex-1 truncate text-muted">{f.taskSummary}</span>
              <span className="h-1.5 w-12 overflow-hidden rounded-full bg-slate-100">
                <span className="block h-full rounded-full bg-ok" style={{ width: `${f.batteryPct ?? 0}%` }} />
              </span>
              <span className="tabular w-8 text-right text-xs text-muted">{f.batteryPct ?? '—'}%</span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** Xe lưu bãi chọn từ bản đồ (UC-04 → UC-07). */
function VehicleInspector({ snapshot, id, timeZone }: { snapshot: SiteSnapshot; id: string; timeZone: string }) {
  const { t } = useTranslation();
  const select = useScene((s) => s.select);
  const { data: stay } = useVehicleStay(snapshot.site.id, id);
  const snap = snapshot.vehicles.find((v) => v.stayId === id);
  if (!stay && !snap) return null;
  const status = stay?.status ?? snap!.status;
  return (
    <>
      <Header icon={<Car size={22} />} kicker={`${t('nav.vehicles')} · ${snapshot.site.code}`} title={stay?.vehicle.vin ?? snap!.vin} sub={stay ? [stay.vehicle.modelYear, stay.vehicle.make, stay.vehicle.model].filter(Boolean).join(' ') : snap?.label} onClose={() => select(null)} openTo={`/sites/${snapshot.site.code}/vehicles?stay=${id}`} />
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Badge tone={STAY_TONE[status] ?? 'neutral'}>{t(`vehicles.status.${status}`)}</Badge>
        {(stay?.holdFlag ?? snap?.hold) ? <Badge tone="bad">{t('vehicles.onHold')}</Badge> : null}
      </div>
      <Row label={t('vehicles.position')}>{stay?.position.location?.code ?? '—'}</Row>
      <Row label={t('inspector.source')}>{stay?.position.source ? `${t(`source.${stay.position.source}`)} · ${formatTime(stay.position.confirmedAt!, timeZone)}` : '—'}</Row>
      <Row label={t('vehicles.plate')}>{stay?.vehicle.plateNumber ?? '—'}</Row>
      <Row label={t('vehicles.keyTag')}>{stay?.keyTag ?? '—'}</Row>
    </>
  );
}

/** Inspector đọc Business State (TanStack Query) theo selection (Zustand) — mục 18.4, UC-20. */
export function Inspector({ snapshot, timeZone }: { snapshot: SiteSnapshot; timeZone: string }) {
  const selection = useScene((s) => s.selection);
  const sel = selection?.siteId === snapshot.site.id ? selection : null;
  return (
    <div className="card pointer-events-auto w-[376px] p-4">
      {sel?.type === 'truck' ? (
        <TruckInspector snapshot={snapshot} visitId={sel.id} timeZone={timeZone} />
      ) : sel?.type === 'forklift' ? (
        <ForkliftInspector snapshot={snapshot} id={sel.id} />
      ) : sel?.type === 'pallet' ? (
        <PalletInspector snapshot={snapshot} id={sel.id} timeZone={timeZone} />
      ) : sel?.type === 'dock' ? (
        <DockInspector snapshot={snapshot} id={sel.id} />
      ) : sel?.type === 'charger' ? (
        <ChargerInspector snapshot={snapshot} id={sel.id} />
      ) : sel?.type === 'vehicle' ? (
        <VehicleInspector snapshot={snapshot} id={sel.id} timeZone={timeZone} />
      ) : (
        <SiteInspector snapshot={snapshot} />
      )}
    </div>
  );
}
