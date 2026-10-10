import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InboundOrderDetail } from '@waretrack/shared-schemas';
import { CheckCircle2, ClipboardCheck, PackagePlus, Plus, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, describeError } from '@/lib/api';
import { useInboundOrders, usePartners, useReceipt, useSkus, useVisits } from '@/lib/queries';
import { cn, formatTime } from '@/lib/utils';
import { useAuth } from '@/stores/auth';
import { useSiteContext } from '../shell/SiteShell';

const TONE: Record<string, BadgeTone> = { CONFIRMED: 'info', RECEIVING: 'info', RECEIVED: 'warn', CLOSED: 'ok', CANCELLED: 'neutral' };
const qty = (v: string) => Number(v).toLocaleString();

function CreateInboundDialog({ siteId, onClose, onCreated }: { siteId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: skus } = useSkus();
  const { data: suppliers } = usePartners('SUPPLIER');
  const { data: visits } = useVisits(siteId, 'SCHEDULED,AT_GATE,WAITING,DOCK_ASSIGNED,AT_DOCK,HANDLING');
  const [supplierId, setSupplierId] = useState('');
  const [visitId, setVisitId] = useState('');
  const [lines, setLines] = useState([{ skuId: '', expectedQty: '', expectedHuCount: '1', expectedLotNumber: '' }]);
  const [key] = useState(() => crypto.randomUUID());
  const m = useMutation({
    mutationFn: () =>
      api<InboundOrderDetail>(`/sites/${siteId}/inbound-orders`, {
        method: 'POST',
        idempotencyKey: key,
        body: {
          ...(supplierId ? { supplierId } : {}),
          ...(visitId ? { truckVisitId: visitId } : {}),
          lines: lines
            .filter((l) => l.skuId && l.expectedQty)
            .map((l) => ({ skuId: l.skuId, expectedQty: l.expectedQty, expectedHuCount: Number(l.expectedHuCount) || 0, ...(l.expectedLotNumber ? { expectedLotNumber: l.expectedLotNumber } : {}) })),
        },
      }),
    onSuccess: (o) => {
      void qc.invalidateQueries({ queryKey: ['site', siteId, 'shipments'] });
      onCreated(o.id);
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('flows.newInbound')} className="w-[min(92vw,620px)]">
      <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('inspector.supplier')}</Label>
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">—</option>
              {suppliers?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{t('flows.truckVisit')}</Label>
            <Select value={visitId} onChange={(e) => setVisitId(e.target.value)}>
              <option value="">—</option>
              {visits
                ?.filter((v) => v.direction !== 'OUTBOUND')
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.truck.code} · {t(`status.${v.status}`)}
                  </option>
                ))}
            </Select>
          </div>
        </div>
        <Label>{t('flows.lines')}</Label>
        {lines.map((l, i) => (
          <div key={i} className="flex gap-2">
            <Select value={l.skuId} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, skuId: e.target.value } : x)))}>
              <option value="">SKU…</option>
              {skus?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Input className="w-24" placeholder="Qty" value={l.expectedQty} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, expectedQty: e.target.value } : x)))} />
            <Input className="w-20" placeholder="Pal." value={l.expectedHuCount} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, expectedHuCount: e.target.value } : x)))} />
            <Input className="w-28" placeholder="Lot" value={l.expectedLotNumber} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, expectedLotNumber: e.target.value } : x)))} />
            <Button type="button" variant="ghost" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, { skuId: '', expectedQty: '', expectedHuCount: '1', expectedLotNumber: '' }])}>
          <Plus size={14} /> {t('flows.addLine')}
        </Button>
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

