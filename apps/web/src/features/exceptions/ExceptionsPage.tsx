import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExceptionDto } from '@waretrack/shared-schemas';
import { AlertTriangle, CheckCircle2, Hand, Plus, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { api, describeError } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';
import { useAuth } from '@/stores/auth';
import { useSiteContext } from '../shell/SiteShell';

const SEVERITY_TONE: Record<string, BadgeTone> = { LOW: 'neutral', MEDIUM: 'info', HIGH: 'warn', CRITICAL: 'bad' };
const STATUS_TONE: Record<string, BadgeTone> = { OPEN: 'bad', IN_REVIEW: 'warn', RESOLVED: 'ok', REJECTED: 'neutral' };
const CASE_TYPES = ['SAFETY', 'DAMAGE', 'COUNT_VARIANCE', 'LOCATION_MISMATCH', 'EQUIPMENT_FAULT', 'VEHICLE_DAMAGE', 'OTHER'];
const SCOPES = { open: 'OPEN,IN_REVIEW', closed: 'RESOLVED,REJECTED', all: '' } as const;
type Scope = keyof typeof SCOPES;

const useExceptions = (siteId: string, status: string) =>
  useQuery({ queryKey: ['site', siteId, 'exceptions', status || 'all'], queryFn: () => api<ExceptionDto[]>(`/sites/${siteId}/exceptions${status ? `?status=${status}` : ''}`) });

function ReportDialog({ siteId, onClose, onCreated }: { siteId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [caseType, setCaseType] = useState('SAFETY');
  const [severity, setSeverity] = useState('MEDIUM');
  const [description, setDescription] = useState('');
  const m = useMutation({
    mutationFn: () => api<ExceptionDto>(`/sites/${siteId}/exceptions`, { method: 'POST', body: { caseType, severity, description } }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['site', siteId, 'exceptions'] });
      onCreated(c.id);
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('exceptions.report')} className="w-[min(92vw,520px)]">
      <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('exceptions.type')}</Label>
            <Select value={caseType} onChange={(e) => setCaseType(e.target.value)}>
              {CASE_TYPES.map((c) => (
                <option key={c} value={c}>
                  {t(`exceptions.types.${c}`, { defaultValue: c })}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{t('exceptions.severity')}</Label>
            <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((s) => (
                <option key={s} value={s}>
                  {t(`exceptions.severities.${s}`)}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div>
          <Label>{t('exceptions.description')}</Label>
          <textarea className="min-h-24 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand" value={description} onChange={(e) => setDescription(e.target.value)} required minLength={5} />
        </div>
        {severity === 'CRITICAL' ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-xs text-bad">{t('exceptions.criticalHint')}</p> : null}
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

function CaseDetail({ siteId, c, timeZone }: { siteId: string; c: ExceptionDto; timeZone: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const can = useAuth((s) => s.can);
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const run = useMutation({
    mutationFn: ({ action, body }: { action: string; body: unknown }) => api<ExceptionDto>(`/sites/${siteId}/exceptions/${c.id}/${action}`, { method: 'POST', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['site', siteId, 'exceptions'] }),
  });
  const open = c.status === 'OPEN' || c.status === 'IN_REVIEW';
  const canResolve = can(siteId, 'exception.resolve');
  return (
    <div className="card space-y-4 p-5">
      <div className="flex items-start gap-3">
        <div className={cn('flex h-12 w-12 items-center justify-center rounded-xl', c.severity === 'CRITICAL' ? 'bg-bad text-white' : 'bg-warn-soft text-warn')}>
          <AlertTriangle size={22} />
        </div>
        <div className="flex-1">
          <div className="text-xl font-bold">{c.code}</div>
          <div className="text-sm text-muted">{t(`exceptions.types.${c.caseType}`, { defaultValue: c.caseType })}</div>
          <div className="mt-1.5 flex gap-1.5">
            <Badge tone={STATUS_TONE[c.status]}>{t(`exceptions.statuses.${c.status}`)}</Badge>
            <Badge tone={SEVERITY_TONE[c.severity]}>{t(`exceptions.severities.${c.severity}`)}</Badge>
          </div>
        </div>
      </div>
      <p className="rounded-xl bg-slate-50 p-3 text-sm">{c.description}</p>
      <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
        <div>
          <div className="text-xs text-muted">{t('exceptions.reportedBy')}</div>
          <div className="font-medium">{c.createdBy ?? t('exceptions.system')}</div>
        </div>
        <div>
          <div className="text-xs text-muted">{t('common.time')}</div>
          <div className="font-medium">{formatDateTime(c.createdAt, timeZone)}</div>
        </div>
        <div>
          <div className="text-xs text-muted">{t('exceptions.assignee')}</div>
          <div className="font-medium">{c.assignee ?? '—'}</div>
        </div>
        <div>
          <div className="text-xs text-muted">{t('exceptions.subject')}</div>
          <div className="font-medium">{c.subjectType ?? '—'}</div>
        </div>
      </div>
      {c.resolutionCode ? (
        <div className="rounded-xl border border-ok/30 bg-ok-soft/40 p-3 text-sm">
          <span className="font-semibold">{c.resolutionCode}</span> {c.resolutionNote ? `· ${c.resolutionNote}` : ''}
        </div>
      ) : null}
      {open && canResolve ? (
        <div className="space-y-2 rounded-xl border border-line p-3">
          <p className="text-xs text-muted">{t('exceptions.ruleHint')}</p>
          {c.status === 'OPEN' ? (
            <Button size="sm" variant="outline" onClick={() => run.mutate({ action: 'assign', body: { expectedVersion: c.version } })}>
              <Hand size={14} /> {t('exceptions.take')}
            </Button>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Input className="w-44" placeholder={t('exceptions.resolutionCode')} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
            <Input className="min-w-48 flex-1" placeholder={t('exceptions.note')} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Button size="sm" disabled={code.length < 2 || run.isPending} onClick={() => run.mutate({ action: 'resolve', body: { resolutionCode: code, ...(note ? { note } : {}), expectedVersion: c.version } })}>
              <CheckCircle2 size={14} /> {t('exceptions.resolve')}
            </Button>
            <Button size="sm" variant="outline" disabled={run.isPending} onClick={() => run.mutate({ action: 'reject', body: { ...(note ? { note } : {}), expectedVersion: c.version } })}>
              <XCircle size={14} /> {t('exceptions.reject')}
            </Button>
          </div>
        </div>
      ) : null}
      {run.isError ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(run.error)}</p> : null}
    </div>
  );
}

/** Ngoại lệ & sự cố (UC-23): ghi nhận và xử lý có kiểm soát — không tự sửa dữ liệu nghiệp vụ (AC-04). */
export function ExceptionsPage() {
  const { t } = useTranslation();
  const { siteId, timeZone } = useSiteContext();
  const can = useAuth((s) => s.can);
  const [params, setParams] = useSearchParams();
  const [scope, setScope] = useState<Scope>('open');
  const [report, setReport] = useState(false);
  const { data } = useExceptions(siteId, SCOPES[scope]);
  const { data: all } = useExceptions(siteId, '');
  const selectedId = params.get('case');
  const selected = all?.find((c) => c.id === selectedId) ?? data?.[0];
  return (
    <div className="h-full overflow-auto px-4 pb-6 pt-[76px]">
      <div className="mx-auto max-w-7xl">
        <div className="mb-3 flex items-center gap-3">
          <h2 className="mr-auto text-lg font-bold">{t('nav.exceptions')}</h2>
          {can(siteId, 'exception.create') ? (
            <Button size="sm" onClick={() => setReport(true)}>
              <Plus size={14} /> {t('exceptions.report')}
            </Button>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[400px_1fr]">
          <div className="card p-3">
            <div className="mb-2 flex gap-1">
              {(Object.keys(SCOPES) as Scope[]).map((s) => (
                <button key={s} onClick={() => setScope(s)} className={cn('rounded-full px-3 py-1 text-xs font-medium', scope === s ? 'bg-brand text-white' : 'bg-slate-100 text-muted hover:text-ink')}>
                  {t(`exceptions.scope.${s}`)}
                </button>
              ))}
            </div>
            <div className="space-y-1.5">
              {data?.length === 0 ? <p className="p-6 text-center text-sm text-muted">{t('exceptions.empty')}</p> : null}
              {data?.map((c) => (
                <button key={c.id} onClick={() => setParams({ case: c.id })} className={cn('w-full rounded-xl border p-3 text-left text-sm', selected?.id === c.id ? 'border-brand bg-brand-soft/50' : 'border-line')}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{c.code}</span>
                    <span className="flex gap-1">
                      <Badge tone={SEVERITY_TONE[c.severity]}>{t(`exceptions.severities.${c.severity}`)}</Badge>
                      <Badge tone={STATUS_TONE[c.status]}>{t(`exceptions.statuses.${c.status}`)}</Badge>
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted">
                    {t(`exceptions.types.${c.caseType}`, { defaultValue: c.caseType })} · {c.description}
                  </div>
                  <div className="text-[11px] text-muted">{formatDateTime(c.createdAt, timeZone)}</div>
                </button>
              ))}
            </div>
          </div>
          {selected ? <CaseDetail key={selected.id + selected.version} siteId={siteId} c={selected} timeZone={timeZone} /> : <div className="card p-6 text-sm text-muted">{t('exceptions.empty')}</div>}
        </div>
      </div>
      {report ? <ReportDialog siteId={siteId} onClose={() => setReport(false)} onCreated={(id) => setParams({ case: id })} /> : null}
    </div>
  );
}
