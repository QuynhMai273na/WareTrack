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

function formatValue(kpi: KpiDto) {
  if (kpi.value === null) return 'N/A';
  if (kpi.unit === '%') return `${kpi.value.toFixed(1)}%`;
  return kpi.value.toLocaleString('en-US');
}

export function KpiBar({ kpis, siteCode }: { kpis: KpiDto[]; siteCode: string }) {
  const { t } = useTranslation();
  const slots = kpis.some((kpi) => kpi.key === 'VEHICLES_STORED') ? VEHICLE_SLOTS : SLOTS;
  const picked = slots.map((key) => kpis.find((kpi) => kpi.key === key)).filter((kpi): kpi is KpiDto => !!kpi);
  const sub = (kpi: KpiDto) => {
    switch (kpi.key) {
      case 'STOCK_ON_HAND_PALLETS':
        return t('v.kpi.pallets');
      case 'TRUCKS_ON_SITE':
        return t('v.kpi.inbound', { n: kpi.sub?.inbound ?? 0 });
      case 'ON_TIME_DELIVERY':
        return t('v.kpi.last30');
      case 'VEHICLES_STORED':
        return t('kpi.onHold', { n: kpi.sub?.onHold ?? 0 });
      case 'VEHICLE_RELEASES':
        return t('kpi.approvedReleases', { n: kpi.sub?.approved ?? 0 });
      default:
        return kpi.unit === '%' ? `${kpi.sub?.used ?? 0}/${kpi.total ?? 0}` : kpi.unit;
    }
  };
  const delta = (kpi: KpiDto) => {
    if (kpi.delta === null || kpi.delta === undefined) return null;
    if (kpi.unit === '%') return `${kpi.delta >= 0 ? '+' : ''}${kpi.delta.toFixed(1)}%`;
    return `+${kpi.delta}`;
  };
  return (
    <div className="pointer-events-auto flex flex-wrap gap-3">
      {picked.map((kpi) => (
        <div key={kpi.key} className="card flex w-[234px] items-center gap-3.5 px-4 py-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-soft/70">{ICONS[kpi.key] ?? <CubeIcon />}</div>
          <div className="min-w-0 leading-tight">
            <div className="text-[13px] text-ink/80">{t(`v.kpi.${kpi.key}`, { defaultValue: t(`kpi.${kpi.key}`) })}</div>
            <div className="flex items-baseline gap-2">
              <span className="tabular text-[22px] font-bold tracking-tight">{formatValue(kpi)}</span>
              {delta(kpi) !== null ? (
                <span className="flex items-center text-xs font-semibold text-ok">
                  <ArrowUp size={12} strokeWidth={2.5} /> {delta(kpi)}
                </span>
              ) : null}
            </div>
            <div className="truncate text-[11px] text-muted">
              {sub(kpi)} · {siteCode}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
