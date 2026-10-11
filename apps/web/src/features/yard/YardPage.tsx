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
function availableActions(visit: VisitRow, can: (permission: string) => boolean): Array<{ kind: ActionKind; icon: ReactNode; variant?: 'default' | 'secondary' | 'outline' | 'danger' }> {
  const actions: Array<{ kind: ActionKind; icon: ReactNode; variant?: 'default' | 'secondary' | 'outline' | 'danger' }> = [];
  const add = (kind: ActionKind, perm: string, icon: ReactNode, variant?: 'default' | 'secondary' | 'outline' | 'danger') => can(perm) && actions.push({ kind, icon, variant });
  switch (visit.status) {
    case 'SCHEDULED':
      add('arrive', 'yard.visit.gate_in', <LogIn size={14} />);
      add('assignDock', 'yard.dock.assign', <Warehouse size={14} />, 'secondary');
      if (visit.dock) add('unassignDock', 'yard.dock.assign', <Undo2 size={14} />, 'outline');
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
  return actions;
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
  const queryClient = useQueryClient();
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
      queryClient.setQueryData(['site', siteId, 'visit', visit.id], updated);
      void queryClient.invalidateQueries({ queryKey: ['site', siteId, 'visits'] });
      void queryClient.invalidateQueries({ queryKey: ['site', siteId, 'docks'] });
      onClose();
    },
  });

  const compatible = (dock: LocationDto) => visit.direction === 'BOTH' || dock.dockDirection === 'BOTH' || dock.dockDirection === visit.direction;
  const needsReason = ['reject', 'abort', 'cancel'].includes(kind);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={t(`yard.${kind}`)} description={`${visit.truck.code} · ${visit.code} · ${t(`status.${visit.status}`)}`}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        {kind === 'arrive' ? (
          <>
            <div>
              <Label>{t('yard.plate')}</Label>
              <Input value={plate} onChange={(event) => setPlate(event.target.value)} />
            </div>
            <div>
              <Label>{t('yard.reason')} (late / early)</Label>
              <Input value={reason} onChange={(event) => setReason(event.target.value)} />
            </div>
          </>
        ) : null}
        {kind === 'verify' ? (
          <div>
            <Label>{t('yard.checklist')}</Label>
            <div className="space-y-1.5">
              {settings?.gateDocumentChecklist.map((checkItem) => (
                <label key={checkItem.key} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
                  <input type="checkbox" checked={!!checks[checkItem.key]} onChange={(event) => setChecks((previous) => ({ ...previous, [checkItem.key]: event.target.checked }))} />
                  {i18n.language === 'vi' ? checkItem.vi : checkItem.en}
                  {checkItem.required ? <span className="ml-auto text-xs text-bad">*</span> : null}
                </label>
              ))}
            </div>
          </div>
        ) : null}
        {kind === 'assignDock' ? (
          <div className="grid grid-cols-3 gap-2">
            {docks?.map((dock) => {
              const disabled = dock.effectiveStatus !== 'AVAILABLE' || !compatible(dock);
              return (
                <button
                  key={dock.id}
                  type="button"
                  disabled={disabled && dock.id !== visit.dock?.id}
                  onClick={() => setDockId(dock.id)}
                  className={cn('rounded-xl border p-2.5 text-left text-sm', dockId === dock.id ? 'border-brand bg-brand-soft' : 'border-line', disabled && 'cursor-not-allowed opacity-50')}
                >
                  <div className="font-semibold">{dock.name ?? dock.code}</div>
                  <div className="text-xs text-muted">
                    {dock.name ? `${dock.code} · ` : ''}
                    {t(`direction.${dock.dockDirection ?? 'BOTH'}`)}
                  </div>
                  <Badge tone={toneFor(dock.effectiveStatus)} className="mt-1">
                    {t(`status.${dock.effectiveStatus}`)}
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
            <Input value={reason} onChange={(event) => setReason(event.target.value)} required minLength={3} />
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
  const queryClient = useQueryClient();
  const [plate, setPlate] = useState('');
  const [direction, setDirection] = useState<'INBOUND' | 'OUTBOUND'>('INBOUND');
  const [truckType, setTruckType] = useState('BOX');
  const [reason, setReason] = useState('');
  const [idemKey] = useState(() => crypto.randomUUID());
  const { data: trucks } = useQuery({ queryKey: ['trucks', plate], queryFn: () => api<{ items: Array<{ id: string; code: string; plateNumber: string }> }>(`/trucks?plate=${encodeURIComponent(plate)}`), enabled: plate.length >= 3 });
  const existing = trucks?.items.find((truck) => truck.plateNumber === plate.replace(/[\s.-]/g, '').toUpperCase());
  const createWalkIn = useMutation({
    mutationFn: () =>
      api<VisitDetail>(`/sites/${siteId}/visits/walk-in`, {
        method: 'POST',
        idempotencyKey: idemKey,
        body: { direction, actualPlate: plate, reason, ...(existing ? { truckId: existing.id } : { newTruck: { plateNumber: plate, truckType } }) },
      }),
    onSuccess: (createdVisit) => {
      void queryClient.invalidateQueries({ queryKey: ['site', siteId, 'visits'] });
      onCreated(createdVisit.id);
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={t('yard.walkIn')} description="UC-01 A1">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          createWalkIn.mutate();
        }}
      >
        <div>
          <Label>{t('yard.plate')}</Label>
          <Input value={plate} onChange={(event) => setPlate(event.target.value)} required minLength={2} />
          {existing ? <p className="mt-1 text-xs text-ok">✓ {existing.code}</p> : plate.length >= 3 ? <p className="mt-1 text-xs text-muted">New truck</p> : null}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('inspector.direction')}</Label>
            <Select value={direction} onChange={(event) => setDirection(event.target.value as 'INBOUND' | 'OUTBOUND')}>
              <option value="INBOUND">{t('direction.INBOUND')}</option>
              <option value="OUTBOUND">{t('direction.OUTBOUND')}</option>
            </Select>
          </div>
          {!existing ? (
            <div>
              <Label>Truck type</Label>
              <Select value={truckType} onChange={(event) => setTruckType(event.target.value)}>
                {['BOX', 'REEFER', 'FLATBED', 'CAR_CARRIER', 'CONTAINER'].map((typeOption) => (
                  <option key={typeOption}>{typeOption}</option>
                ))}
              </Select>
            </div>
          ) : null}
        </div>
        <div>
          <Label>{t('yard.reason')}</Label>
          <Input value={reason} onChange={(event) => setReason(event.target.value)} required minLength={3} />
        </div>
        {createWalkIn.isError ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(createWalkIn.error)}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={createWalkIn.isPending}>
            {t('common.confirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function VisitPanel({ siteId, visitId, timeZone }: { siteId: string; visitId: string; timeZone: string }) {
  const { t } = useTranslation();
  const can = useAuth((state) => state.can);
  const { data: visit } = useVisit(siteId, visitId);
  const [action, setAction] = useState<ActionKind | null>(null);
  if (!visit) return <div className="card p-5 text-sm text-muted">{t('common.loading')}</div>;
  const actions = availableActions(visit, (permission) => can(siteId, permission));
  return (
    <div className="card p-5">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-brand">
            {visit.truck.carrier?.name} · {t(`direction.${visit.direction}`)}
          </div>
          <div className="text-xl font-bold">{visit.truck.code}</div>
          <div className="text-sm text-muted">
            {visit.truck.plateNumber} · {visit.driver?.fullName ?? '—'} · {visit.code}
          </div>
        </div>
        <Badge tone={toneFor(visit.status)}>{t(`status.${visit.status}`)}</Badge>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-2 text-sm">
        {[
          [t('inspector.appointment'), `${formatTime(visit.appointmentStart, timeZone)} – ${formatTime(visit.appointmentEnd, timeZone)}`],
          [t('inspector.dock'), visit.dock?.code ?? '—'],
          [t('inspector.arrived'), formatTime(visit.arrivedAt, timeZone)],
          [t('tracking.docked'), formatTime(visit.dockedAt, timeZone)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl bg-slate-50 p-2.5">
            <div className="text-[11px] text-muted">{label}</div>
            <div className="font-semibold">{value}</div>
          </div>
        ))}
      </div>
      <div className="mb-5 flex flex-wrap gap-2">
        {actions.map((visitAction) => (
          <Button key={visitAction.kind} variant={visitAction.variant ?? 'default'} size="sm" onClick={() => setAction(visitAction.kind)}>
            {visitAction.icon} {t(`yard.${visitAction.kind}`)}
          </Button>
        ))}
        {actions.length === 0 ? <span className="text-sm text-muted">—</span> : null}
      </div>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">Timeline</div>
      <ol className="mt-2 space-y-2">
        {visit.timeline
          .slice()
          .reverse()
          .map((event, eventIndex) => (
            <li key={eventIndex} className="flex gap-3 text-sm">
              <span className="tabular w-12 text-muted">{formatTime(event.at, timeZone)}</span>
              <span className="flex-1">
                <span className="font-medium">{event.action.replace(/_/g, ' ').toLowerCase()}</span>
                {event.note ? <span className="text-muted"> — {event.note}</span> : null}
              </span>
              <span className="text-xs text-muted">{event.actor}</span>
            </li>
          ))}
      </ol>
      {action ? <ActionDialog siteId={siteId} visit={visit} kind={action} onClose={() => setAction(null)} /> : null}
    </div>
  );
}

/** Màn hình Cổng & Bãi 2D (UC-01, UC-02, UC-03) — dùng được trên tablet (NFR-11). */
export function YardPage() {
  const { t } = useTranslation();
  const { siteId, timeZone } = useSiteContext();
  const can = useAuth((state) => state.can);
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const [search, setSearch] = useState('');
  const [walkIn, setWalkIn] = useState(false);
  const { data: visits } = useVisits(siteId, filter === 'active' ? ACTIVE : undefined);
  const selected = params.get('visit');
  const rows = useMemo(
    () => (visits ?? []).filter((visit) => !search || [visit.code, visit.truck.code, visit.truck.plateNumber, visit.truck.carrier?.name ?? ''].some((field) => field.toLowerCase().includes(search.toLowerCase()))),
    [visits, search],
  );

  return (
    <div className="h-full overflow-auto px-4 pb-6 pt-[76px]">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-4 lg:grid-cols-[1fr_420px]">
        <div className="card p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="mr-auto text-lg font-bold">{t('yard.title')}</h2>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <Input className="w-56 pl-8" placeholder={t('yard.lookup')} value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <Select className="w-36" value={filter} onChange={(event) => setFilter(event.target.value as 'active' | 'all')}>
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
                {rows.map((visit) => (
                  <tr key={visit.id} onClick={() => setParams({ visit: visit.id })} className={cn('cursor-pointer border-b border-line/60 hover:bg-slate-50', selected === visit.id && 'bg-brand-soft/60')}>
                    <td className="py-2.5">
                      <div className="font-semibold">{visit.truck.code}</div>
                      <div className="text-xs text-muted">
                        {visit.truck.plateNumber} · {visit.code}
                      </div>
                    </td>
                    <td>{visit.truck.carrier?.name ?? '—'}</td>
                    <td>{t(`direction.${visit.direction}`)}</td>
                    <td className="tabular">{visit.unscheduled ? <Badge tone="warn">walk-in</Badge> : formatTime(visit.appointmentStart, timeZone)}</td>
                    <td>{visit.dock?.code ?? '—'}</td>
                    <td>
                      <Badge tone={toneFor(visit.status)}>{t(`status.${visit.status}`)}</Badge>
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
