import type { SiteSnapshot, TrackingStep } from '@waretrack/shared-schemas';
import { Check, ChevronRight, ClipboardList, Package, PackageCheck, Truck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useShipment } from '@/lib/queries';
import { cn, formatTime, minutesFromNow } from '@/lib/utils';
import { useScene } from '@/stores/scene';

const STEP_ICON: Record<string, ReactNode> = {
  ORDER_CONFIRMED: <ClipboardList size={15} />,
  PICKED: <Package size={15} />,
  LOADING: <PackageCheck size={15} />,
  LOADED: <PackageCheck size={15} />,
  UNLOADING: <Check size={15} />,
  IN_TRANSIT: <Truck size={15} />,
  DELIVERED: <Check size={15} />,
};

/** Hình xe tải nhỏ trong thẻ shipment (video). */
function TruckGlyph() {
  return (
    <svg width="58" height="40" viewBox="0 0 58 40" aria-hidden>
      <path fill="#e9eef8" d="M4 30 30 18v-12L4 18z" />
      <path fill="#ffffff" stroke="#c9d3e8" d="M6 8 32 0v18L6 28z" />
      <path fill="#2f6fe4" d="M32 10 46 14v12l-14 4z" />
      <path fill="#1f2a44" d="M38 14l6 2v5l-6-2z" />
      <circle cx="12" cy="31" r="3.2" fill="#1b1f2a" />
      <circle cx="36" cy="33" r="3.2" fill="#1b1f2a" />
      <path fill="#2f6fe4" d="M10 14l14-5v3l-14 5z" />
    </svg>
  );
}

interface UiStep {
  key: string;
  label: string;
  state: 'done' | 'current' | 'pending';
  time: string;
  icon: ReactNode;
}

function Stepper({ steps }: { steps: UiStep[] }) {
  return (
    <div className="flex flex-1 items-start">
      {steps.map((s, i) => (
        <div key={s.key} className="relative flex flex-1 flex-col items-center text-center">
          {i > 0 ? <div className={cn('absolute right-1/2 top-[17px] h-[3px] w-full -translate-y-1/2', s.state === 'pending' ? 'bg-slate-200' : 'bg-brand')} /> : null}
          <div
            className={cn(
              'relative z-10 flex h-[34px] w-[34px] items-center justify-center rounded-full border-2',
              s.state === 'done' && 'border-brand bg-brand text-white',
              s.state === 'current' && 'border-brand bg-brand text-white ring-[5px] ring-brand-soft',
              s.state === 'pending' && 'border-slate-200 bg-slate-50 text-slate-400',
            )}
          >
            {s.icon}
          </div>
          <div className="mt-2 text-[12px] font-medium">{s.label}</div>
          <div className="tabular text-[11px] text-muted">{s.time}</div>
        </div>
      ))}
    </div>
  );
}

/** Shipment Tracking như video — milestone thật từ backend, ETA ghi rõ là ETA (UC-19-AC2, BR-30). */
function ShipmentTracker({ siteId, shipmentId, timeZone, siteCode, siteName }: { siteId: string; shipmentId: string; timeZone: string; siteCode: string; siteName: string }) {
  const { t } = useTranslation();
  const { data: s } = useShipment(siteId, shipmentId);
  if (!s) return null;
  const toUi = (st: TrackingStep): UiStep => ({
    key: st.key,
    label: `${t(`v.steps.${st.key}`)}${st.progress && (st.state === 'CURRENT' || st.key === 'LOADING' || st.key === 'UNLOADING') && st.state !== 'PENDING' ? ` ${st.progress.done}/${st.progress.total}` : ''}`,
    state: st.state === 'DONE' ? 'done' : st.state === 'CURRENT' ? 'current' : 'pending',
    time: st.at && st.state === 'DONE' ? formatTime(st.at, timeZone) : st.eta ? `ETA ${formatTime(st.eta, timeZone)}` : st.at ? formatTime(st.at, timeZone) : '—',
    icon: STEP_ICON[st.key] ?? <Package size={15} />,
  });
  const work = s.steps.find((x) => x.key === (s.direction === 'OUTBOUND' ? 'LOADING' : 'UNLOADING'));
  const left = minutesFromNow(work?.eta ?? null);
  const statusLabel = s.status === 'LOADING' ? t('v.truck.loading') : s.status === 'UNLOADING' || s.status === 'ARRIVED' ? t('v.truck.unloading') : s.status === 'EXPECTED' ? t('v.truck.enRoute') : t(`shipmentStatus.${s.status}`);
  return (
    <div className="card pointer-events-auto w-[956px] max-w-[calc(100vw-560px)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[15px] font-semibold">
          <Truck size={19} className="text-brand" /> {t('v.tracking.title')}
        </div>
        <div className="text-xs text-muted">
          {s.visit?.truckCode ?? '—'} · {(s.carrier?.name ?? '').split(' ')[0]}
        </div>
      </div>
      <div className="flex items-center gap-4">
        <Stepper steps={s.steps.map(toUi)} />
        <div className="flex w-[284px] items-center gap-3 rounded-xl bg-slate-50 p-3 text-xs">
          <TruckGlyph />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold">#{s.code}</div>
            <div className="truncate text-muted">{s.direction === 'OUTBOUND' ? `To: ${s.destinationText ?? '—'}` : `To: ${siteCode} ${siteName}`}</div>
            <div className="mt-1 inline-block rounded-md bg-ok-soft px-1.5 py-0.5 font-medium text-ok">{statusLabel}</div>
            <div className="mt-1 truncate text-muted">
              {siteCode} · {s.visit?.dockCode ?? '—'}
              {left !== null && left > 0 && !['DISPATCHED', 'DELIVERED', 'RECEIVED', 'CLOSED'].includes(s.status) ? ` · ${left} min left` : ''}
            </div>
          </div>
          <ChevronRight size={16} className="text-muted" />
        </div>
      </div>
    </div>
  );
}

/** Ưu tiên shipment của xe đang chọn; không có thì shipment đang xếp/dỡ của site (FR-10.04). */
export function Tracker({ snapshot, timeZone }: { snapshot: SiteSnapshot; timeZone: string }) {
  const { t } = useTranslation();
  const selection = useScene((s) => s.selection);
  const siteId = snapshot.site.id;
  const selectedVisit = selection?.type === 'truck' && selection.siteId === siteId ? selection.id : undefined;
  const handling = new Set(snapshot.trucks.filter((x) => x.status === 'HANDLING').map((x) => x.visitId));
  const shipment = selectedVisit
    ? snapshot.activeShipments.find((s) => s.visitId === selectedVisit)
    : (snapshot.activeShipments.find((s) => s.visitId && handling.has(s.visitId) && s.status === 'LOADING') ??
      snapshot.activeShipments.find((s) => s.visitId && handling.has(s.visitId)) ??
      snapshot.activeShipments.find((s) => ['LOADING', 'UNLOADING'].includes(s.status)) ??
      snapshot.activeShipments[0]);
  if (shipment) return <ShipmentTracker siteId={siteId} shipmentId={shipment.id} timeZone={timeZone} siteCode={snapshot.site.code} siteName={snapshot.site.name} />;
  return (
    <div className="card pointer-events-auto flex w-[600px] items-center gap-3 p-4 text-sm text-muted">
      <Truck size={18} className="text-brand" /> {t('tracking.selectTruck')}
    </div>
  );
}