/** Màn hình nhận hàng (UC-08): mỗi lần quét = một pallet; tiến độ x/y; sai lệch → exception. */
function ReceivingPanel({ siteId, order, timeZone }: { siteId: string; order: InboundOrderDetail; timeZone: string }) {
  const { t } = useTranslation();
  const can = useAuth((s) => s.can);
  const qc = useQueryClient();
  const { data: receipt } = useReceipt(siteId, order.receipt?.id);
  const [skuId, setSkuId] = useState(order.lines[0]?.sku.id ?? '');
  const line = order.lines.find((l) => l.sku.id === skuId);
  const [quantity, setQuantity] = useState('');
  const [lot, setLot] = useState(order.lines[0]?.expectedLotNumber ?? '');
  const [expires, setExpires] = useState('');
  const [huCode, setHuCode] = useState('');
  const [damaged, setDamaged] = useState(false);
  const [shortReason, setShortReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['site', siteId] });
  const run = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) => api(`/sites/${siteId}${path}`, { method: 'POST', body }),
    onSuccess: () => {
      setError(null);
      setHuCode('');
      refresh();
    },
    onError: setError,
  });
  if (!order.receipt) {
    return can(siteId, 'inbound.receive') ? (
      <div className="rounded-xl border border-dashed border-line p-4 text-sm">
        <p className="mb-2 text-muted">{order.shipment?.visitId ? t('flows.readyToReceive') : t('flows.noVisit')}</p>
        <Button disabled={!order.shipment?.visitId} onClick={() => run.mutate({ path: '/receipts', body: { inboundOrderId: order.id } })}>
          <PackagePlus size={14} /> {t('flows.startReceipt')}
        </Button>
        {error ? <p className="mt-2 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(error)}</p> : null}
      </div>
    ) : null;
  }
  if (!receipt) return null;
  const pct = receipt.progress.expectedHu ? (receipt.progress.receivedHu / receipt.progress.expectedHu) * 100 : 0;
  return (
    <div className="rounded-xl border border-line p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ClipboardCheck size={18} className="text-brand" />
        <span className="font-semibold">{receipt.code}</span>
        <Badge tone={receipt.status === 'IN_PROGRESS' ? 'info' : 'ok'}>{receipt.status}</Badge>
        <span className="text-sm text-muted">
          {receipt.dock.code} · {receipt.progress.receivedHu}/{receipt.progress.expectedHu} pallets
        </span>
      </div>
      <div className="mb-3 h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-ok" style={{ width: `${pct}%` }} />
      </div>
      {receipt.status === 'IN_PROGRESS' && can(siteId, 'inbound.receive') ? (
        <form
          className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-6"
          onSubmit={(e) => {
            e.preventDefault();
            run.mutate({
              path: `/receipts/${receipt.id}/lines`,
              body: { skuId, quantity, ...(lot ? { lotNumber: lot } : {}), ...(expires ? { expiresOn: expires } : {}), ...(huCode ? { huCode } : {}), condition: damaged ? 'DAMAGED' : 'GOOD' },
            });
          }}
        >
          <Select className="col-span-2" value={skuId} onChange={(e) => setSkuId(e.target.value)}>
            {order.lines.map((l) => (
              <option key={l.id} value={l.sku.id}>
                {l.sku.name}
              </option>
            ))}
          </Select>
          <Input placeholder="Qty" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
          {line?.sku.lotTracked ? <Input placeholder="Lot" value={lot} onChange={(e) => setLot(e.target.value)} required /> : <Input placeholder="PAL-… (opt.)" value={huCode} onChange={(e) => setHuCode(e.target.value)} />}
          {line?.sku.lotTracked ? <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} title="Expiry" /> : <span />}
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={damaged} onChange={(e) => setDamaged(e.target.checked)} /> {t('flows.damaged')}
            </label>
            <Button type="submit" size="sm" disabled={run.isPending}>
              {t('flows.scan')}
            </Button>
          </div>
        </form>
      ) : null}
      {error ? <p className="mb-3 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(error)}</p> : null}
      <table className="mb-3 w-full text-sm">
        <tbody>
          {receipt.lines.map((l) => (
            <tr key={l.id} className={cn('border-b border-line/60', l.voided && 'text-muted line-through')}>
              <td className="py-1.5 font-medium">{l.handlingUnit.code}</td>
              <td>{l.sku.name}</td>
              <td className="text-xs">{l.lotNumber ?? ''}</td>
              <td className="tabular text-right">{qty(l.quantity)}</td>
              <td className="pl-3">
                <Badge tone={l.stockStatus === 'AVAILABLE' ? 'ok' : l.stockStatus === 'QC_HOLD' ? 'warn' : 'bad'}>{l.stockStatus}</Badge>
              </td>
              <td className="text-xs text-muted">{formatTime(l.createdAt, timeZone)}</td>
              <td className="text-right">
                {!l.voided && receipt.status === 'IN_PROGRESS' ? (
                  <Button size="iconSm" variant="ghost" onClick={() => run.mutate({ path: `/receipts/${receipt.id}/lines/${l.id}/void`, body: { reason: window.prompt(t('yard.reason')) ?? 'Scanned by mistake' } })}>
                    <XCircle size={14} />
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {receipt.status === 'IN_PROGRESS' ? (
        <div className="flex flex-wrap items-center gap-2">
          {receipt.progress.receivedHu < receipt.progress.expectedHu ? <Input className="w-72" placeholder={t('flows.shortReason')} value={shortReason} onChange={(e) => setShortReason(e.target.value)} /> : null}
          <Button onClick={() => run.mutate({ path: `/receipts/${receipt.id}/complete`, body: shortReason ? { closeShortReason: shortReason } : {} })}>
            <CheckCircle2 size={14} /> {t('flows.completeReceipt')}
          </Button>
        </div>
      ) : null}
      {receipt.discrepancies.length > 0 ? (
        <div className="mt-3 space-y-1">
          {receipt.discrepancies.map((d) => (
            <div key={d.id} className="flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm">
              <span className="font-semibold">{d.type}</span> {d.sku} {d.qtyDelta} <Badge tone="warn">{d.status}</Badge>
              {d.status === 'PENDING_APPROVAL' && can(siteId, 'inbound.discrepancy.approve') ? (
                <Button size="sm" className="ml-auto" onClick={() => run.mutate({ path: `/receipts/${receipt.id}/discrepancies/${d.id}/approve`, body: {} })}>
                  {t('inventory.approve')}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function QcQueue({ siteId }: { siteId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['site', siteId, 'inventory', 'qc'], queryFn: () => api<Array<{ balanceId: string; handlingUnit: { id: string; code: string }; sku: { code: string; name: string }; location: string; quantity: string }>>(`/sites/${siteId}/qc-queue`) });
  const run = useMutation({
    mutationFn: (body: unknown) => api(`/sites/${siteId}/qc-inspections`, { method: 'POST', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['site', siteId] }),
    onError: (err) => window.alert(describeError(err)),
  });
  return (
    <div className="space-y-2">
      {data?.length === 0 ? <p className="text-sm text-muted">{t('flows.qcEmpty')}</p> : null}
      {data?.map((q) => (
        <div key={q.balanceId} className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3 text-sm">
          <ShieldCheck size={18} className="text-warn" />
          <div className="flex-1">
            <div className="font-semibold">
              {q.handlingUnit.code} · {q.sku.name}
            </div>
            <div className="text-xs text-muted">
              {q.location} · {qty(q.quantity)}
            </div>
          </div>
          <Button size="sm" onClick={() => run.mutate({ handlingUnitId: q.handlingUnit.id, result: 'PASS' })}>
            PASS
          </Button>
          <Button size="sm" variant="danger" onClick={() => run.mutate({ handlingUnitId: q.handlingUnit.id, result: 'FAIL', failStatus: 'QUARANTINE', note: window.prompt('Note') ?? undefined })}>
            FAIL
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Nhập kho (UC-08, UC-09). */
export function InboundPage() {
  const { t } = useTranslation();
  const { siteId, timeZone } = useSiteContext();
  const can = useAuth((s) => s.can);
  const [params, setParams] = useSearchParams();
  const { data: orders } = useInboundOrders(siteId);
  const [create, setCreate] = useState(false);
  const selected = orders?.find((o) => o.id === params.get('order')) ?? orders?.[0];
  return (
    <div className="h-full overflow-auto px-4 pb-6 pt-[76px]">
      <Tabs defaultValue="orders" className="mx-auto max-w-7xl">
        <div className="mb-3 flex items-center gap-3">
          <h2 className="mr-auto text-lg font-bold">{t('nav.inbound')}</h2>
          <TabsList>
            <TabsTrigger value="orders">{t('flows.orders')}</TabsTrigger>
            {can(siteId, 'inbound.qc') ? <TabsTrigger value="qc">QC</TabsTrigger> : null}
          </TabsList>
        </div>
        <TabsContent value="orders">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
            <div className="card p-3">
              {can(siteId, 'inbound.order.manage') ? (
                <Button size="sm" className="mb-3" onClick={() => setCreate(true)}>
                  <Plus size={14} /> {t('flows.new')}
                </Button>
              ) : null}
              <div className="space-y-1.5">
                {orders?.map((o) => (
                  <button key={o.id} onClick={() => setParams({ order: o.id })} className={cn('w-full rounded-xl border p-3 text-left text-sm', selected?.id === o.id ? 'border-brand bg-brand-soft/50' : 'border-line')}>
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">{o.code}</span>
                      <Badge tone={TONE[o.status] ?? 'neutral'}>{o.status}</Badge>
                    </div>
                    <div className="text-xs text-muted">
                      {o.supplier?.name ?? '—'} {o.shipment ? `· ${o.shipment.code} ${t(`shipmentStatus.${o.shipment.status}`)}` : ''}
                    </div>
                  </button>
                ))}
              </div>
            </div>
            {selected ? (
              <div className="card space-y-4 p-4">
                <div>
                  <div className="text-xl font-bold">{selected.code}</div>
                  <div className="text-sm text-muted">
                    {selected.supplier?.name ?? '—'} · {selected.shipment?.code}
                  </div>
                </div>
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr className="border-b border-line">
                      <th className="py-2 font-medium">SKU</th>
                      <th className="font-medium">Lot</th>
                      <th className="text-right font-medium">{t('flows.expected')}</th>
                      <th className="text-right font-medium">{t('flows.received')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.lines.map((l) => (
                      <tr key={l.id} className="border-b border-line/60">
                        <td className="py-2">
                          {l.sku.name} {l.sku.qcRequired ? <Badge tone="warn">QC</Badge> : null}
                        </td>
                        <td className="text-xs">{l.expectedLotNumber ?? '—'}</td>
                        <td className="tabular text-right">
                          {qty(l.expectedQty)} {l.expectedHuCount ? <span className="text-xs text-muted">({l.expectedHuCount} pal.)</span> : null}
                        </td>
                        <td className={cn('tabular text-right font-semibold', Number(l.receivedQty) > Number(l.expectedQty) && 'text-warn')}>{qty(l.receivedQty)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ReceivingPanel key={selected.id} siteId={siteId} order={selected} timeZone={timeZone} />
              </div>
            ) : (
              <div className="card p-6 text-sm text-muted">—</div>
            )}
          </div>
        </TabsContent>
        <TabsContent value="qc">
          <div className="card p-4">
            <QcQueue siteId={siteId} />
          </div>
        </TabsContent>
      </Tabs>
      {create ? <CreateInboundDialog siteId={siteId} onClose={() => setCreate(false)} onCreated={(id) => setParams({ order: id })} /> : null}
    </div>
  );
}
