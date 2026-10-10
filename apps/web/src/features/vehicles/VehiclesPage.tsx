import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { VehicleStayDto } from '@waretrack/shared-schemas';
import { Car, CheckCircle2, ClipboardCheck, History, LogOut, MapPin, MoveRight, ParkingSquare, Plus, ShieldAlert, ShieldCheck, ShieldOff, ThumbsDown, ThumbsUp, Undo2, UserCheck, XCircle } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { ScanInput } from '@/components/ScanInput';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { ApiError, api, describeError } from '@/lib/api';
import { useParkingSlots, useVehicleHistory, useVehicleStays } from '@/lib/queries';
import { cn, formatDateTime } from '@/lib/utils';
import { useAuth } from '@/stores/auth';
import { useScene } from '@/stores/scene';
import { useSiteContext } from '../shell/SiteShell';

export const STAY_TONE: Record<string, BadgeTone> = {
  EXPECTED: 'neutral',
  RECEIVED: 'info',
  INSPECTED: 'info',
  ALLOCATED: 'warn',
  STORED: 'ok',
  RELEASE_REQUESTED: 'warn',
  RELEASED: 'info',
  EXITED: 'neutral',
  CANCELLED: 'neutral',
};
const CONDITION_TONE: Record<string, BadgeTone> = { OK: 'ok', MINOR_DAMAGE: 'warn', MAJOR_DAMAGE: 'bad', NEEDS_SERVICE: 'warn' };
const FILTERS = ['all', 'incoming', 'stored', 'hold', 'release'] as const;
type Filter = (typeof FILTERS)[number];
const matchFilter = (v: VehicleStayDto, f: Filter) =>
  f === 'all' ||
  (f === 'incoming' && ['EXPECTED', 'RECEIVED', 'INSPECTED', 'ALLOCATED'].includes(v.status)) ||
  (f === 'stored' && v.status === 'STORED') ||
  (f === 'hold' && v.holdFlag) ||
  (f === 'release' && ['RELEASE_REQUESTED', 'RELEASED'].includes(v.status));

type Settings = { vehicleInspectionChecklist: Array<{ key: string; vi: string; en: string; required: boolean }> };

function useRun(siteId: string, onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api<VehicleStayDto>(`/sites/${siteId}${path}`, { method: 'POST', body: body ?? {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['site', siteId, 'vehicles'] });
      void qc.invalidateQueries({ queryKey: ['vehicle-history'] });
      onDone?.();
    },
  });
}

function ErrorNote({ error }: { error: unknown }) {
  return error ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(error)}</p> : null;
}

