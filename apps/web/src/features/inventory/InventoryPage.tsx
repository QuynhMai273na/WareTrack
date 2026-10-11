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
const qty = (amount: string) => Number(amount).toLocaleString(undefined, { maximumFractionDigits: 3 });

function useInvalidateInventory(siteId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['site', siteId, 'inventory'] });
    void queryClient.invalidateQueries({ queryKey: ['site', siteId, 'snapshot'] });
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
  const movePallet = useMutation({
    mutationFn: () => api(`/sites/${siteId}/pallets/${balance.handlingUnit!.id}/move`, { method: 'POST', idempotencyKey: key, body: { toLocationId: to, reason, ...(scan ? { scanDestination: scan } : {}), expectedVersion: hu?.version ?? 0 } }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  const target = locations?.find((location) => location.id === to);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={`${t('inventory.move')} ${balance.handlingUnit?.code ?? ''}`} description={`${balance.sku.name} · ${balance.location.code}`}>
      <form className="space-y-3" onSubmit={(event) => (event.preventDefault(), movePallet.mutate())}>
        <div>
          <Label>{t('inventory.destination')}</Label>
          <Select value={to} onChange={(event) => setTo(event.target.value)} required>
            <option value="">—</option>
            {locations
              ?.filter((location) => location.id !== balance.location.id)
              .map((location) => (
                <option key={location.id} value={location.id} disabled={location.effectiveStatus === 'BLOCKED' || location.unitsUsed >= location.capacityUnits}>
                  {location.code} · {location.locationType} · {location.unitsUsed}/{location.capacityUnits}
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
          <Input value={reason} onChange={(event) => setReason(event.target.value)} required minLength={3} />
        </div>
        <ErrorBox error={movePallet.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={movePallet.isPending || !to}>
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
  const requestAdjustment = useMutation({
    mutationFn: () => api(`/sites/${siteId}/inventory/adjustments`, { method: 'POST', idempotencyKey: key, body: { balanceId: balance.id, qtyDelta: delta, reasonCode, ...(note ? { note } : {}) } }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={t('inventory.requestAdjustment')} description={`${balance.sku.name} · ${balance.location.code} · ${qty(balance.qtyOnHand)} ${balance.sku.baseUom}`}>
      <form className="space-y-3" onSubmit={(event) => (event.preventDefault(), requestAdjustment.mutate())}>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('inventory.delta')} (±)</Label>
            <Input value={delta} onChange={(event) => setDelta(event.target.value)} placeholder="-2" required pattern="-?\d+(\.\d{1,3})?" />
          </div>
          <div>
            <Label>{t('yard.reason')}</Label>
            <Select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)}>
              {ADJUSTMENT_REASONS.map((reasonOption) => (
                <option key={reasonOption} value={reasonOption}>
                  {t(`inventory.reason.${reasonOption}`)}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div>
          <Label>Note</Label>
          <Input value={note} onChange={(event) => setNote(event.target.value)} />
        </div>
        <p className="text-xs text-muted">{t('inventory.thresholdHint')}</p>
        <ErrorBox error={requestAdjustment.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={requestAdjustment.isPending}>
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
      {data?.map((skuAvailability) => {
        const pct = Number(skuAvailability.onHand) ? (Number(skuAvailability.available) / Number(skuAvailability.onHand)) * 100 : 0;
        return (
          <div key={skuAvailability.sku.id} className="rounded-xl border border-line p-4">
            <div className="mb-2 flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold">{skuAvailability.sku.name}</div>
                <div className="text-xs text-muted">{skuAvailability.sku.code}</div>
              </div>
              <Badge tone={skuAvailability.lowStock ? 'warn' : 'ok'}>{skuAvailability.lowStock ? t('inventory.lowStock') : t('inventory.inStock')}</Badge>
            </div>
            <div className="tabular text-2xl font-bold">
              {qty(skuAvailability.available)} <span className="text-sm font-medium text-muted">{skuAvailability.sku.baseUom} {t('inventory.available')}</span>
            </div>
            <div className="my-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-ok" style={{ width: `${pct}%` }} />
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
              <span>
                {t('inventory.onHand')}: <b className="text-ink">{qty(skuAvailability.onHand)}</b>
              </span>
              <span>
                {t('inventory.reserved')}: <b className="text-ink">{qty(skuAvailability.reserved)}</b>
              </span>
              {Object.entries(skuAvailability.byStatus)
                .filter(([status]) => status !== 'AVAILABLE')
                .map(([status, amount]) => (
                  <span key={status}>
                    {status}: <b className="text-bad">{qty(amount)}</b>
                  </span>
                ))}
              {skuAvailability.lowStockThreshold ? <span>min {qty(skuAvailability.lowStockThreshold)}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BalancesTab({ siteId }: { siteId: string }) {
  const { t } = useTranslation();
  const can = useAuth((state) => state.can);
  const [search, setSearch] = useState('');
  const { data } = useBalances(siteId, search);
  const [move, setMove] = useState<BalanceDto | null>(null);
  const [adjust, setAdjust] = useState<BalanceDto | null>(null);
  return (
    <>
      <div className="relative mb-3 w-72">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <Input className="pl-8" placeholder={t('inventory.search')} value={search} onChange={(event) => setSearch(event.target.value)} />
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
            {data?.map((balance) => (
              <tr key={balance.id} className="border-b border-line/60">
                <td className="py-2">
                  <div className="font-medium">{balance.sku.name}</div>
                  <div className="text-xs text-muted">{balance.sku.code}</div>
                </td>
                <td>{balance.location.code}</td>
                <td>{balance.handlingUnit?.code ?? '—'}</td>
                <td className="text-xs">
                  {balance.lot?.lotNumber ?? '—'}
                  {balance.lot?.expiresOn ? <div className="text-muted">exp {balance.lot.expiresOn}</div> : null}
                </td>
                <td>
                  <Badge tone={STATUS_TONE[balance.stockStatus]}>{balance.stockStatus}</Badge>
                </td>
                <td className="tabular text-right">{qty(balance.qtyOnHand)}</td>
                <td className="tabular text-right">{qty(balance.qtyReserved)}</td>
                <td className="tabular text-right font-semibold">{qty(balance.qtyAvailable)}</td>
                <td className="whitespace-nowrap text-right">
                  {balance.handlingUnit && can(siteId, 'inventory.move') ? (
                    <Button size="iconSm" variant="ghost" title={t('inventory.move')} onClick={() => setMove(balance)}>
                      <ArrowRightLeft size={14} />
                    </Button>
                  ) : null}
                  {can(siteId, 'inventory.adjust.request') ? (
                    <Button size="iconSm" variant="ghost" title={t('inventory.requestAdjustment')} onClick={() => setAdjust(balance)}>
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
  const can = useAuth((state) => state.can);
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
          {data?.map((entry) => (
            <tr key={entry.id} className="border-b border-line/60">
              <td className="tabular py-2 text-muted">{entry.id}</td>
              <td className="tabular">{formatTime(entry.occurredAt, timeZone)}</td>
              <td>
                <Badge tone={entry.txType.includes('REVERSAL') || entry.reversesTxId ? 'warn' : entry.txType === 'ISSUE' || entry.txType === 'ADJUSTMENT_OUT' ? 'bad' : 'info'}>{entry.txType}</Badge>
              </td>
              <td>{entry.sku.code}</td>
              <td>{entry.handlingUnitCode ?? '—'}</td>
              <td className="text-xs">
                {entry.fromLocation ?? entry.fromStatus ?? '·'} → {entry.toLocation ?? entry.toStatus ?? '·'}
              </td>
              <td className="tabular text-right">{qty(entry.quantity)}</td>
              <td className="text-xs text-muted">{entry.referenceType}</td>
              <td className="text-xs">{entry.actor}</td>
              <td className="text-right">
                {can(siteId, 'inventory.reversal') && !entry.reversedByTxId && !entry.reversesTxId && ['RECEIPT', 'ISSUE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT'].includes(entry.txType) ? (
                  <Button size="iconSm" variant="ghost" title={t('inventory.reverse')} onClick={() => reverse.mutate(entry.id)}>
                    <RotateCcw size={14} />
                  </Button>
                ) : entry.reversedByTxId ? (
                  <span className="text-xs text-muted">↩ {entry.reversedByTxId}</span>
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
  const can = useAuth((state) => state.can);
  const me = useAuth((state) => state.me);
  const { data } = useAdjustments(siteId);
  const invalidate = useInvalidateInventory(siteId);
  const decide = useMutation({
    mutationFn: ({ adjustment, approve }: { adjustment: AdjustmentDto; approve: boolean }) => api(`/sites/${siteId}/inventory/adjustments/${adjustment.id}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: { expectedVersion: adjustment.version } }),
    onSuccess: invalidate,
    onError: (err) => window.alert(describeError(err)),
  });
  return (
    <div className="space-y-2">
      {data?.length === 0 ? <p className="text-sm text-muted">—</p> : null}
      {data?.map((adjustment) => (
        <div key={adjustment.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3 text-sm">
          <div className="w-28">
            <div className="font-semibold">{adjustment.code}</div>
            <div className="text-xs text-muted">{formatTime(adjustment.createdAt, timeZone)}</div>
          </div>
          <div className="min-w-48 flex-1">
            <div className="font-medium">
              {adjustment.balance.sku.name} · {adjustment.balance.location.code} {adjustment.balance.handlingUnit ? `· ${adjustment.balance.handlingUnit.code}` : ''}
            </div>
            <div className="text-xs text-muted">
              {t(`inventory.reason.${adjustment.reasonCode}`)} {adjustment.note ? `— ${adjustment.note}` : ''} · {adjustment.requestedBy.fullName}
            </div>
          </div>
          <div className={`tabular w-20 text-right text-base font-bold ${Number(adjustment.qtyDelta) < 0 ? 'text-bad' : 'text-ok'}`}>{Number(adjustment.qtyDelta) > 0 ? `+${qty(adjustment.qtyDelta)}` : qty(adjustment.qtyDelta)}</div>
          {adjustment.requiresManager ? (
            <Badge tone="warn">
              <ShieldAlert size={12} /> Site Manager
            </Badge>
          ) : null}
          <Badge tone={adjustment.status === 'APPLIED' ? 'ok' : adjustment.status === 'REJECTED' ? 'bad' : 'info'}>{adjustment.status}</Badge>
          {adjustment.status === 'PENDING_APPROVAL' && can(siteId, 'inventory.adjust.approve') && adjustment.requestedBy.id !== me?.user.id ? (
            <div className="flex gap-1">
              <Button size="sm" onClick={() => decide.mutate({ adjustment, approve: true })}>
                <Check size={14} /> {t('inventory.approve')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => decide.mutate({ adjustment, approve: false })}>
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
  const can = useAuth((state) => state.can);
  const queryClient = useQueryClient();
  const { data: counts } = useQuery({ queryKey: ['site', siteId, 'inventory', 'counts'], queryFn: () => api<StockCountDto[]>(`/sites/${siteId}/stock-counts`) });
  const { data: zones } = useQuery({ queryKey: ['site', siteId, 'zones'], queryFn: () => api<Array<{ id: string; code: string; name: string; zoneType: string }>>(`/sites/${siteId}/zones`) });
  const [open, setOpen] = useState<string | null>(null);
  const [zone, setZone] = useState('');
  const { data: detail } = useQuery({ queryKey: ['site', siteId, 'inventory', 'count', open], queryFn: () => api<StockCountDto & { lines: StockCountLineDto[] }>(`/sites/${siteId}/stock-counts/${open}`), enabled: !!open });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['site', siteId, 'inventory'] });
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
            <Select value={zone} onChange={(event) => setZone(event.target.value)}>
              <option value="">Zone…</option>
              {zones
                ?.filter((zoneOption) => ['WAREHOUSE', 'STAGING', 'QUARANTINE'].includes(zoneOption.zoneType))
                .map((zoneOption) => (
                  <option key={zoneOption.id} value={zoneOption.id}>
                    {zoneOption.code} · {zoneOption.name}
                  </option>
                ))}
            </Select>
            <Button disabled={!zone} onClick={() => act.mutate({ path: '', body: { scope: { zoneIds: [zone] }, blind: true, freeze: false } })}>
              <Plus size={14} />
            </Button>
          </div>
        ) : null}
        {counts?.map((stockCount) => (
          <button key={stockCount.id} onClick={() => setOpen(stockCount.id)} className={`w-full rounded-xl border p-3 text-left text-sm ${open === stockCount.id ? 'border-brand bg-brand-soft/50' : 'border-line'}`}>
            <div className="flex items-center justify-between">
              <span className="font-semibold">{stockCount.code}</span>
              <Badge tone={stockCount.status === 'COMPLETED' ? 'ok' : stockCount.status === 'CANCELLED' ? 'neutral' : 'info'}>{stockCount.status}</Badge>
            </div>
            <div className="text-xs text-muted">
              {stockCount.countedCount}/{stockCount.lineCount} {t('inventory.counted')} · {stockCount.varianceCount} variance {stockCount.blind ? '· blind' : ''}
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
              {detail.lines.map((countLine) => (
                <tr key={countLine.id} className="border-b border-line/60">
                  <td className="py-1.5">{countLine.location}</td>
                  <td>{countLine.sku.name}</td>
                  <td>{countLine.handlingUnitCode ?? '—'}</td>
                  <td className="tabular text-right text-muted">{countLine.systemQty !== null ? qty(countLine.systemQty) : '•••'}</td>
                  <td className="text-right">
                    {detail.status === 'IN_PROGRESS' && can(siteId, 'inventory.count.execute') ? (
                      <input
                        className="h-7 w-20 rounded border border-line px-2 text-right"
                        defaultValue={countLine.countedQty ?? ''}
                        onBlur={(event) => event.target.value && event.target.value !== countLine.countedQty && act.mutate({ path: `/${detail.id}/lines/${countLine.id}`, method: 'PUT', body: { countedQty: event.target.value } })}
                      />
                    ) : (
                      <span className="tabular">{countLine.countedQty !== null ? qty(countLine.countedQty) : '—'}</span>
                    )}
                  </td>
                  <td className={`tabular text-right ${Number(countLine.variance) ? 'font-semibold text-bad' : 'text-muted'}`}>{countLine.variance ?? ''}</td>
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
  const pendingCount = pending?.filter((adjustment) => adjustment.status === 'PENDING_APPROVAL').length ?? 0;
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
