import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LocationDto, VisitDetail, VisitRow } from '@waretrack/shared-schemas';
import { ArrowRightLeft, DoorOpen, LogIn, LogOut, Plus, Search, ShieldCheck, Undo2, Warehouse, XCircle } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { ScanInput } from '@/components/ScanInput';
import { Badge, toneFor } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { api, describeError } from '@/lib/api';
import { useDockLocations, useVisit, useVisits } from '@/lib/queries';
import { cn, formatTime } from '@/lib/utils';
import { useAuth } from '@/stores/auth';
import { useSiteContext } from '../shell/SiteShell';

type ActionKind = 'arrive' | 'verify' | 'reject' | 'assignDock' | 'unassignDock' | 'arriveAtDock' | 'abort' | 'gateOut' | 'cancel';

const ACTIVE = 'SCHEDULED,AT_GATE,WAITING,DOCK_ASSIGNED,AT_DOCK,HANDLING,READY_TO_LEAVE';

/** Hành động hợp lệ theo trạng thái (mục 9.1) + permission (mục 10.2) — UI ẩn nút không hợp lệ, backend vẫn kiểm. */
function availableActions(v: VisitRow, can: (p: string) => boolean): Array<{ kind: ActionKind; icon: ReactNode; variant?: 'default' | 'secondary' | 'outline' | 'danger' }> {
  const a: Array<{ kind: ActionKind; icon: ReactNode; variant?: 'default' | 'secondary' | 'outline' | 'danger' }> = [];
  const add = (kind: ActionKind, perm: string, icon: ReactNode, variant?: 'default' | 'secondary' | 'outline' | 'danger') => can(perm) && a.push({ kind, icon, variant });
  switch (v.status) {
    case 'SCHEDULED':
      add('arrive', 'yard.visit.gate_in', <LogIn size={14} />);
      add('assignDock', 'yard.dock.assign', <Warehouse size={14} />, 'secondary');
      if (v.dock) add('unassignDock', 'yard.dock.assign', <Undo2 size={14} />, 'outline');
      add('cancel', 'yard.appointment.manage', <XCircle size={14} />, 'outline');
      break;
    case 'AT_GATE':
      add('verify', 'yard.visit.gate_in', <ShieldCheck size={14} />);
      add('reject', 'yard.visit.reject', <XCircle size={14} />, 'danger');
      break;
    case 'WAITING':
      add('assignDock', 'yard.dock.assign', <Warehouse size={14} />);
      add('abort', 'yard.visit.abort', <Undo2 size={14} />, 'outline');
      break;
    case 'DOCK_ASSIGNED':
      add('arriveAtDock', 'yard.visit.update', <DoorOpen size={14} />);
      add('assignDock', 'yard.dock.assign', <ArrowRightLeft size={14} />, 'secondary');
      add('unassignDock', 'yard.dock.assign', <Undo2 size={14} />, 'outline');
      add('abort', 'yard.visit.abort', <XCircle size={14} />, 'outline');
      break;
    case 'AT_DOCK':
      add('abort', 'yard.visit.abort', <Undo2 size={14} />, 'outline');
      break;
    case 'READY_TO_LEAVE':
      add('gateOut', 'yard.visit.gate_out', <LogOut size={14} />);
      break;
  }
  return a;
}

const ENDPOINT: Record<ActionKind, string> = {
  arrive: 'arrive',
  verify: 'verify',
  reject: 'reject',
  assignDock: 'assign-dock',
  unassignDock: 'unassign-dock',
  arriveAtDock: 'arrive-at-dock',
  abort: 'abort',
  gateOut: 'gate-out',
  cancel: 'cancel',
};