function FormDialog({ title, onClose, onSubmit, pending, error, children, submitLabel }: { title: string; onClose: () => void; onSubmit: () => void; pending: boolean; error: unknown; children: ReactNode; submitLabel?: string }) {
  const { t } = useTranslation();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={title} className="w-[min(92vw,520px)]">
      <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), onSubmit())}>
        {children}
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={pending}>
            {submitLabel ?? t('common.confirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** UC-04 bước 1: khai báo xe sắp nhận theo VIN (DEC-22: sai check digit → hỏi xác nhận). */
function CreateStayDialog({ siteId, onClose, onCreated }: { siteId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState({ vin: '', make: '', model: '', modelYear: '', color: '', plateNumber: '' });
  const [confirmCheck, setConfirmCheck] = useState(false);
  const run = useRun(siteId);
  const needsConfirm = run.error instanceof ApiError && run.error.code === 'VIN_CHECK_DIGIT_CONFIRM_REQUIRED';
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <FormDialog
      title={t('vehicles.newStay')}
      onClose={onClose}
      pending={run.isPending}
      error={needsConfirm ? null : run.error}
      onSubmit={() =>
        run.mutate(
          {
            path: '/vehicle-stays',
            body: {
              vin: f.vin,
              ...(f.make ? { make: f.make } : {}),
              ...(f.model ? { model: f.model } : {}),
              ...(f.modelYear ? { modelYear: Number(f.modelYear) } : {}),
              ...(f.color ? { color: f.color } : {}),
              ...(f.plateNumber ? { plateNumber: f.plateNumber } : {}),
              ...(confirmCheck ? { acceptCheckDigit: true } : {}),
            },
          },
          { onSuccess: (s) => (onCreated(s.id), onClose()) },
        )
      }
    >
      <div>
        <Label>VIN</Label>
        <Input value={f.vin} onChange={set('vin')} maxLength={17} className="font-mono uppercase" placeholder="17 characters" required />
      </div>
      {needsConfirm ? (
        <label className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
          <input type="checkbox" className="mt-1" checked={confirmCheck} onChange={(e) => setConfirmCheck(e.target.checked)} />
          {t('vehicles.checkDigitWarn')}
        </label>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>{t('vehicles.make')}</Label>
          <Input value={f.make} onChange={set('make')} />
        </div>
        <div>
          <Label>{t('vehicles.model')}</Label>
          <Input value={f.model} onChange={set('model')} />
        </div>
        <div>
          <Label>{t('vehicles.year')}</Label>
          <Input value={f.modelYear} onChange={set('modelYear')} inputMode="numeric" />
        </div>
        <div>
          <Label>{t('vehicles.color')}</Label>
          <Input value={f.color} onChange={set('color')} />
        </div>
        <div className="col-span-2">
          <Label>{t('vehicles.plate')}</Label>
          <Input value={f.plateNumber} onChange={set('plateNumber')} />
        </div>
      </div>
    </FormDialog>
  );
}

function ReceiveDialog({ siteId, stay, onClose }: { siteId: string; stay: VehicleStayDto; onClose: () => void }) {
  const { t } = useTranslation();
  const [vin, setVin] = useState('');
  const [odo, setOdo] = useState('');
  const [fuel, setFuel] = useState('');
  const [keyTag, setKeyTag] = useState('');
  const run = useRun(siteId, onClose);
  return (
    <FormDialog
      title={`${t('vehicles.actions.receive')} · ${stay.vehicle.vin}`}
      onClose={onClose}
      pending={run.isPending}
      error={run.error}
      onSubmit={() =>
        run.mutate({
          path: `/vehicle-stays/${stay.id}/receive`,
          body: { scan: { method: 'BARCODE', value: vin, scannedAt: new Date().toISOString() }, ...(odo ? { odometerKm: Number(odo) } : {}), ...(fuel ? { fuelOrBatteryPct: Number(fuel) } : {}), ...(keyTag ? { keyTag } : {}), expectedVersion: stay.version },
        })
      }
    >
      <div>
        <Label>{t('vehicles.scanVin')}</Label>
        <ScanInput value={vin} onChange={setVin} placeholder={stay.vehicle.vin} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label>{t('vehicles.odometer')}</Label>
          <Input value={odo} onChange={(e) => setOdo(e.target.value)} inputMode="numeric" />
        </div>
        <div>
          <Label>{t('vehicles.fuel')}</Label>
          <Input value={fuel} onChange={(e) => setFuel(e.target.value)} inputMode="numeric" />
        </div>
        <div>
          <Label>{t('vehicles.keyTag')}</Label>
          <Input value={keyTag} onChange={(e) => setKeyTag(e.target.value)} />
        </div>
      </div>
    </FormDialog>
  );
}

/** UC-04 bước 4–5: checklist theo cấu hình site (DEC-20). */
function InspectDialog({ siteId, stay, onClose }: { siteId: string; stay: VehicleStayDto; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { data: settings } = useQuery({ queryKey: ['site', siteId, 'settings'], queryFn: () => api<Settings>(`/sites/${siteId}/settings`), staleTime: 60_000 });
  const items = settings?.vehicleInspectionChecklist ?? [];
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [condition, setCondition] = useState('OK');
  const [hold, setHold] = useState('');
  const run = useRun(siteId, onClose);
  const periodic = stay.status !== 'RECEIVED';
  return (
    <FormDialog
      title={`${t('vehicles.actions.inspect')} · ${stay.vehicle.vin}`}
      onClose={onClose}
      pending={run.isPending}
      error={run.error}
      onSubmit={() =>
        run.mutate({
          path: `/vehicle-stays/${stay.id}/inspections`,
          body: { inspectionType: periodic ? 'PERIODIC' : 'RECEIVING', checklist: items.map((c) => ({ key: c.key, passed: !!checked[c.key] })), resultCondition: condition, ...(hold ? { setHold: { reason: hold } } : {}), expectedVersion: stay.version },
        })
      }
    >
      <div className="space-y-1.5">
        {items.map((c) => (
          <label key={c.key} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
            <input type="checkbox" checked={!!checked[c.key]} onChange={(e) => setChecked((x) => ({ ...x, [c.key]: e.target.checked }))} />
            <span className="flex-1">{i18n.language === 'vi' ? c.vi : c.en}</span>
            {c.required ? <Badge tone="info">{t('vehicles.required')}</Badge> : null}
          </label>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>{t('vehicles.condition')}</Label>
          <Select value={condition} onChange={(e) => setCondition(e.target.value)}>
            {['OK', 'MINOR_DAMAGE', 'MAJOR_DAMAGE', 'NEEDS_SERVICE'].map((c) => (
              <option key={c} value={c}>
                {t(`vehicles.conditionLabel.${c}`)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>{t('vehicles.holdOptional')}</Label>
          <Input value={hold} onChange={(e) => setHold(e.target.value)} placeholder={t('yard.reason')} />
        </div>
      </div>
    </FormDialog>
  );
}

/** Chọn ô đỗ còn trống (UC-06) — gợi ý ô đầu tiên trống; dùng cho cấp ô và di chuyển. */
function SlotDialog({ siteId, stay, mode, onClose }: { siteId: string; stay: VehicleStayDto; mode: 'allocate' | 'move'; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: slots } = useParkingSlots(siteId);
  const free = useMemo(() => (slots ?? []).filter((l) => l.effectiveStatus === 'AVAILABLE'), [slots]);
  const [slotId, setSlotId] = useState('');
  const [reason, setReason] = useState('');
  const run = useRun(siteId, onClose);
  const chosen = slotId || free[0]?.id || '';
  return (
    <FormDialog
      title={`${t(mode === 'allocate' ? 'vehicles.actions.allocate' : 'vehicles.actions.move')} · ${stay.vehicle.vin}`}
      onClose={onClose}
      pending={run.isPending}
      error={run.error}
      onSubmit={() =>
        run.mutate(
          mode === 'allocate'
            ? { path: `/vehicle-stays/${stay.id}/allocate-slot`, body: { slotLocationId: chosen, expectedVersion: stay.version } }
            : { path: `/vehicle-stays/${stay.id}/move`, body: { toLocationId: chosen, reason: reason || 'Re-slotting' } },
        )
      }
    >
      <div>
        <Label>
          {t('vehicles.slot')} <span className="text-muted">({free.length} {t('vehicles.free')})</span>
        </Label>
        <div className="grid max-h-56 grid-cols-5 gap-1.5 overflow-auto rounded-lg border border-line p-2">
          {free.map((l) => (
            <button type="button" key={l.id} onClick={() => setSlotId(l.id)} className={cn('rounded-md border px-1 py-1.5 text-xs font-medium', chosen === l.id ? 'border-brand bg-brand text-white' : 'border-line hover:border-brand')}>
              {l.code}
            </button>
          ))}
        </div>
      </div>
      {mode === 'move' ? (
        <div>
          <Label>{t('yard.reason')}</Label>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Re-slotting" />
        </div>
      ) : null}
    </FormDialog>
  );
}

function ScanSlotDialog({ siteId, stay, onClose }: { siteId: string; stay: VehicleStayDto; onClose: () => void }) {
  const { t } = useTranslation();
  const [scan, setScan] = useState('');
  const run = useRun(siteId, onClose);
  return (
    <FormDialog
      title={`${t('vehicles.actions.parked')} · ${stay.vehicle.vin}`}
      onClose={onClose}
      pending={run.isPending}
      error={run.error}
      onSubmit={() => run.mutate({ path: `/vehicle-stays/${stay.id}/confirm-parked`, body: { scan: { method: 'QR', value: scan, scannedAt: new Date().toISOString() }, expectedVersion: stay.version } })}
    >
      <p className="text-sm text-muted">
        {t('vehicles.reservedSlot')}: <b className="text-ink">{stay.position.location?.code ?? '—'}</b>
      </p>
      <ScanInput value={scan} onChange={setScan} placeholder={stay.position.location?.code ?? 'P-A-001'} />
    </FormDialog>
  );
}

function TextDialog({ title, label, fields, onClose, onSubmit, run }: { title: string; label: string; fields?: 'release'; onClose: () => void; onSubmit: (v: { text: string; recipient: string }) => void; run: { isPending: boolean; error: unknown } }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [recipient, setRecipient] = useState('');
  return (
    <FormDialog title={title} onClose={onClose} pending={run.isPending} error={run.error} onSubmit={() => onSubmit({ text, recipient })}>
      <div>
        <Label>{label}</Label>
        <Input value={text} onChange={(e) => setText(e.target.value)} required minLength={3} />
      </div>
      {fields === 'release' ? (
        <div>
          <Label>{t('vehicles.recipient')}</Label>
          <Input value={recipient} onChange={(e) => setRecipient(e.target.value)} required minLength={2} />
        </div>
      ) : null}
    </FormDialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="text-sm font-semibold">{children}</div>
    </div>
  );
}

type DialogKind = 'receive' | 'inspect' | 'allocate' | 'move' | 'parked' | 'hold' | 'unhold' | 'release' | 'cancel' | null;

function StayDetail({ siteId, siteCode, stay, timeZone }: { siteId: string; siteCode: string; stay: VehicleStayDto; timeZone: string }) {
  const { t } = useTranslation();
  const can = useAuth((s) => s.can);
  const navigate = useNavigate();
  const select = useScene((s) => s.select);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const run = useRun(siteId, () => setDialog(null));
  const { data: history } = useVehicleHistory(stay.vehicle.vin);
  const req = stay.releaseRequest;
  const atRelease = stay.position.kind === 'OCCUPIED' && stay.position.location?.code.startsWith('REL');
  const post = (path: string, body: unknown = { expectedVersion: stay.version }) => run.mutate({ path: `/vehicle-stays/${stay.id}${path}`, body });
  const close = () => setDialog(null);

  const actions: Array<{ show: boolean; label: string; icon: ReactNode; onClick: () => void; variant?: 'outline' | 'danger' }> = [
    { show: stay.status === 'EXPECTED' && can(siteId, 'vehicle.receive'), label: t('vehicles.actions.receive'), icon: <UserCheck size={14} />, onClick: () => setDialog('receive') },
    { show: stay.status === 'RECEIVED' && can(siteId, 'vehicle.inspect'), label: t('vehicles.actions.inspect'), icon: <ClipboardCheck size={14} />, onClick: () => setDialog('inspect') },
    { show: stay.status === 'INSPECTED' && can(siteId, 'vehicle.slot.assign'), label: t('vehicles.actions.allocate'), icon: <ParkingSquare size={14} />, onClick: () => setDialog('allocate') },
    { show: stay.status === 'ALLOCATED' && can(siteId, 'vehicle.move'), label: t('vehicles.actions.parked'), icon: <CheckCircle2 size={14} />, onClick: () => setDialog('parked') },
    { show: stay.status === 'ALLOCATED' && can(siteId, 'vehicle.slot.assign'), label: t('vehicles.actions.unallocate'), icon: <Undo2 size={14} />, onClick: () => post('/release-allocation'), variant: 'outline' },
    { show: stay.status === 'STORED' && !stay.openTask && can(siteId, 'vehicle.slot.assign'), label: t('vehicles.actions.move'), icon: <MoveRight size={14} />, onClick: () => setDialog('move'), variant: 'outline' },
    { show: stay.status === 'STORED' && can(siteId, 'vehicle.release.request'), label: t('vehicles.actions.requestRelease'), icon: <LogOut size={14} />, onClick: () => setDialog('release') },
    { show: req?.status === 'PENDING' && can(siteId, 'vehicle.release.approve'), label: t('vehicles.actions.approve'), icon: <ThumbsUp size={14} />, onClick: () => run.mutate({ path: `/release-requests/${req!.id}/approve`, body: { expectedVersion: req!.version } }) },
    { show: req?.status === 'PENDING' && can(siteId, 'vehicle.release.approve'), label: t('vehicles.actions.reject'), icon: <ThumbsDown size={14} />, onClick: () => run.mutate({ path: `/release-requests/${req!.id}/reject`, body: { expectedVersion: req!.version, note: 'Rejected' } }), variant: 'outline' },
    { show: req?.status === 'APPROVED' && !!atRelease && can(siteId, 'vehicle.gate_out'), label: t('vehicles.actions.handover'), icon: <UserCheck size={14} />, onClick: () => post('/handover') },
    { show: stay.status === 'RELEASED' && can(siteId, 'vehicle.gate_out'), label: t('vehicles.actions.gateOut'), icon: <LogOut size={14} />, onClick: () => post('/gate-out') },
    { show: !stay.holdFlag && !['EXITED', 'CANCELLED', 'RELEASED'].includes(stay.status) && can(siteId, 'vehicle.hold.manage'), label: t('vehicles.actions.hold'), icon: <ShieldAlert size={14} />, onClick: () => setDialog('hold'), variant: 'outline' },
    { show: stay.holdFlag && can(siteId, 'vehicle.hold.manage'), label: t('vehicles.actions.unhold'), icon: <ShieldOff size={14} />, onClick: () => setDialog('unhold'), variant: 'outline' },
    { show: ['STORED', 'RELEASE_REQUESTED'].includes(stay.status) && can(siteId, 'vehicle.inspect'), label: t('vehicles.actions.reinspect'), icon: <ShieldCheck size={14} />, onClick: () => setDialog('inspect'), variant: 'outline' },
    { show: ['EXPECTED', 'RECEIVED'].includes(stay.status) && can(siteId, 'vehicle.receive'), label: t('common.cancel'), icon: <XCircle size={14} />, onClick: () => setDialog('cancel'), variant: 'danger' },
  ];

  return (
    <div className="card space-y-4 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-soft text-brand">
          <Car size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-xl font-bold tracking-wide">{stay.vehicle.vin}</div>
          <div className="text-sm text-muted">
            {[stay.vehicle.modelYear, stay.vehicle.make, stay.vehicle.model].filter(Boolean).join(' ')} {stay.vehicle.color ? `· ${stay.vehicle.color}` : ''} {stay.owner ? `· ${stay.owner.name}` : ''}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Badge tone={STAY_TONE[stay.status]}>{t(`vehicles.status.${stay.status}`)}</Badge>
            <Badge tone={CONDITION_TONE[stay.conditionStatus]}>{t(`vehicles.conditionLabel.${stay.conditionStatus}`)}</Badge>
            {stay.holdFlag ? (
              <Badge tone="bad">
                <ShieldAlert size={12} /> {t('vehicles.onHold')}
              </Badge>
            ) : null}
          </div>
        </div>
        {stay.position.location ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              navigate(`/sites/${siteCode}`);
              setTimeout(() => select({ siteId, type: 'vehicle', id: stay.id }), 400);
            }}
          >
            <MapPin size={14} /> {t('vehicles.showOnMap')}
          </Button>
        ) : null}
      </div>
      {stay.holdFlag ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{stay.holdReason}</p> : null}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Field label={t('vehicles.position')}>
          {stay.position.location?.code ?? '—'} {stay.position.kind === 'RESERVED' ? <span className="text-xs font-normal text-warn">({t('status.RESERVED')})</span> : null}
        </Field>
        <Field label={t('inspector.source')}>{stay.position.source ? t(`source.${stay.position.source}`) : '—'}</Field>
        <Field label={t('vehicles.plate')}>{stay.vehicle.plateNumber ?? '—'}</Field>
        <Field label={t('vehicles.keyTag')}>{stay.keyTag ?? '—'}</Field>
        <Field label={t('vehicles.odometer')}>{stay.odometerKm != null ? `${stay.odometerKm.toLocaleString()} km` : '—'}</Field>
        <Field label={t('vehicles.fuel')}>{stay.fuelOrBatteryPct != null ? `${stay.fuelOrBatteryPct}%` : '—'}</Field>
        <Field label={t('vehicles.received')}>{stay.receivedAt ? formatDateTime(stay.receivedAt, timeZone) : stay.expectedAt ? `ETA ${formatDateTime(stay.expectedAt, timeZone)}` : '—'}</Field>
        <Field label={t('vehicles.openTask')}>{stay.openTask ? `${stay.openTask.code} → ${stay.openTask.toCode ?? ''}` : '—'}</Field>
      </div>
      {req ? (
        <div className="rounded-xl border border-warn/40 bg-warn-soft/40 p-3 text-sm">
          <div className="flex items-center gap-2 font-semibold">
            <LogOut size={14} /> {t('vehicles.releaseRequest')} <Badge tone={req.status === 'PENDING' ? 'warn' : 'ok'}>{t(`vehicles.releaseStatus.${req.status}`)}</Badge>
          </div>
          <div className="mt-1 text-muted">
            {req.reason} · {t('vehicles.recipient')}: {req.recipientName} · {t('vehicles.requestedBy')}: {req.requestedBy}
          </div>
          {req.status === 'APPROVED' && !atRelease ? <div className="mt-1 text-xs text-warn">{t('vehicles.waitingRelease')}</div> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {actions
          .filter((a) => a.show)
          .map((a) => (
            <Button key={a.label} size="sm" variant={a.variant} onClick={a.onClick} disabled={run.isPending}>
              {a.icon} {a.label}
            </Button>
          ))}
      </div>
      {!dialog ? <ErrorNote error={run.error} /> : null}
      <div>
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <History size={14} /> {t('vehicles.history')}
        </div>
        <ol className="relative space-y-2 border-l border-line pl-4">
          {history?.slice(0, 20).map((h, i) => (
            <li key={i} className="text-sm">
              <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-brand" />
              <div className="font-medium">{t(`vehicles.audit.${h.action}`, { defaultValue: h.action })}</div>
              <div className="text-xs text-muted">
                {formatDateTime(h.at, timeZone)} · {h.actor ?? '—'} {h.site ? `· ${h.site}` : ''} {h.detail ? `· ${h.detail}` : ''}
              </div>
            </li>
          ))}
        </ol>
      </div>

      {dialog === 'receive' ? <ReceiveDialog siteId={siteId} stay={stay} onClose={close} /> : null}
      {dialog === 'inspect' ? <InspectDialog siteId={siteId} stay={stay} onClose={close} /> : null}
      {dialog === 'allocate' || dialog === 'move' ? <SlotDialog siteId={siteId} stay={stay} mode={dialog} onClose={close} /> : null}
      {dialog === 'parked' ? <ScanSlotDialog siteId={siteId} stay={stay} onClose={close} /> : null}
      {dialog === 'hold' || dialog === 'unhold' ? (
        <TextDialog title={t(dialog === 'hold' ? 'vehicles.actions.hold' : 'vehicles.actions.unhold')} label={t('yard.reason')} onClose={close} run={run} onSubmit={({ text }) => post(dialog === 'hold' ? '/hold' : '/release-hold', { reason: text, expectedVersion: stay.version })} />
      ) : null}
      {dialog === 'release' ? <TextDialog title={t('vehicles.actions.requestRelease')} label={t('yard.reason')} fields="release" onClose={close} run={run} onSubmit={({ text, recipient }) => post('/release-requests', { reason: text, recipientName: recipient })} /> : null}
      {dialog === 'cancel' ? <TextDialog title={t('common.cancel')} label={t('yard.reason')} onClose={close} run={run} onSubmit={({ text }) => post('/cancel', { reason: text, expectedVersion: stay.version })} /> : null}
    </div>
  );
}

/** Bãi lưu xe (UC-04 → UC-07): danh sách theo VIN, vòng đời, thao tác theo quyền. */
export function VehiclesPage() {
  const { t } = useTranslation();
  const { siteId, siteCode, timeZone } = useSiteContext();
  const can = useAuth((s) => s.can);
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [create, setCreate] = useState(false);
  const { data: stays } = useVehicleStays(siteId);
  const { data: slots } = useParkingSlots(siteId);
  const all = stays ?? [];
  const term = q.trim().toUpperCase();
  const shown = all.filter((v) => matchFilter(v, filter) && (!term || v.vehicle.vin.includes(term) || (v.vehicle.plateNumber ?? '').toUpperCase().includes(term) || `${v.vehicle.make} ${v.vehicle.model}`.toUpperCase().includes(term)));
  const selected = all.find((v) => v.id === params.get('stay')) ?? shown[0];
  const slotTotal = slots?.length ?? 0;
  const slotFree = slots?.filter((l) => l.effectiveStatus === 'AVAILABLE').length ?? 0;
  const count = (f: Filter) => all.filter((v) => matchFilter(v, f)).length;
  return (
    <div className="h-full overflow-auto px-4 pb-6 pt-[76px]">
      <div className="mx-auto max-w-7xl">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="mr-auto text-lg font-bold">{t('nav.vehicles')}</h2>
          <div className="flex gap-2 text-sm">
            <span className="rounded-lg bg-white px-3 py-1.5 shadow-sm">
              {t('vehicles.kpi.stored')} <b>{count('stored')}</b>
            </span>
            <span className="rounded-lg bg-white px-3 py-1.5 shadow-sm">
              {t('vehicles.kpi.slots')} <b>{slotTotal - slotFree}</b>/{slotTotal}
            </span>
            <span className="rounded-lg bg-white px-3 py-1.5 shadow-sm">
              {t('vehicles.kpi.hold')} <b className="text-bad">{count('hold')}</b>
            </span>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[400px_1fr]">
          <div className="card flex max-h-[calc(100vh-150px)] flex-col p-3">
            <div className="mb-2 flex gap-2">
              <Input placeholder={t('vehicles.search')} value={q} onChange={(e) => setQ(e.target.value)} />
              {can(siteId, 'vehicle.receive') ? (
                <Button size="sm" onClick={() => setCreate(true)}>
                  <Plus size={14} /> {t('flows.new')}
                </Button>
              ) : null}
            </div>
            <div className="mb-2 flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={cn('rounded-full px-2.5 py-1 text-xs font-medium', filter === f ? 'bg-brand text-white' : 'bg-slate-100 text-muted hover:text-ink')}>
                  {t(`vehicles.filter.${f}`)} · {count(f)}
                </button>
              ))}
            </div>
            <div className="-mx-1 flex-1 space-y-1.5 overflow-auto px-1">
              {shown.map((v) => (
                <button key={v.id} onClick={() => setParams({ stay: v.id })} className={cn('w-full rounded-xl border p-2.5 text-left text-sm', selected?.id === v.id ? 'border-brand bg-brand-soft/50' : 'border-line')}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[13px] font-semibold">{v.vehicle.vin}</span>
                    <Badge tone={STAY_TONE[v.status]}>{t(`vehicles.status.${v.status}`)}</Badge>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                    <span className="truncate">{[v.vehicle.make, v.vehicle.model].filter(Boolean).join(' ')}</span>
                    <span className="ml-auto shrink-0 font-medium text-ink">{v.position.location?.code ?? ''}</span>
                    {v.holdFlag ? <ShieldAlert size={12} className="shrink-0 text-bad" /> : null}
                    {v.conditionStatus !== 'OK' ? <span className={cn('h-2 w-2 shrink-0 rounded-full', v.conditionStatus === 'MAJOR_DAMAGE' ? 'bg-bad' : 'bg-warn')} /> : null}
                  </div>
                </button>
              ))}
              {shown.length === 0 ? <p className="p-4 text-center text-sm text-muted">—</p> : null}
            </div>
          </div>
          {selected ? <StayDetail key={selected.id} siteId={siteId} siteCode={siteCode} stay={selected} timeZone={timeZone} /> : <div className="card p-6 text-sm text-muted">{t('vehicles.empty')}</div>}
        </div>
      </div>
      {create ? <CreateStayDialog siteId={siteId} onClose={() => setCreate(false)} onCreated={(id) => setParams({ stay: id })} /> : null}
    </div>
  );
}
