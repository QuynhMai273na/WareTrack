import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { OutboundOrderDetail } from '@waretrack/shared-schemas';
import { PackageCheck, Plus, Send, Trash2, Truck, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { ScanInput } from '@/components/ScanInput';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { api, describeError } from '@/lib/api';
import { useOutboundOrders, usePartners, useShipment, useSkus, useVisits } from '@/lib/queries';
import { cn, formatTime } from '@/lib/utils';
import { useAuth } from '@/stores/auth';
import { useSiteContext } from '../shell/SiteShell';

const TONE: Record<string, BadgeTone> = { DRAFT: 'neutral', CONFIRMED: 'info', ALLOCATING: 'info', PICKING: 'info', SHIPPED: 'ok', PARTIALLY_SHIPPED: 'warn', CANCELLED: 'neutral' };
const qty = (v: string) => Number(v).toLocaleString();

function CreateOrderDialog({ siteId, onClose, onCreated }: { siteId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: skus } = useSkus();
  const { data: customers } = usePartners('CUSTOMER');
  const { data: visits } = useVisits(siteId, 'SCHEDULED,AT_GATE,WAITING,DOCK_ASSIGNED,AT_DOCK');
  const [customerId, setCustomerId] = useState('');
  const [destination, setDestination] = useState('');
  const [visitId, setVisitId] = useState('');
  const [lines, setLines] = useState([{ skuId: '', orderedQty: '' }]);
  const [key] = useState(() => crypto.randomUUID());
  const m = useMutation({
    mutationFn: () =>
      api<OutboundOrderDetail>(`/sites/${siteId}/outbound-orders`, {
        method: 'POST',
        idempotencyKey: key,
        body: {
          ...(customerId ? { customerId } : {}),
          ...(destination ? { destinationText: destination } : {}),
          ...(visitId ? { truckVisitId: visitId } : {}),
          plannedDispatchAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          lines: lines.filter((l) => l.skuId && l.orderedQty),
        },
      }),
    onSuccess: (o) => {
      void qc.invalidateQueries({ queryKey: ['site', siteId, 'shipments'] });
      onCreated(o.id);
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('flows.newOutbound')} className="w-[min(92vw,560px)]">
      <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('inspector.customer')}</Label>
            <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">—</option>
              {customers?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{t('inspector.destination')}</Label>
            <Input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="Philadelphia, PA" />
          </div>
        </div>
        <div>
          <Label>{t('flows.truckVisit')}</Label>
          <Select value={visitId} onChange={(e) => setVisitId(e.target.value)}>
            <option value="">—</option>
            {visits
              ?.filter((v) => v.direction !== 'INBOUND')
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.truck.code} · {t(`status.${v.status}`)} {v.dock ? `· ${v.dock.code}` : ''}
                </option>
              ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label>{t('flows.lines')}</Label>
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2">
              <Select value={l.skuId} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, skuId: e.target.value } : x)))}>
                <option value="">SKU…</option>
                {skus?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </Select>
              <Input className="w-28" placeholder="Qty" value={l.orderedQty} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, orderedQty: e.target.value } : x)))} />
              <Button type="button" variant="ghost" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, { skuId: '', orderedQty: '' }])}>
            <Plus size={14} /> {t('flows.addLine')}
          </Button>
        </div>
        {m.isError ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(m.error)}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={m.isPending}>
            {t('common.confirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Bảng điều khiển shipment xuất: xếp hàng bằng quét (UC-13), dispatch (UC-14), đã giao. */
function ShipmentPanel({ siteId, shipmentId, timeZone }: { siteId: string; shipmentId: string; timeZone: string }) {
  const { t } = useTranslation();
  const can = useAuth((s) => s.can);
  const qc = useQueryClient();
  const { data: s } = useShipment(siteId, shipmentId);
  const [hu, setHu] = useState('');
  const [dock, setDock] = useState('');
  const [seal, setSeal] = useState('');
  const [error, setError] = useState<unknown>(null);
  const run = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) => api(`/sites/${siteId}/shipments/${shipmentId}${path}`, { method: 'POST', body }),
    onSuccess: () => {
      setError(null);
      setHu('');
      void qc.invalidateQueries({ queryKey: ['site', siteId] });
    },
    onError: setError,
  });
  if (!s) return null;
  const now = () => new Date().toISOString();
  return (
    <div className="rounded-xl border border-line p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Truck size={18} className="text-brand" />
        <span className="font-semibold">#{s.code}</span>
        <Badge tone="info">{t(`shipmentStatus.${s.status}`)}</Badge>
        <span className="text-sm text-muted">
          {s.visit ? `${s.visit.truckCode} · ${s.visit.dockCode ?? '—'}` : t('flows.noVisit')} · {s.progress.done}/{s.progress.total} pallets
        </span>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {s.items.map((i) => (
          <div key={i.id} className={cn('rounded-lg border px-2 py-1.5 text-xs', i.loadedAt ? 'border-ok bg-ok-soft' : 'border-line')}>
            <div className="font-semibold">{i.code}</div>
            <div className="truncate text-muted">{i.label}</div>
            <div className="text-[10px] text-muted">{i.loadedAt ? `✓ ${formatTime(i.loadedAt, timeZone)}` : i.lifecycle}</div>
          </div>
        ))}
      </div>
      {s.status === 'STAGED' && can(siteId, 'outbound.load') ? (
        <Button size="sm" onClick={() => run.mutate({ path: '/loading/start', body: { expectedVersion: s.version } })} disabled={!s.visit}>
          <PackageCheck size={14} /> {t('flows.startLoading')}
        </Button>
      ) : null}
      {s.status === 'LOADING' && can(siteId, 'outbound.load') ? (
        <form
          className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            run.mutate({ path: '/load-scans', body: { huScan: { method: 'BARCODE', value: hu, scannedAt: now() }, dockScan: { method: dock.startsWith('WT:') ? 'QR' : 'MANUAL', value: dock, scannedAt: now() } } });
          }}
        >
          <ScanInput value={hu} onChange={setHu} placeholder="PAL-…" />
          <Input value={dock} onChange={(e) => setDock(e.target.value)} placeholder={`Dock: ${s.visit?.dockCode ?? ''}`} />
          <Button type="submit" disabled={!hu || !dock}>
            {t('flows.load')}
          </Button>
        </form>
      ) : null}
      {s.status === 'LOADING' && can(siteId, 'outbound.dispatch') ? (
        <div className="mt-3 flex gap-2">
          <Input className="w-48" value={seal} onChange={(e) => setSeal(e.target.value)} placeholder={t('flows.seal')} />
          <Button onClick={() => run.mutate({ path: '/dispatch', body: { ...(seal ? { sealNumber: seal } : {}), expectedVersion: s.version } })}>
            <Send size={14} /> {t('flows.dispatch')}
          </Button>
        </div>
      ) : null}
      {s.status === 'DISPATCHED' && can(siteId, 'shipment.deliver') ? (
        <Button size="sm" variant="secondary" onClick={() => run.mutate({ path: '/deliver', body: { deliveredAt: new Date().toISOString(), expectedVersion: s.version } })}>
          {t('flows.markDelivered')}
        </Button>
      ) : null}
      {error ? <p className="mt-2 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(error)}</p> : null}
    </div>
  );
}

