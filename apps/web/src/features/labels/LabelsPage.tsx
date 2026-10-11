import { useQuery } from '@tanstack/react-query';
import type { LocationDto } from '@waretrack/shared-schemas';
import { Printer } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useSiteContext } from '../shell/SiteShell';

type LabelSource = 'locations' | 'pallets';
type LabelSize = 'small' | 'large';

interface PrintableLabel {
  key: string;
  /** Giá trị mã hóa trong QR — đúng giá trị màn hình quét đang chờ (QR vị trí / mã pallet). */
  qrValue: string;
  title: string;
  subtitle: string;
}

interface PalletRow {
  id: string;
  code: string;
  label: string;
  lifecycle: string;
  locationCode: string | null;
}

const LOCATION_TYPES = ['DOCK', 'STAGING', 'STORAGE', 'YARD_SLOT', 'CHARGER', 'GATE_LANE', 'QUARANTINE', 'PARKING_SLOT'];

function QrImage({ value, size }: { value: string; size: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(value, { margin: 1, width: size * 2, errorCorrectionLevel: 'M' }).then((url) => {
      if (!cancelled) setDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [value, size]);
  return dataUrl ? <img src={dataUrl} width={size} height={size} alt={value} /> : <div style={{ width: size, height: size }} className="bg-slate-100" />;
}

/**
 * In nhãn QR dán ngoài hiện trường (vận hành thật): nhãn vị trí mã hóa qrValue (WT:LOC:…) mà màn hình quét dock/ô chờ dùng,
 * nhãn pallet mã hóa mã pallet. In bằng trình duyệt (A4), chỉ vùng nhãn được in.
 */
export function LabelsPage() {
  const { t } = useTranslation();
  const { siteId, siteCode } = useSiteContext();
  const [source, setSource] = useState<LabelSource>('locations');
  const [locationType, setLocationType] = useState('DOCK');
  const [labelSize, setLabelSize] = useState<LabelSize>('large');
  const [searchText, setSearchText] = useState('');
  const [excludedKeys, setExcludedKeys] = useState<Set<string>>(new Set());

  const { data: locations } = useQuery({
    queryKey: ['site', siteId, 'labels', 'locations', locationType],
    queryFn: () => api<LocationDto[]>(`/sites/${siteId}/locations?type=${locationType}`),
    enabled: source === 'locations',
  });
  const { data: pallets } = useQuery({ queryKey: ['site', siteId, 'labels', 'pallets'], queryFn: () => api<PalletRow[]>(`/sites/${siteId}/pallets`), enabled: source === 'pallets' });

  const labels: PrintableLabel[] = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    const all =
      source === 'locations'
        ? (locations ?? []).map((location) => ({ key: location.id, qrValue: location.qrValue, title: location.name ?? location.code, subtitle: `${siteCode} · ${location.code}` }))
        : (pallets ?? []).map((pallet) => ({ key: pallet.id, qrValue: pallet.code, title: pallet.code, subtitle: [pallet.label, pallet.locationCode].filter(Boolean).join(' · ') }));
    return all.filter((label) => !query || `${label.title} ${label.subtitle}`.toLowerCase().includes(query));
  }, [source, locations, pallets, searchText, siteCode]);
  const selectedLabels = labels.filter((label) => !excludedKeys.has(label.key));
  const qrSize = labelSize === 'large' ? 120 : 72;

  const toggleLabel = (key: string) =>
    setExcludedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="h-full overflow-auto px-4 pb-6 pt-[76px]">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="no-print flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">{t('labels.title', { site: siteCode })}</h1>
            <p className="text-sm text-muted">{t('labels.subtitle')}</p>
          </div>
          <Button onClick={() => window.print()} disabled={!selectedLabels.length} data-testid="print-labels">
            <Printer size={16} /> {t('labels.print', { n: selectedLabels.length })}
          </Button>
        </div>

        <div className="no-print card flex flex-wrap items-center gap-3 p-3">
          <Tabs
            value={source}
            onValueChange={(value) => {
              setSource(value as LabelSource);
              setExcludedKeys(new Set());
            }}
          >
            <TabsList>
              <TabsTrigger value="locations">{t('labels.locations')}</TabsTrigger>
              <TabsTrigger value="pallets">{t('labels.pallets')}</TabsTrigger>
            </TabsList>
          </Tabs>
          {source === 'locations' ? (
            <Select
              value={locationType}
              className="w-48"
              data-testid="label-location-type"
              onChange={(event) => {
                setLocationType(event.target.value);
                setExcludedKeys(new Set());
              }}
            >
              {LOCATION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`labels.types.${type}`)}
                </option>
              ))}
            </Select>
          ) : null}
          <Select value={labelSize} className="w-40" onChange={(event) => setLabelSize(event.target.value as LabelSize)}>
            <option value="large">{t('labels.large')}</option>
            <option value="small">{t('labels.small')}</option>
          </Select>
          <Input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder={t('labels.search')} className="w-56" />
          <span className="text-xs text-muted">{t('labels.hint')}</span>
        </div>

        {labels.length === 0 ? <div className="no-print card p-8 text-center text-sm text-muted">{t('labels.empty')}</div> : null}

        <div className={cn('print-area grid gap-3', labelSize === 'large' ? 'grid-cols-2 md:grid-cols-3' : 'grid-cols-3 md:grid-cols-5')} data-testid="label-sheet">
          {labels.map((label) => {
            const excluded = excludedKeys.has(label.key);
            return (
              <button
                key={label.key}
                type="button"
                onClick={() => toggleLabel(label.key)}
                className={cn('label-card flex items-center gap-3 rounded-lg border-2 border-dashed bg-white p-3 text-left', excluded ? 'no-print border-line opacity-40' : 'border-slate-300')}
              >
                <QrImage value={label.qrValue} size={qrSize} />
                <span className="min-w-0">
                  <span className={cn('block font-bold leading-tight', labelSize === 'large' ? 'text-2xl' : 'text-base')}>{label.title}</span>
                  <span className="block text-xs text-slate-500">{label.subtitle}</span>
                  {labelSize === 'large' ? <span className="mt-1 block font-mono text-[10px] text-slate-400">{label.qrValue}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
