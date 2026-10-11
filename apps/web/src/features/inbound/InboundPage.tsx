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
const qty = (amount: string) => Number(amount).toLocaleString();

function CreateInboundDialog({ siteId, onClose, onCreated }: { siteId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: skus } = useSkus();
  const { data: suppliers } = usePartners('SUPPLIER');
  const { data: visits } = useVisits(siteId, 'SCHEDULED,AT_GATE,WAITING,DOCK_ASSIGNED,AT_DOCK,HANDLING');
  const [supplierId, setSupplierId] = useState('');
  const [visitId, setVisitId] = useState('');
  const [lines, setLines] = useState([{ skuId: '', expectedQty: '', expectedHuCount: '1', expectedLotNumber: '' }]);
  const [key] = useState(() => crypto.randomUUID());
  const createOrder = useMutation({
    mutationFn: () =>
      api<InboundOrderDetail>(`/sites/${siteId}/inbound-orders`, {
        method: 'POST',
        idempotencyKey: key,
        body: {
          ...(supplierId ? { supplierId } : {}),
          ...(visitId ? { truckVisitId: visitId } : {}),
          lines: lines
            .filter((line) => line.skuId && line.expectedQty)
            .map((line) => ({ skuId: line.skuId, expectedQty: line.expectedQty, expectedHuCount: Number(line.expectedHuCount) || 0, ...(line.expectedLotNumber ? { expectedLotNumber: line.expectedLotNumber } : {}) })),
        },
      }),
    onSuccess: (order) => {
      void queryClient.invalidateQueries({ queryKey: ['site', siteId, 'shipments'] });
      onCreated(order.id);
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={t('flows.newInbound')} className="w-[min(92vw,620px)]">
      <form className="space-y-3" onSubmit={(event) => (event.preventDefault(), createOrder.mutate())}>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('inspector.supplier')}</Label>
            <Select value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
              <option value="">—</option>
              {suppliers?.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{t('flows.truckVisit')}</Label>
            <Select value={visitId} onChange={(event) => setVisitId(event.target.value)}>
              <option value="">—</option>
              {visits
                ?.filter((visit) => visit.direction !== 'OUTBOUND')
                .map((visit) => (
                  <option key={visit.id} value={visit.id}>
                    {visit.truck.code} · {t(`status.${visit.status}`)}
                  </option>
                ))}
            </Select>
          </div>
        </div>
        <Label>{t('flows.lines')}</Label>
        {lines.map((line, lineIndex) => (
          <div key={lineIndex} className="flex gap-2">
            <Select value={line.skuId} onChange={(event) => setLines((prevLines) => prevLines.map((entry, entryIndex) => (entryIndex === lineIndex ? { ...entry, skuId: event.target.value } : entry)))}>
              <option value="">SKU…</option>
              {skus?.map((sku) => (
                <option key={sku.id} value={sku.id}>
                  {sku.name}
                </option>
              ))}
            </Select>
            <Input className="w-24" placeholder="Qty" value={line.expectedQty} onChange={(event) => setLines((prevLines) => prevLines.map((entry, entryIndex) => (entryIndex === lineIndex ? { ...entry, expectedQty: event.target.value } : entry)))} />
            <Input className="w-20" placeholder="Pal." value={line.expectedHuCount} onChange={(event) => setLines((prevLines) => prevLines.map((entry, entryIndex) => (entryIndex === lineIndex ? { ...entry, expectedHuCount: event.target.value } : entry)))} />
            <Input className="w-28" placeholder="Lot" value={line.expectedLotNumber} onChange={(event) => setLines((prevLines) => prevLines.map((entry, entryIndex) => (entryIndex === lineIndex ? { ...entry, expectedLotNumber: event.target.value } : entry)))} />
            <Button type="button" variant="ghost" size="icon" onClick={() => setLines((prevLines) => prevLines.filter((_, entryIndex) => entryIndex !== lineIndex))}>
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => setLines((prevLines) => [...prevLines, { skuId: '', expectedQty: '', expectedHuCount: '1', expectedLotNumber: '' }])}>
          <Plus size={14} /> {t('flows.addLine')}
        </Button>
        {createOrder.isError ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(createOrder.error)}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={createOrder.isPending}>
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
  const can = useAuth((state) => state.can);
  const queryClient = useQueryClient();
  const { data: receipt } = useReceipt(siteId, order.receipt?.id);
  const [skuId, setSkuId] = useState(order.lines[0]?.sku.id ?? '');
  const line = order.lines.find((orderLine) => orderLine.sku.id === skuId);
  const [quantity, setQuantity] = useState('');
  const [lot, setLot] = useState(order.lines[0]?.expectedLotNumber ?? '');
  const [expires, setExpires] = useState('');
  const [huCode, setHuCode] = useState('');
  const [damaged, setDamaged] = useState(false);
  const [shortReason, setShortReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['site', siteId] });
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
          onSubmit={(event) => {
            event.preventDefault();
            run.mutate({
              path: `/receipts/${receipt.id}/lines`,
              body: { skuId, quantity, ...(lot ? { lotNumber: lot } : {}), ...(expires ? { expiresOn: expires } : {}), ...(huCode ? { huCode } : {}), condition: damaged ? 'DAMAGED' : 'GOOD' },
            });
          }}
        >
          <Select className="col-span-2" value={skuId} onChange={(event) => setSkuId(event.target.value)}>
            {order.lines.map((orderLine) => (
              <option key={orderLine.id} value={orderLine.sku.id}>
                {orderLine.sku.name}
              </option>
            ))}
          </Select>
          <Input placeholder="Qty" value={quantity} onChange={(event) => setQuantity(event.target.value)} required />
          {line?.sku.lotTracked ? <Input placeholder="Lot" value={lot} onChange={(event) => setLot(event.target.value)} required /> : <Input placeholder="PAL-… (opt.)" value={huCode} onChange={(event) => setHuCode(event.target.value)} />}
          {line?.sku.lotTracked ? <Input type="date" value={expires} onChange={(event) => setExpires(event.target.value)} title="Expiry" /> : <span />}
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={damaged} onChange={(event) => setDamaged(event.target.checked)} /> {t('flows.damaged')}
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
          {receipt.lines.map((receiptLine) => (
            <tr key={receiptLine.id} className={cn('border-b border-line/60', receiptLine.voided && 'text-muted line-through')}>
              <td className="py-1.5 font-medium">{receiptLine.handlingUnit.code}</td>
              <td>{receiptLine.sku.name}</td>
              <td className="text-xs">{receiptLine.lotNumber ?? ''}</td>
              <td className="tabular text-right">{qty(receiptLine.quantity)}</td>
              <td className="pl-3">
                <Badge tone={receiptLine.stockStatus === 'AVAILABLE' ? 'ok' : receiptLine.stockStatus === 'QC_HOLD' ? 'warn' : 'bad'}>{receiptLine.stockStatus}</Badge>
              </td>
              <td className="text-xs text-muted">{formatTime(receiptLine.createdAt, timeZone)}</td>
              <td className="text-right">
                {!receiptLine.voided && receipt.status === 'IN_PROGRESS' ? (
                  <Button size="iconSm" variant="ghost" onClick={() => run.mutate({ path: `/receipts/${receipt.id}/lines/${receiptLine.id}/void`, body: { reason: window.prompt(t('yard.reason')) ?? 'Scanned by mistake' } })}>
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
          {receipt.progress.receivedHu < receipt.progress.expectedHu ? <Input className="w-72" placeholder={t('flows.shortReason')} value={shortReason} onChange={(event) => setShortReason(event.target.value)} /> : null}
          <Button onClick={() => run.mutate({ path: `/receipts/${receipt.id}/complete`, body: shortReason ? { closeShortReason: shortReason } : {} })}>
            <CheckCircle2 size={14} /> {t('flows.completeReceipt')}
          </Button>
        </div>
      ) : null}
      {receipt.discrepancies.length > 0 ? (
        <div className="mt-3 space-y-1">
          {receipt.discrepancies.map((discrepancy) => (
            <div key={discrepancy.id} className="flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm">
              <span className="font-semibold">{discrepancy.type}</span> {discrepancy.sku} {discrepancy.qtyDelta} <Badge tone="warn">{discrepancy.status}</Badge>
              {discrepancy.status === 'PENDING_APPROVAL' && can(siteId, 'inbound.discrepancy.approve') ? (
                <Button size="sm" className="ml-auto" onClick={() => run.mutate({ path: `/receipts/${receipt.id}/discrepancies/${discrepancy.id}/approve`, body: {} })}>
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
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['site', siteId, 'inventory', 'qc'], queryFn: () => api<Array<{ balanceId: string; handlingUnit: { id: string; code: string }; sku: { code: string; name: string }; location: string; quantity: string }>>(`/sites/${siteId}/qc-queue`) });
  const run = useMutation({
    mutationFn: (body: unknown) => api(`/sites/${siteId}/qc-inspections`, { method: 'POST', body }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['site', siteId] }),
    onError: (err) => window.alert(describeError(err)),
  });
  return (
    <div className="space-y-2">
      {data?.length === 0 ? <p className="text-sm text-muted">{t('flows.qcEmpty')}</p> : null}
      {data?.map((qcBalance) => (
        <div key={qcBalance.balanceId} className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3 text-sm">
          <ShieldCheck size={18} className="text-warn" />
          <div className="flex-1">
            <div className="font-semibold">
              {qcBalance.handlingUnit.code} · {qcBalance.sku.name}
            </div>
            <div className="text-xs text-muted">
              {qcBalance.location} · {qty(qcBalance.quantity)}
            </div>
          </div>
          <Button size="sm" onClick={() => run.mutate({ handlingUnitId: qcBalance.handlingUnit.id, result: 'PASS' })}>
            PASS
          </Button>
          <Button size="sm" variant="danger" onClick={() => run.mutate({ handlingUnitId: qcBalance.handlingUnit.id, result: 'FAIL', failStatus: 'QUARANTINE', note: window.prompt('Note') ?? undefined })}>
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
  const can = useAuth((state) => state.can);
  const [params, setParams] = useSearchParams();
  const { data: orders } = useInboundOrders(siteId);
  const [create, setCreate] = useState(false);
  const selected = orders?.find((order) => order.id === params.get('order')) ?? orders?.[0];
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
                {orders?.map((order) => (
                  <button key={order.id} onClick={() => setParams({ order: order.id })} className={cn('w-full rounded-xl border p-3 text-left text-sm', selected?.id === order.id ? 'border-brand bg-brand-soft/50' : 'border-line')}>
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">{order.code}</span>
                      <Badge tone={TONE[order.status] ?? 'neutral'}>{order.status}</Badge>
                    </div>
                    <div className="text-xs text-muted">
                      {order.supplier?.name ?? '—'} {order.shipment ? `· ${order.shipment.code} ${t(`shipmentStatus.${order.shipment.status}`)}` : ''}
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
                    {selected.lines.map((orderLine) => (
                      <tr key={orderLine.id} className="border-b border-line/60">
                        <td className="py-2">
                          {orderLine.sku.name} {orderLine.sku.qcRequired ? <Badge tone="warn">QC</Badge> : null}
                        </td>
                        <td className="text-xs">{orderLine.expectedLotNumber ?? '—'}</td>
                        <td className="tabular text-right">
                          {qty(orderLine.expectedQty)} {orderLine.expectedHuCount ? <span className="text-xs text-muted">({orderLine.expectedHuCount} pal.)</span> : null}
                        </td>
                        <td className={cn('tabular text-right font-semibold', Number(orderLine.receivedQty) > Number(orderLine.expectedQty) && 'text-warn')}>{qty(orderLine.receivedQty)}</td>
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