/** Xuất kho (UC-11 → UC-14). */
export function OutboundPage() {
  const { t } = useTranslation();
  const { siteId, timeZone } = useSiteContext();
  const can = useAuth((s) => s.can);
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const { data: orders } = useOutboundOrders(siteId);
  const [create, setCreate] = useState(false);
  const selected = orders?.find((o) => o.id === params.get('order')) ?? orders?.[0];
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) => api(`/sites/${siteId}/outbound-orders/${selected!.id}${path}`, { method: 'POST', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['site', siteId] }),
    onError: (err) => window.alert(describeError(err)),
  });
  return (
    <div className="h-full overflow-auto px-4 pb-6 pt-[76px]">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
        <div className="card p-3">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-bold">{t('nav.outbound')}</h2>
            {can(siteId, 'outbound.order.manage') ? (
              <Button size="sm" onClick={() => setCreate(true)}>
                <Plus size={14} /> {t('flows.new')}
              </Button>
            ) : null}
          </div>
          <div className="space-y-1.5">
            {orders?.map((o) => (
              <button key={o.id} onClick={() => setParams({ order: o.id })} className={cn('w-full rounded-xl border p-3 text-left text-sm', selected?.id === o.id ? 'border-brand bg-brand-soft/50' : 'border-line')}>
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{o.code}</span>
                  <Badge tone={TONE[o.status]}>{o.status}</Badge>
                </div>
                <div className="text-xs text-muted">
                  {o.customer?.name ?? '—'} · {o.lines.length} {t('flows.lines').toLowerCase()} {o.shipment ? `· ${o.shipment.code} ${t(`shipmentStatus.${o.shipment.status}`)}` : ''}
                </div>
              </button>
            ))}
          </div>
        </div>
        {selected ? (
          <div className="card space-y-4 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="mr-auto">
                <div className="text-xl font-bold">{selected.code}</div>
                <div className="text-sm text-muted">
                  {selected.customer?.name ?? '—'} {selected.requestedDeliveryAt ? `· ${t('flows.due')} ${formatTime(selected.requestedDeliveryAt, timeZone)}` : ''}
                </div>
              </div>
              {selected.status === 'DRAFT' && can(siteId, 'outbound.order.manage') ? <Button onClick={() => act.mutate({ path: '/confirm', body: { autoAllocate: true, expectedVersion: selected.version } })}>{t('flows.confirmAllocate')}</Button> : null}
              {['CONFIRMED', 'ALLOCATING', 'PICKING'].includes(selected.status) && can(siteId, 'outbound.reserve') ? (
                <Button variant="secondary" onClick={() => act.mutate({ path: '/allocate', body: { allOrNothing: false } })}>
                  {t('flows.allocate')}
                </Button>
              ) : null}
              {!['SHIPPED', 'PARTIALLY_SHIPPED', 'CANCELLED'].includes(selected.status) && can(siteId, 'outbound.order.manage') ? (
                <Button variant="ghost" onClick={() => act.mutate({ path: '/cancel', body: { reason: window.prompt(t('yard.reason')) ?? 'Cancelled' } })}>
                  <X size={14} /> {t('common.cancel')}
                </Button>
              ) : null}
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="py-2 font-medium">SKU</th>
                  <th className="text-right font-medium">{t('flows.ordered')}</th>
                  <th className="text-right font-medium">{t('flows.allocated')}</th>
                  <th className="text-right font-medium">{t('flows.picked')}</th>
                  <th className="text-right font-medium">{t('flows.shipped')}</th>
                  <th className="pl-3 font-medium">{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {selected.lines.map((l) => (
                  <tr key={l.id} className="border-b border-line/60">
                    <td className="py-2">
                      {l.sku.name} <span className="text-xs text-muted">{l.sku.code}</span>
                    </td>
                    <td className="tabular text-right">{qty(l.orderedQty)}</td>
                    <td className="tabular text-right">{qty(l.allocatedQty)}</td>
                    <td className="tabular text-right">{qty(l.pickedQty)}</td>
                    <td className="tabular text-right">{qty(l.shippedQty)}</td>
                    <td className="pl-3">
                      <Badge tone={l.status.includes('PARTIALLY') ? 'warn' : l.status === 'SHIPPED' || l.status === 'PICKED' ? 'ok' : 'info'}>{l.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {selected.shipment ? <ShipmentPanel siteId={siteId} shipmentId={selected.shipment.id} timeZone={timeZone} /> : null}
          </div>
        ) : (
          <div className="card p-6 text-sm text-muted">—</div>
        )}
      </div>
      {create ? <CreateOrderDialog siteId={siteId} onClose={() => setCreate(false)} onCreated={(id) => setParams({ order: id })} /> : null}
    </div>
  );
}
