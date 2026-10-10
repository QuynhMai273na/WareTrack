import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TaskDto } from '@waretrack/shared-schemas';
import { Ban, CheckCircle2, MapPin, Play, ScanLine, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScanInput } from '@/components/ScanInput';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { api, describeError } from '@/lib/api';
import { useEquipment, useTasks } from '@/lib/queries';
import { formatTime } from '@/lib/utils';
import { useAuth } from '@/stores/auth';
import { useSiteContext } from '../shell/SiteShell';

const TONE: Record<string, BadgeTone> = { PENDING: 'neutral', ASSIGNED: 'info', IN_PROGRESS: 'ok', BLOCKED: 'bad', COMPLETED: 'ok', CANCELLED: 'neutral', FAILED: 'bad' };

type Action = 'assign' | 'source' | 'destination' | 'short' | 'block' | 'cancel';

function TaskDialog({ siteId, task, action, onClose }: { siteId: string; task: TaskDto; action: Action; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useAuth((s) => s.me);
  const can = useAuth((s) => s.can);
  const { data: equipment } = useEquipment(siteId);
  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ items: Array<{ id: string; fullName: string; siteRoles: Array<{ roleCode: string; siteId: string | null }> }> }>('/users').then((r) => r.items),
    enabled: action === 'assign' && can(undefined, 'identity.user.read'),
  });
  const [assignee, setAssignee] = useState(me?.user.id ?? '');
  const [eq, setEq] = useState('');
  const [loc, setLoc] = useState('');
  const [subject, setSubject] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const m = useMutation({
    mutationFn: () => {
      const base = `/sites/${siteId}/tasks/${task.id}`;
      const opts = { method: 'POST' as const, idempotencyKey: key };
      switch (action) {
        case 'assign':
          return api(`${base}/assign`, { ...opts, body: { assigneeId: assignee, ...(eq ? { equipmentId: eq } : {}), expectedVersion: task.version } });
        case 'source':
          return api(`${base}/confirm-source`, { ...opts, body: { locationScan: loc, subjectScan: subject } });
        case 'destination':
          return api(`${base}/confirm-destination`, { ...opts, body: { locationScan: loc } });
        case 'short':
          return api(`${base}/short-pick`, { ...opts, body: { pickedQty: qty, reason } });
        case 'block':
          return api(`${base}/block`, { ...opts, body: { reason } });
        case 'cancel':
          return api(`${base}/cancel`, { ...opts, body: { reason } });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['site', siteId] });
      onClose();
    },
  });
  const operators = users?.filter((u) => u.siteRoles.some((r) => (r.siteId === siteId || r.siteId === null) && ['FORKLIFT_OPERATOR', 'WAREHOUSE_OPERATOR', 'WAREHOUSE_SUPERVISOR', 'YARD_DISPATCHER'].includes(r.roleCode)));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`${t(`tasks.actions.${action}`)} · ${task.code}`} description={`${t(`tasks.type.${task.taskType}`)} · ${task.subject.code}${task.subject.label ? ` · ${task.subject.label}` : ''}`}>
      <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
        {action === 'assign' ? (
          <>
            <div>
              <Label>{t('tasks.assignee')}</Label>
              <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value={me?.user.id}>{me?.user.fullName} (me)</option>
                {operators?.filter((u) => u.id !== me?.user.id).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>{t('ops.forklifts')}</Label>
              <Select value={eq} onChange={(e) => setEq(e.target.value)}>
                <option value="">—</option>
                {equipment?.map((x) => (
                  <option key={x.id} value={x.id} disabled={x.status !== 'AVAILABLE'}>
                    {x.code} · {t(`status.${x.status}`)} {x.batteryPct !== null ? `· ${x.batteryPct}%` : ''}
                  </option>
                ))}
              </Select>
            </div>
          </>
        ) : null}
        {action === 'source' ? (
          <>
            <div>
              <Label>
                {t('tasks.scanLocation')} — {task.from?.code}
              </Label>
              <ScanInput value={loc} onChange={setLoc} placeholder={task.from?.qrValue} />
            </div>
            <div>
              <Label>
                {t('tasks.scanPallet')} — {task.subject.code}
              </Label>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={task.subject.code} />
            </div>
          </>
        ) : null}
        {action === 'destination' ? (
          <div>
            <Label>
              {t('tasks.scanDestination')} {task.to ? `— ${task.to.code}` : ''}
            </Label>
            <ScanInput value={loc} onChange={setLoc} placeholder={task.to?.qrValue ?? 'WT:LOC:…'} />
          </div>
        ) : null}
        {action === 'short' ? (
          <div>
            <Label>{t('tasks.pickedQty')}</Label>
            <Input value={qty} onChange={(e) => setQty(e.target.value)} required pattern="\d+(\.\d{1,3})?" />
          </div>
        ) : null}
        {['short', 'block', 'cancel'].includes(action) ? (
          <div>
            <Label>{t('yard.reason')}</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} />
          </div>
        ) : null}
        {m.isError ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(m.error)}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={m.isPending} variant={action === 'cancel' ? 'danger' : 'default'}>
            {t('common.confirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Hàng đợi tác vụ (UC-18) — tối ưu cho tablet/điện thoại: nút lớn, quét liên tục (NFR-11, DEC-54). */
export function TasksPage() {
  const { t } = useTranslation();
  const { siteId, timeZone } = useSiteContext();
  const can = useAuth((s) => s.can);
  const me = useAuth((s) => s.me);
  const [scope, setScope] = useState<'open' | 'mine' | 'done'>('open');
  const filter = scope === 'mine' ? 'assigneeId=me&status=ASSIGNED,IN_PROGRESS,BLOCKED' : scope === 'open' ? 'status=PENDING,ASSIGNED,IN_PROGRESS,BLOCKED' : 'status=COMPLETED,CANCELLED';
  const { data: tasks } = useTasks(siteId, filter);
  const [dialog, setDialog] = useState<{ task: TaskDto; action: Action } | null>(null);
  const qc = useQueryClient();
  const start = useMutation({
    mutationFn: (task: TaskDto) => api(`/sites/${siteId}/tasks/${task.id}/start`, { method: 'POST', body: { expectedVersion: task.version } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['site', siteId] }),
    onError: (err) => window.alert(describeError(err)),
  });

  return (
    <div className="h-full overflow-auto px-4 pb-6 pt-[76px]">
      <div className="card mx-auto max-w-6xl p-4">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-lg font-bold">{t('nav.tasks')}</h2>
          {(['open', 'mine', 'done'] as const).map((s) => (
            <Button key={s} size="sm" variant={scope === s ? 'default' : 'outline'} onClick={() => setScope(s)}>
              {t(`tasks.scope.${s}`)}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {tasks?.length === 0 ? <p className="text-sm text-muted">—</p> : null}
          {tasks?.map((task) => {
            const mine = task.assignee?.id === me?.user.id;
            return (
              <div key={task.id} className="rounded-xl border border-line p-4">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-brand">{t(`tasks.type.${task.taskType}`)}</div>
                    <div className="text-base font-bold">
                      {task.subject.code} <span className="text-sm font-medium text-muted">{task.subject.label}</span>
                    </div>
                    <div className="text-xs text-muted">
                      {task.code} · {task.source.code ?? task.source.type} · {formatTime(task.createdAt, timeZone)}
                    </div>
                  </div>
                  <Badge tone={TONE[task.status]}>{t(`tasks.status.${task.status}`)}</Badge>
                </div>
                <div className="mb-3 flex items-center gap-2 text-sm">
                  <MapPin size={14} className="text-muted" />
                  <span className="font-medium">{task.from?.code ?? '—'}</span>
                  <span className="text-muted">→</span>
                  <span className="font-medium">{task.to?.code ?? t('tasks.anyLocation')}</span>
                  {task.sourceConfirmed ? <CheckCircle2 size={14} className="text-ok" /> : null}
                </div>
                <div className="mb-3 text-xs text-muted">
                  {task.assignee ? task.assignee.fullName : t('tasks.unassigned')}
                  {task.equipment ? ` · ${task.equipment.code}` : ''}
                  {task.blockReason ? ` · ${task.blockReason}` : ''}
                </div>
                <div className="flex flex-wrap gap-2">
                  {['PENDING', 'ASSIGNED'].includes(task.status) && can(siteId, 'task.assign') ? (
                    <Button size="sm" variant="secondary" onClick={() => setDialog({ task, action: 'assign' })}>
                      <UserPlus size={14} /> {t('tasks.actions.assign')}
                    </Button>
                  ) : null}
                  {task.status === 'ASSIGNED' && mine ? (
                    <Button size="sm" onClick={() => start.mutate(task)}>
                      <Play size={14} /> {t('tasks.actions.start')}
                    </Button>
                  ) : null}
                  {task.status === 'IN_PROGRESS' && mine ? (
                    <>
                      {task.from && !task.sourceConfirmed ? (
                        <Button size="sm" variant="secondary" onClick={() => setDialog({ task, action: 'source' })}>
                          <ScanLine size={14} /> {t('tasks.actions.source')}
                        </Button>
                      ) : null}
                      <Button size="sm" onClick={() => setDialog({ task, action: 'destination' })}>
                        <ScanLine size={14} /> {t('tasks.actions.destination')}
                      </Button>
                      {task.taskType === 'PICK' ? (
                        <Button size="sm" variant="outline" onClick={() => setDialog({ task, action: 'short' })}>
                          {t('tasks.actions.short')}
                        </Button>
                      ) : null}
                      <Button size="sm" variant="outline" onClick={() => setDialog({ task, action: 'block' })}>
                        <Ban size={14} />
                      </Button>
                    </>
                  ) : null}
                  {!['COMPLETED', 'CANCELLED', 'FAILED'].includes(task.status) && can(siteId, 'task.cancel') ? (
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ task, action: 'cancel' })}>
                      {t('tasks.actions.cancel')}
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {dialog ? <TaskDialog siteId={siteId} task={dialog.task} action={dialog.action} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
