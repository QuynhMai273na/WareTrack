import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ADJUSTMENT_REASONS, type AdjustmentDto, type BalanceDto, type StockCountDto, type StockCountLineDto } from '@waretrack/shared-schemas';
import { ArrowRightLeft, Check, ClipboardCheck, Plus, RotateCcw, Search, ShieldAlert, SlidersHorizontal, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScanInput } from '@/components/ScanInput';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, describeError } from '@/lib/api';
import { useAdjustments, useAvailability, useBalances, useLedger, useStorageLocations } from '@/lib/queries';
import { formatTime } from '@/lib/utils';
import { useAuth } from '@/stores/auth';
import { useSiteContext } from '../shell/SiteShell';

const STATUS_TONE: Record<string, BadgeTone> = { AVAILABLE: 'ok', QC_HOLD: 'warn', QUARANTINE: 'bad', DAMAGED: 'bad' };
const qty = (v: string) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 3 });

function useInvalidateInventory(siteId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['site', siteId, 'inventory'] });
    void qc.invalidateQueries({ queryKey: ['site', siteId, 'snapshot'] });
  };
}

function ErrorBox({ error }: { error: unknown }) {
  return error ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(error)}</p> : null;
}

function MoveDialog({ siteId, balance, onClose }: { siteId: string; balance: BalanceDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: locations } = useStorageLocations(siteId);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [scan, setScan] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const invalidate = useInvalidateInventory(siteId);
  const { data: hu } = useQuery({ queryKey: ['site', siteId, 'inventory', 'pallet', balance.handlingUnit?.id], queryFn: () => api<{ version: number }>(`/sites/${siteId}/pallets/${balance.handlingUnit!.id}`), enabled: !!balance.handlingUnit });
  const m = useMutation({
    mutationFn: () => api(`/sites/${siteId}/pallets/${balance.handlingUnit!.id}/move`, { method: 'POST', idempotencyKey: key, body: { toLocationId: to, reason, ...(scan ? { scanDestination: scan } : {}), expectedVersion: hu?.version ?? 0 } }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  const target = locations?.find((l) => l.id === to);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`${t('inventory.move')} ${balance.handlingUnit?.code ?? ''}`} description={`${balance.sku.name} · ${balance.location.code}`}>
      <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
        <div>
          <Label>{t('inventory.destination')}</Label>
          <Select value={to} onChange={(e) => setTo(e.target.value)} required>
            <option value="">—</option>
            {locations
              ?.filter((l) => l.id !== balance.location.id)
              .map((l) => (
                <option key={l.id} value={l.id} disabled={l.effectiveStatus === 'BLOCKED' || l.unitsUsed >= l.capacityUnits}>
                  {l.code} · {l.locationType} · {l.unitsUsed}/{l.capacityUnits}
                </option>
              ))}
          </Select>
        </div>
        <div>
          <Label>{t('inventory.scanDestination')}</Label>
          <ScanInput value={scan} onChange={setScan} placeholder={target?.qrValue ?? 'WT:LOC:…'} />
        </div>
        <div>
          <Label>{t('yard.reason')}</Label>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} />
        </div>
        <ErrorBox error={m.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={m.isPending || !to}>
            {t('common.confirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AdjustDialog({ siteId, balance, onClose }: { siteId: string; balance: BalanceDto; onClose: () => void }) {
  const { t } = useTranslation();
  const [delta, setDelta] = useState('');
  const [reasonCode, setReasonCode] = useState<string>('COUNT_VARIANCE');
  const [note, setNote] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const invalidate = useInvalidateInventory(siteId);
  const m = useMutation({
    mutationFn: () => api(`/sites/${siteId}/inventory/adjustments`, { method: 'POST', idempotencyKey: key, body: { balanceId: balance.id, qtyDelta: delta, reasonCode, ...(note ? { note } : {}) } }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('inventory.requestAdjustment')} description={`${balance.sku.name} · ${balance.location.code} · ${qty(balance.qtyOnHand)} ${balance.sku.baseUom}`}>
      <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('inventory.delta')} (±)</Label>
            <Input value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="-2" required pattern="-?\d+(\.\d{1,3})?" />
          </div>
          <div>
            <Label>{t('yard.reason')}</Label>
            <Select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              {ADJUSTMENT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {t(`inventory.reason.${r}`)}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div>
          <Label>Note</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <p className="text-xs text-muted">{t('inventory.thresholdHint')}</p>
        <ErrorBox error={m.error} />
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

function OverviewTab({ siteId }: { siteId: string }) {
  const { t } = useTranslation();
  const { data } = useAvailability(siteId);
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {data?.map((a) => {
        const pct = Number(a.onHand) ? (Number(a.available) / Number(a.onHand)) * 100 : 0;
        return (
          <div key={a.sku.id} className="rounded-xl border border-line p-4">
            <div className="mb-2 flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold">{a.sku.name}</div>
                <div className="text-xs text-muted">{a.sku.code}</div>
              </div>
              <Badge tone={a.lowStock ? 'warn' : 'ok'}>{a.lowStock ? t('inventory.lowStock') : t('inventory.inStock')}</Badge>
            </div>
            <div className="tabular text-2xl font-bold">
              {qty(a.available)} <span className="text-sm font-medium text-muted">{a.sku.baseUom} {t('inventory.available')}</span>
            </div>
            <div className="my-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-ok" style={{ width: `${pct}%` }} />
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
              <span>
                {t('inventory.onHand')}: <b className="text-ink">{qty(a.onHand)}</b>
              </span>
              <span>
                {t('inventory.reserved')}: <b className="text-ink">{qty(a.reserved)}</b>
              </span>
              {Object.entries(a.byStatus)
                .filter(([s]) => s !== 'AVAILABLE')
                .map(([s, v]) => (
                  <span key={s}>
                    {s}: <b className="text-bad">{qty(v)}</b>
                  </span>
                ))}
              {a.lowStockThreshold ? <span>min {qty(a.lowStockThreshold)}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BalancesTab({ siteId }: { siteId: string }) {
  const { t } = useTranslation();
  const can = useAuth((s) => s.can);
  const [q, setQ] = useState('');
  const { data } = useBalances(siteId, q);
  const [move, setMove] = useState<BalanceDto | null>(null);
  const [adjust, setAdjust] = useState<BalanceDto | null>(null);
  return (
    <>
      <div className="relative mb-3 w-72">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <Input className="pl-8" placeholder={t('inventory.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="overflow-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th className="py-2 font-medium">SKU</th>
              <th className="font-medium">{t('inventory.location')}</th>
              <th className="font-medium">Pallet</th>
              <th className="font-medium">Lot</th>
              <th className="font-medium">{t('common.status')}</th>
              <th className="text-right font-medium">{t('inventory.onHand')}</th>
              <th className="text-right font-medium">{t('inventory.reserved')}</th>
              <th className="text-right font-medium">{t('inventory.available')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.map((b) => (
              <tr key={b.id} className="border-b border-line/60">
                <td className="py-2">
                  <div className="font-medium">{b.sku.name}</div>
                  <div className="text-xs text-muted">{b.sku.code}</div>
                </td>
                <td>{b.location.code}</td>
                <td>{b.handlingUnit?.code ?? '—'}</td>
                <td className="text-xs">
                  {b.lot?.lotNumber ?? '—'}
                  {b.lot?.expiresOn ? <div className="text-muted">exp {b.lot.expiresOn}</div> : null}
                </td>
                <td>
                  <Badge tone={STATUS_TONE[b.stockStatus]}>{b.stockStatus}</Badge>
                </td>
                <td className="tabular text-right">{qty(b.qtyOnHand)}</td>
                <td className="tabular text-right">{qty(b.qtyReserved)}</td>
                <td className="tabular text-right font-semibold">{qty(b.qtyAvailable)}</td>
                <td className="whitespace-nowrap text-right">
                  {b.handlingUnit && can(siteId, 'inventory.move') ? (
                    <Button size="iconSm" variant="ghost" title={t('inventory.move')} onClick={() => setMove(b)}>
                      <ArrowRightLeft size={14} />
                    </Button>
                  ) : null}
                  {can(siteId, 'inventory.adjust.request') ? (
                    <Button size="iconSm" variant="ghost" title={t('inventory.requestAdjustment')} onClick={() => setAdjust(b)}>
                      <SlidersHorizontal size={14} />
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {move ? <MoveDialog siteId={siteId} balance={move} onClose={() => setMove(null)} /> : null}
      {adjust ? <AdjustDialog siteId={siteId} balance={adjust} onClose={() => setAdjust(null)} /> : null}
    </>
  );
}

function LedgerTab({ siteId, timeZone }: { siteId: string; timeZone: string }) {
  const { t } = useTranslation();
  const can = useAuth((s) => s.can);
  const { data } = useLedger(siteId);
  const invalidate = useInvalidateInventory(siteId);
  const reverse = useMutation({
    mutationFn: (id: string) => api(`/sites/${siteId}/inventory/transactions/${id}/reverse`, { method: 'POST', body: { reason: window.prompt(t('inventory.reversalReason')) ?? '' } }),
    onSuccess: invalidate,
    onError: (err) => window.alert(describeError(err)),
  });
  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr className="border-b border-line">
            <th className="py-2 font-medium">#</th>
            <th className="font-medium">{t('common.time')}</th>
            <th className="font-medium">Type</th>
            <th className="font-medium">SKU</th>
            <th className="font-medium">Pallet</th>
            <th className="font-medium">{t('inventory.fromTo')}</th>
            <th className="text-right font-medium">Qty</th>
            <th className="font-medium">Ref</th>
            <th className="font-medium">Actor</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((x) => (
            <tr key={x.id} className="border-b border-line/60">
              <td className="tabular py-2 text-muted">{x.id}</td>
              <td className="tabular">{formatTime(x.occurredAt, timeZone)}</td>
              <td>
                <Badge tone={x.txType.includes('REVERSAL') || x.reversesTxId ? 'warn' : x.txType === 'ISSUE' || x.txType === 'ADJUSTMENT_OUT' ? 'bad' : 'info'}>{x.txType}</Badge>
              </td>
              <td>{x.sku.code}</td>
              <td>{x.handlingUnitCode ?? '—'}</td>
              <td className="text-xs">
                {x.fromLocation ?? x.fromStatus ?? '·'} → {x.toLocation ?? x.toStatus ?? '·'}
              </td>
              <td className="tabular text-right">{qty(x.quantity)}</td>
              <td className="text-xs text-muted">{x.referenceType}</td>
              <td className="text-xs">{x.actor}</td>
              <td className="text-right">
                {can(siteId, 'inventory.reversal') && !x.reversedByTxId && !x.reversesTxId && ['RECEIPT', 'ISSUE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT'].includes(x.txType) ? (
                  <Button size="iconSm" variant="ghost" title={t('inventory.reverse')} onClick={() => reverse.mutate(x.id)}>
                    <RotateCcw size={14} />
                  </Button>
                ) : x.reversedByTxId ? (
                  <span className="text-xs text-muted">↩ {x.reversedByTxId}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdjustmentsTab({ siteId, timeZone }: { siteId: string; timeZone: string }) {
  const { t } = useTranslation();
  const can = useAuth((s) => s.can);
  const me = useAuth((s) => s.me);
  const { data } = useAdjustments(siteId);
  const invalidate = useInvalidateInventory(siteId);
  const decide = useMutation({
    mutationFn: ({ a, approve }: { a: AdjustmentDto; approve: boolean }) => api(`/sites/${siteId}/inventory/adjustments/${a.id}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: { expectedVersion: a.version } }),
    onSuccess: invalidate,
    onError: (err) => window.alert(describeError(err)),
  });
  return (
    <div className="space-y-2">
      {data?.length === 0 ? <p className="text-sm text-muted">—</p> : null}
      {data?.map((a) => (
        <div key={a.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3 text-sm">
          <div className="w-28">
            <div className="font-semibold">{a.code}</div>
            <div className="text-xs text-muted">{formatTime(a.createdAt, timeZone)}</div>
          </div>
          <div className="min-w-48 flex-1">
            <div className="font-medium">
              {a.balance.sku.name} · {a.balance.location.code} {a.balance.handlingUnit ? `· ${a.balance.handlingUnit.code}` : ''}
            </div>
            <div className="text-xs text-muted">
              {t(`inventory.reason.${a.reasonCode}`)} {a.note ? `— ${a.note}` : ''} · {a.requestedBy.fullName}
            </div>
          </div>
          <div className={`tabular w-20 text-right text-base font-bold ${Number(a.qtyDelta) < 0 ? 'text-bad' : 'text-ok'}`}>{Number(a.qtyDelta) > 0 ? `+${qty(a.qtyDelta)}` : qty(a.qtyDelta)}</div>
          {a.requiresManager ? (
            <Badge tone="warn">
              <ShieldAlert size={12} /> Site Manager
            </Badge>
          ) : null}
          <Badge tone={a.status === 'APPLIED' ? 'ok' : a.status === 'REJECTED' ? 'bad' : 'info'}>{a.status}</Badge>
          {a.status === 'PENDING_APPROVAL' && can(siteId, 'inventory.adjust.approve') && a.requestedBy.id !== me?.user.id ? (
            <div className="flex gap-1">
              <Button size="sm" onClick={() => decide.mutate({ a, approve: true })}>
                <Check size={14} /> {t('inventory.approve')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => decide.mutate({ a, approve: false })}>
                <X size={14} />
              </Button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function CountsTab({ siteId }: { siteId: string }) {
  const { t } = useTranslation();
  const can = useAuth((s) => s.can);
  const qc = useQueryClient();
  const { data: counts } = useQuery({ queryKey: ['site', siteId, 'inventory', 'counts'], queryFn: () => api<StockCountDto[]>(`/sites/${siteId}/stock-counts`) });
  const { data: zones } = useQuery({ queryKey: ['site', siteId, 'zones'], queryFn: () => api<Array<{ id: string; code: string; name: string; zoneType: string }>>(`/sites/${siteId}/zones`) });
  const [open, setOpen] = useState<string | null>(null);
  const [zone, setZone] = useState('');
  const { data: detail } = useQuery({ queryKey: ['site', siteId, 'inventory', 'count', open], queryFn: () => api<StockCountDto & { lines: StockCountLineDto[] }>(`/sites/${siteId}/stock-counts/${open}`), enabled: !!open });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['site', siteId, 'inventory'] });
  const act = useMutation({
    mutationFn: ({ path, method = 'POST', body = {} }: { path: string; method?: 'POST' | 'PUT'; body?: unknown }) => api(`/sites/${siteId}/stock-counts${path}`, { method, body }),
    onSuccess: refresh,
    onError: (err) => window.alert(describeError(err)),
  });
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
      <div className="space-y-2">
        {can(siteId, 'inventory.count.manage') ? (
          <div className="flex gap-2">
            <Select value={zone} onChange={(e) => setZone(e.target.value)}>
              <option value="">Zone…</option>
              {zones
                ?.filter((z) => ['WAREHOUSE', 'STAGING', 'QUARANTINE'].includes(z.zoneType))
                .map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.code} · {z.name}
                  </option>
                ))}
            </Select>
            <Button disabled={!zone} onClick={() => act.mutate({ path: '', body: { scope: { zoneIds: [zone] }, blind: true, freeze: false } })}>
              <Plus size={14} />
            </Button>
          </div>
        ) : null}
        {counts?.map((c) => (
          <button key={c.id} onClick={() => setOpen(c.id)} className={`w-full rounded-xl border p-3 text-left text-sm ${open === c.id ? 'border-brand bg-brand-soft/50' : 'border-line'}`}>
            <div className="flex items-center justify-between">
              <span className="font-semibold">{c.code}</span>
              <Badge tone={c.status === 'COMPLETED' ? 'ok' : c.status === 'CANCELLED' ? 'neutral' : 'info'}>{c.status}</Badge>
            </div>
            <div className="text-xs text-muted">
              {c.countedCount}/{c.lineCount} {t('inventory.counted')} · {c.varianceCount} variance {c.blind ? '· blind' : ''}
            </div>
          </button>
        ))}
      </div>
      {detail ? (
        <div className="rounded-xl border border-line p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <ClipboardCheck size={18} className="text-brand" />
            <span className="font-semibold">{detail.code}</span>
            <Badge tone="info">{detail.status}</Badge>
            <div className="ml-auto flex gap-2">
              {detail.status === 'PLANNED' ? <Button size="sm" onClick={() => act.mutate({ path: `/${detail.id}/start` })}>{t('inventory.start')}</Button> : null}
              {detail.status === 'IN_PROGRESS' ? <Button size="sm" onClick={() => act.mutate({ path: `/${detail.id}/close` })}>{t('inventory.close')}</Button> : null}
              {detail.status === 'RECONCILING' ? <Button size="sm" onClick={() => act.mutate({ path: `/${detail.id}/complete`, body: { createAdjustments: true } })}>{t('inventory.complete')}</Button> : null}
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="py-2 font-medium">{t('inventory.location')}</th>
                <th className="font-medium">SKU</th>
                <th className="font-medium">Pallet</th>
                <th className="text-right font-medium">System</th>
                <th className="text-right font-medium">{t('inventory.counted')}</th>
                <th className="text-right font-medium">Var.</th>
              </tr>
            </thead>
            <tbody>
              {detail.lines.map((l) => (
                <tr key={l.id} className="border-b border-line/60">
                  <td className="py-1.5">{l.location}</td>
                  <td>{l.sku.name}</td>
                  <td>{l.handlingUnitCode ?? '—'}</td>
                  <td className="tabular text-right text-muted">{l.systemQty !== null ? qty(l.systemQty) : '•••'}</td>
                  <td className="text-right">
                    {detail.status === 'IN_PROGRESS' && can(siteId, 'inventory.count.execute') ? (
                      <input
                        className="h-7 w-20 rounded border border-line px-2 text-right"
                        defaultValue={l.countedQty ?? ''}
                        onBlur={(e) => e.target.value && e.target.value !== l.countedQty && act.mutate({ path: `/${detail.id}/lines/${l.id}`, method: 'PUT', body: { countedQty: e.target.value } })}
                      />
                    ) : (
                      <span className="tabular">{l.countedQty !== null ? qty(l.countedQty) : '—'}</span>
                    )}
                  </td>
                  <td className={`tabular text-right ${Number(l.variance) ? 'font-semibold text-bad' : 'text-muted'}`}>{l.variance ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-line p-6 text-sm text-muted">{t('inventory.selectCount')}</div>
      )}
    </div>
  );
}

/** Tồn kho (UC-11, UC-15, UC-16, UC-17) — ledger là nguồn sự thật, balance là projection. */
export function InventoryPage() {
  const { t } = useTranslation();
  const { siteId, timeZone } = useSiteContext();
  const { data: pending } = useAdjustments(siteId);
  const pendingCount = pending?.filter((a) => a.status === 'PENDING_APPROVAL').length ?? 0;
  return (
    <div className="h-full overflow-auto px-4 pb-6 pt-[76px]">
      <div className="card mx-auto max-w-7xl p-4">
        <Tabs defaultValue="overview">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <h2 className="mr-auto text-lg font-bold">{t('nav.inventory')}</h2>
            <TabsList>
              <TabsTrigger value="overview">{t('inventory.tabs.overview')}</TabsTrigger>
              <TabsTrigger value="balances">{t('inventory.tabs.balances')}</TabsTrigger>
              <TabsTrigger value="ledger">{t('inventory.tabs.ledger')}</TabsTrigger>
              <TabsTrigger value="adjustments">
                {t('inventory.tabs.adjustments')} {pendingCount ? <span className="ml-1 rounded-full bg-warn px-1.5 text-[10px] text-white">{pendingCount}</span> : null}
              </TabsTrigger>
              <TabsTrigger value="counts">{t('inventory.tabs.counts')}</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="overview">
            <OverviewTab siteId={siteId} />
          </TabsContent>
          <TabsContent value="balances">
            <BalancesTab siteId={siteId} />
          </TabsContent>
          <TabsContent value="ledger">
            <LedgerTab siteId={siteId} timeZone={timeZone} />
          </TabsContent>
          <TabsContent value="adjustments">
            <AdjustmentsTab siteId={siteId} timeZone={timeZone} />
          </TabsContent>
          <TabsContent value="counts">
            <CountsTab siteId={siteId} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
