import type { KpiDto } from '@waretrack/shared-schemas';
import { ArrowUp, Car, Clock3, LogOut, ParkingSquare, Truck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** Biểu tượng khối hộp xanh như video (Stock on hand). */
function CubeIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
      <path fill="#2f6fe4" d="M16 3 28 9.5v13L16 29 4 22.5v-13z" />
      <path fill="#5b8ff0" d="M16 3 28 9.5 16 16 4 9.5z" />
      <path fill="#1f4fb8" d="M16 16v13l12-6.5v-13z" />
    </svg>
  );
}

const ICONS: Record<string, ReactNode> = {
  STOCK_ON_HAND_PALLETS: <CubeIcon />,
  TRUCKS_ON_SITE: <Truck size={22} className="text-brand" />,
  ON_TIME_DELIVERY: <Clock3 size={22} className="text-brand" />,
  YARD_OCCUPANCY: <ParkingSquare size={22} className="text-brand" />,
  VEHICLES_STORED: <Car size={22} className="text-brand" />,
  VEHICLE_RELEASES: <LogOut size={22} className="text-brand" />,
};

/** Ba ô KPI như video: Stock on hand · Trucks on site · On-time delivery (FR-11.02, BR-31). */
const SLOTS = ['STOCK_ON_HAND_PALLETS', 'TRUCKS_ON_SITE', 'ON_TIME_DELIVERY'];
const VEHICLE_SLOTS = ['VEHICLES_STORED', 'YARD_OCCUPANCY', 'VEHICLE_RELEASES'];

function formatValue(k: KpiDto) {
  if (k.value === null) return 'N/A';
  if (k.unit === '%') return `${k.value.toFixed(1)}%`;
  return k.value.toLocaleString('en-US');
}

export function KpiBar({ kpis, siteCode }: { kpis: KpiDto[]; siteCode: string }) {
  const { t } = useTranslation();
  const slots = kpis.some((k) => k.key === 'VEHICLES_STORED') ? VEHICLE_SLOTS : SLOTS;
  const picked = slots.map((key) => kpis.find((x) => x.key === key)).filter((k): k is KpiDto => !!k);
  const sub = (k: KpiDto) => {
    switch (k.key) {
      case 'STOCK_ON_HAND_PALLETS':
        return t('v.kpi.pallets');
      case 'TRUCKS_ON_SITE':
        return t('v.kpi.inbound', { n: k.sub?.inbound ?? 0 });
      case 'ON_TIME_DELIVERY':
        return t('v.kpi.last30');
      case 'VEHICLES_STORED':
        return t('kpi.onHold', { n: k.sub?.onHold ?? 0 });
      case 'VEHICLE_RELEASES':
        return t('kpi.approvedReleases', { n: k.sub?.approved ?? 0 });
      default:
        return k.unit === '%' ? `${k.sub?.used ?? 0}/${k.total ?? 0}` : k.unit;
    }
  };
  const delta = (k: KpiDto) => {
    if (k.delta === null || k.delta === undefined) return null;
    if (k.unit === '%') return `${k.delta >= 0 ? '+' : ''}${k.delta.toFixed(1)}%`;
    return `+${k.delta}`;
  };
  return (
    <div className="pointer-events-auto flex flex-wrap gap-3">
      {picked.map((k) => (
        <div key={k.key} className="card flex w-[234px] items-center gap-3.5 px-4 py-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-soft/70">{ICONS[k.key] ?? <CubeIcon />}</div>
          <div className="min-w-0 leading-tight">
            <div className="text-[13px] text-ink/80">{t(`v.kpi.${k.key}`, { defaultValue: t(`kpi.${k.key}`) })}</div>
            <div className="flex items-baseline gap-2">
              <span className="tabular text-[22px] font-bold tracking-tight">{formatValue(k)}</span>
              {delta(k) !== null ? (
                <span className="flex items-center text-xs font-semibold text-ok">
                  <ArrowUp size={12} strokeWidth={2.5} /> {delta(k)}
                </span>
              ) : null}
            </div>
            <div className="truncate text-[11px] text-muted">
              {sub(k)} · {siteCode}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