function ActionDialog({ siteId, visit, kind, onClose }: { siteId: string; visit: VisitDetail; kind: ActionKind; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: docks } = useDockLocations(siteId);
  const { data: settings } = useQuery({ queryKey: ['site', siteId, 'settings'], queryFn: () => api<{ gateDocumentChecklist: Array<{ key: string; vi: string; en: string; required: boolean }> }>(`/sites/${siteId}/settings`) });
  const [reason, setReason] = useState('');
  const [plate, setPlate] = useState(visit.truck.plateNumber);
  const [dockId, setDockId] = useState('');
  const [scan, setScan] = useState('');
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  // Idempotency-Key giữ nguyên cho mọi lần bấm lại của cùng một ý định (mục 16.1)
  const [idemKey] = useState(() => crypto.randomUUID());
  const { i18n } = useTranslation();

  const mutation = useMutation({
    mutationFn: () => {
      const base = { expectedVersion: visit.version };
      const body =
        kind === 'arrive'
          ? { ...base, actualPlate: plate, ...(reason ? { lateReason: reason } : {}) }
          : kind === 'verify'
            ? { ...base, documentChecks: Object.entries(checks).map(([key, passed]) => ({ key, passed })) }
            : kind === 'assignDock'
              ? { ...base, dockLocationId: dockId }
              : kind === 'arriveAtDock'
                ? { ...base, scan: { method: scan.startsWith('WT:') ? 'QR' : 'MANUAL', value: scan, scannedAt: new Date().toISOString() } }
                : kind === 'gateOut' || kind === 'unassignDock'
                  ? base
                  : { ...base, reason };
      return api<VisitDetail>(`/sites/${siteId}/visits/${visit.id}/${ENDPOINT[kind]}`, { method: 'POST', body, idempotencyKey: idemKey });
    },
    onSuccess: (updated) => {
      qc.setQueryData(['site', siteId, 'visit', visit.id], updated);
      void qc.invalidateQueries({ queryKey: ['site', siteId, 'visits'] });
      void qc.invalidateQueries({ queryKey: ['site', siteId, 'docks'] });
      onClose();
    },
  });

  const compatible = (d: LocationDto) => visit.direction === 'BOTH' || d.dockDirection === 'BOTH' || d.dockDirection === visit.direction;
  const needsReason = ['reject', 'abort', 'cancel'].includes(kind);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t(`yard.${kind}`)} description={`${visit.truck.code} · ${visit.code} · ${t(`status.${visit.status}`)}`}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        {kind === 'arrive' ? (
          <>
            <div>
              <Label>{t('yard.plate')}</Label>
              <Input value={plate} onChange={(e) => setPlate(e.target.value)} />
            </div>
            <div>
              <Label>{t('yard.reason')} (late / early)</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          </>
        ) : null}
        {kind === 'verify' ? (
          <div>
            <Label>{t('yard.checklist')}</Label>
            <div className="space-y-1.5">
              {settings?.gateDocumentChecklist.map((c) => (
                <label key={c.key} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
                  <input type="checkbox" checked={!!checks[c.key]} onChange={(e) => setChecks((s) => ({ ...s, [c.key]: e.target.checked }))} />
                  {i18n.language === 'vi' ? c.vi : c.en}
                  {c.required ? <span className="ml-auto text-xs text-bad">*</span> : null}
                </label>
              ))}
            </div>
          </div>
        ) : null}
        {kind === 'assignDock' ? (
          <div className="grid grid-cols-3 gap-2">
            {docks?.map((d) => {
              const disabled = d.effectiveStatus !== 'AVAILABLE' || !compatible(d);
              return (
                <button
                  key={d.id}
                  type="button"
                  disabled={disabled && d.id !== visit.dock?.id}
                  onClick={() => setDockId(d.id)}
                  className={cn('rounded-xl border p-2.5 text-left text-sm', dockId === d.id ? 'border-brand bg-brand-soft' : 'border-line', disabled && 'cursor-not-allowed opacity-50')}
                >
                  <div className="font-semibold">{d.name ?? d.code}</div>
                  <div className="text-xs text-muted">
                    {d.name ? `${d.code} · ` : ''}
                    {t(`direction.${d.dockDirection ?? 'BOTH'}`)}
                  </div>
                  <Badge tone={toneFor(d.effectiveStatus)} className="mt-1">
                    {t(`status.${d.effectiveStatus}`)}
                  </Badge>
                </button>
              );
            })}
          </div>
        ) : null}
        {kind === 'arriveAtDock' ? (
          <div>
            <Label>
              {t('yard.scanDock')} — {visit.dock?.code}
            </Label>
            <ScanInput value={scan} onChange={setScan} placeholder={`WT:LOC:…:${visit.dock?.code ?? ''}`} />
          </div>
        ) : null}
        {needsReason ? (
          <div>
            <Label>{t('yard.reason')}</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} />
          </div>
        ) : null}
        {mutation.isError ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(mutation.error)}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={mutation.isPending || (kind === 'assignDock' && !dockId) || (kind === 'arriveAtDock' && !scan)} variant={kind === 'reject' ? 'danger' : 'default'}>
            {t('common.confirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function WalkInDialog({ siteId, onClose, onCreated }: { siteId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [plate, setPlate] = useState('');
  const [direction, setDirection] = useState<'INBOUND' | 'OUTBOUND'>('INBOUND');
  const [truckType, setTruckType] = useState('BOX');
  const [reason, setReason] = useState('');
  const [idemKey] = useState(() => crypto.randomUUID());
  const { data: trucks } = useQuery({ queryKey: ['trucks', plate], queryFn: () => api<{ items: Array<{ id: string; code: string; plateNumber: string }> }>(`/trucks?plate=${encodeURIComponent(plate)}`), enabled: plate.length >= 3 });
  const existing = trucks?.items.find((x) => x.plateNumber === plate.replace(/[\s.-]/g, '').toUpperCase());
  const m = useMutation({
    mutationFn: () =>
      api<VisitDetail>(`/sites/${siteId}/visits/walk-in`, {
        method: 'POST',
        idempotencyKey: idemKey,
        body: { direction, actualPlate: plate, reason, ...(existing ? { truckId: existing.id } : { newTruck: { plateNumber: plate, truckType } }) },
      }),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: ['site', siteId, 'visits'] });
      onCreated(v.id);
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('yard.walkIn')} description="UC-01 A1">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <div>
          <Label>{t('yard.plate')}</Label>
          <Input value={plate} onChange={(e) => setPlate(e.target.value)} required minLength={2} />
          {existing ? <p className="mt-1 text-xs text-ok">✓ {existing.code}</p> : plate.length >= 3 ? <p className="mt-1 text-xs text-muted">New truck</p> : null}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('inspector.direction')}</Label>
            <Select value={direction} onChange={(e) => setDirection(e.target.value as 'INBOUND' | 'OUTBOUND')}>
              <option value="INBOUND">{t('direction.INBOUND')}</option>
              <option value="OUTBOUND">{t('direction.OUTBOUND')}</option>
            </Select>
          </div>
          {!existing ? (
            <div>
              <Label>Truck type</Label>
              <Select value={truckType} onChange={(e) => setTruckType(e.target.value)}>
                {['BOX', 'REEFER', 'FLATBED', 'CAR_CARRIER', 'CONTAINER'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </Select>
            </div>
          ) : null}
        </div>
        <div>
          <Label>{t('yard.reason')}</Label>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} />
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

function VisitPanel({ siteId, visitId, timeZone }: { siteId: string; visitId: string; timeZone: string }) {
  const { t } = useTranslation();
  const can = useAuth((s) => s.can);
  const { data: v } = useVisit(siteId, visitId);
  const [action, setAction] = useState<ActionKind | null>(null);
  if (!v) return <div className="card p-5 text-sm text-muted">{t('common.loading')}</div>;
  const actions = availableActions(v, (p) => can(siteId, p));
  return (
    <div className="card p-5">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-brand">
            {v.truck.carrier?.name} · {t(`direction.${v.direction}`)}
          </div>
          <div className="text-xl font-bold">{v.truck.code}</div>
          <div className="text-sm text-muted">
            {v.truck.plateNumber} · {v.driver?.fullName ?? '—'} · {v.code}
          </div>
        </div>
        <Badge tone={toneFor(v.status)}>{t(`status.${v.status}`)}</Badge>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-2 text-sm">
        {[
          [t('inspector.appointment'), `${formatTime(v.appointmentStart, timeZone)} – ${formatTime(v.appointmentEnd, timeZone)}`],
          [t('inspector.dock'), v.dock?.code ?? '—'],
          [t('inspector.arrived'), formatTime(v.arrivedAt, timeZone)],
          [t('tracking.docked'), formatTime(v.dockedAt, timeZone)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl bg-slate-50 p-2.5">
            <div className="text-[11px] text-muted">{label}</div>
            <div className="font-semibold">{value}</div>
          </div>
        ))}
      </div>
      <div className="mb-5 flex flex-wrap gap-2">
        {actions.map((a) => (
          <Button key={a.kind} variant={a.variant ?? 'default'} size="sm" onClick={() => setAction(a.kind)}>
            {a.icon} {t(`yard.${a.kind}`)}
          </Button>
        ))}
        {actions.length === 0 ? <span className="text-sm text-muted">—</span> : null}
      </div>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">Timeline</div>
      <ol className="mt-2 space-y-2">
        {v.timeline
          .slice()
          .reverse()
          .map((e, i) => (
            <li key={i} className="flex gap-3 text-sm">
              <span className="tabular w-12 text-muted">{formatTime(e.at, timeZone)}</span>
              <span className="flex-1">
                <span className="font-medium">{e.action.replace(/_/g, ' ').toLowerCase()}</span>
                {e.note ? <span className="text-muted"> — {e.note}</span> : null}
              </span>
              <span className="text-xs text-muted">{e.actor}</span>
            </li>
          ))}
      </ol>
      {action ? <ActionDialog siteId={siteId} visit={v} kind={action} onClose={() => setAction(null)} /> : null}
    </div>
  );
}

/** Màn hình Cổng & Bãi 2D (UC-01, UC-02, UC-03) — dùng được trên tablet (NFR-11). */
export function YardPage() {
  const { t } = useTranslation();
  const { siteId, timeZone } = useSiteContext();
  const can = useAuth((s) => s.can);
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const [q, setQ] = useState('');
  const [walkIn, setWalkIn] = useState(false);
  const { data: visits } = useVisits(siteId, filter === 'active' ? ACTIVE : undefined);
  const selected = params.get('visit');
  const rows = useMemo(
    () => (visits ?? []).filter((v) => !q || [v.code, v.truck.code, v.truck.plateNumber, v.truck.carrier?.name ?? ''].some((s) => s.toLowerCase().includes(q.toLowerCase()))),
    [visits, q],
  );

  return (
    <div className="h-full overflow-auto px-4 pb-6 pt-[76px]">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-4 lg:grid-cols-[1fr_420px]">
        <div className="card p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="mr-auto text-lg font-bold">{t('yard.title')}</h2>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <Input className="w-56 pl-8" placeholder={t('yard.lookup')} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <Select className="w-36" value={filter} onChange={(e) => setFilter(e.target.value as 'active' | 'all')}>
              <option value="active">{t('yard.filterActive')}</option>
              <option value="all">{t('yard.filterAll')}</option>
            </Select>
            {can(siteId, 'yard.visit.create_walkin') ? (
              <Button onClick={() => setWalkIn(true)}>
                <Plus size={14} /> {t('yard.walkIn')}
              </Button>
            ) : null}
          </div>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="py-2 font-medium">{t('ops.trucks')}</th>
                  <th className="font-medium">{t('inspector.carrier')}</th>
                  <th className="font-medium">{t('inspector.direction')}</th>
                  <th className="font-medium">{t('inspector.appointment')}</th>
                  <th className="font-medium">{t('inspector.dock')}</th>
                  <th className="font-medium">{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => (
                  <tr key={v.id} onClick={() => setParams({ visit: v.id })} className={cn('cursor-pointer border-b border-line/60 hover:bg-slate-50', selected === v.id && 'bg-brand-soft/60')}>
                    <td className="py-2.5">
                      <div className="font-semibold">{v.truck.code}</div>
                      <div className="text-xs text-muted">
                        {v.truck.plateNumber} · {v.code}
                      </div>
                    </td>
                    <td>{v.truck.carrier?.name ?? '—'}</td>
                    <td>{t(`direction.${v.direction}`)}</td>
                    <td className="tabular">{v.unscheduled ? <Badge tone="warn">walk-in</Badge> : formatTime(v.appointmentStart, timeZone)}</td>
                    <td>{v.dock?.code ?? '—'}</td>
                    <td>
                      <Badge tone={toneFor(v.status)}>{t(`status.${v.status}`)}</Badge>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-muted">
                      {t('yard.noVisits')}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
        <div>{selected ? <VisitPanel siteId={siteId} visitId={selected} timeZone={timeZone} /> : <div className="card p-6 text-sm text-muted">{t('tracking.selectTruck')}</div>}</div>
      </div>
      {walkIn ? <WalkInDialog siteId={siteId} onClose={() => setWalkIn(false)} onCreated={(id) => setParams({ visit: id })} /> : null}
    </div>
  );
}
