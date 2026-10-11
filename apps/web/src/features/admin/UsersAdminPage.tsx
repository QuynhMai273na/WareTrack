import type { AdminUserDto } from '@waretrack/shared-schemas';
import { KeyRound, Plus, ShieldPlus, UserCheck, UserX, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { useAdminSites, useAdminUsers, useRoles, useUserMutations } from '@/lib/admin-queries';
import { describeError } from '@/lib/api';
import { useAuth } from '@/stores/auth';

const STATUS_TONE = { ACTIVE: 'ok', DISABLED: 'neutral', LOCKED: 'bad' } as const;

/** Mật khẩu tạm ngẫu nhiên đủ mạnh (≥ 12 ký tự) để admin chuyển cho người dùng mới. */
function generateTemporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const randomBytes = crypto.getRandomValues(new Uint8Array(12));
  return `${Array.from(randomBytes, (byte) => alphabet[byte % alphabet.length]).join('')}#26`;
}

function CreateUserDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { create } = useUserMutations();
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [tempPassword, setTempPassword] = useState(generateTemporaryPassword);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={t('admin.users.createTitle')} description={t('admin.users.createHint')}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate({ username, fullName, email, tempPassword }, { onSuccess: onClose });
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="user-username">{t('login.username')}</Label>
            <Input id="user-username" value={username} onChange={(event) => setUsername(event.target.value.toLowerCase())} placeholder="jdoe" required pattern="[a-z0-9._-]{3,40}" />
          </div>
          <div>
            <Label htmlFor="user-fullname">{t('admin.users.fullName')}</Label>
            <Input id="user-fullname" value={fullName} onChange={(event) => setFullName(event.target.value)} required minLength={2} />
          </div>
        </div>
        <div>
          <Label htmlFor="user-email">{t('admin.users.email')}</Label>
          <Input id="user-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </div>
        <div>
          <Label htmlFor="user-password">{t('admin.users.tempPassword')}</Label>
          <div className="flex gap-2">
            <Input id="user-password" value={tempPassword} onChange={(event) => setTempPassword(event.target.value)} required minLength={12} className="font-mono" />
            <Button type="button" variant="outline" onClick={() => setTempPassword(generateTemporaryPassword())}>
              {t('admin.users.generate')}
            </Button>
          </div>
        </div>
        {create.isError ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(create.error)}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {t('admin.users.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function GrantRoleDialog({ user, onClose }: { user: AdminUserDto; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { grant } = useUserMutations();
  const { data: roles } = useRoles();
  const { data: sites } = useAdminSites();
  const [roleCode, setRoleCode] = useState('VIEWER');
  const [siteId, setSiteId] = useState<string>('');
  const enterpriseRole = roleCode === 'ADMIN';
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={t('admin.users.grantTitle', { name: user.fullName })}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          grant.mutate({ userId: user.id, roleCode, siteId: enterpriseRole ? null : siteId || null }, { onSuccess: onClose });
        }}
      >
        <div>
          <Label htmlFor="grant-role">{t('admin.users.role')}</Label>
          <Select id="grant-role" value={roleCode} onChange={(event) => setRoleCode(event.target.value)}>
            {roles?.map((role) => (
              <option key={role.code} value={role.code}>
                {i18n.language === 'vi' ? role.label.vi : role.label.en}
              </option>
            ))}
          </Select>
        </div>
        {!enterpriseRole ? (
          <div>
            <Label htmlFor="grant-site">{t('admin.users.site')}</Label>
            <Select id="grant-site" value={siteId} onChange={(event) => setSiteId(event.target.value)} required>
              <option value="">{t('admin.users.chooseSite')}</option>
              {sites?.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.code} · {site.name}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">{t('admin.users.adminHint')}</p>
        )}
        {grant.isError ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(grant.error)}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={grant.isPending}>
            {t('admin.users.grant')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: AdminUserDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { resetPassword } = useUserMutations();
  const [tempPassword, setTempPassword] = useState(generateTemporaryPassword);
  const [done, setDone] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={t('admin.users.resetTitle', { name: user.fullName })} description={t('admin.users.resetHint')}>
      {done ? (
        <div className="space-y-3">
          <p className="rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">{t('admin.users.resetDone')}</p>
          <p className="rounded-lg bg-slate-50 px-3 py-2 font-mono text-sm">{tempPassword}</p>
          <div className="flex justify-end">
            <Button onClick={onClose}>{t('common.close')}</Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            resetPassword.mutate({ userId: user.id, tempPassword }, { onSuccess: () => setDone(true) });
          }}
        >
          <Input value={tempPassword} onChange={(event) => setTempPassword(event.target.value)} minLength={12} required className="font-mono" />
          {resetPassword.isError ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(resetPassword.error)}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={resetPassword.isPending}>
              {t('admin.users.reset')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** User & phân quyền (UC-22): tạo user, gán/thu hồi vai trò theo site, khóa/mở khóa, đặt lại mật khẩu. */
export function UsersAdminPage() {
  const { t, i18n } = useTranslation();
  const { data: users, isLoading } = useAdminUsers();
  const { data: roles } = useRoles();
  const { update, revoke } = useUserMutations();
  const can = useAuth((state) => state.can);
  const currentUserId = useAuth((state) => state.me?.user.id);
  const canManage = can(undefined, 'identity.user.manage');
  const [searchText, setSearchText] = useState('');
  const [creating, setCreating] = useState(false);
  const [grantingUser, setGrantingUser] = useState<AdminUserDto | null>(null);
  const [resettingUser, setResettingUser] = useState<AdminUserDto | null>(null);
  const roleLabel = (roleCode: string) => {
    const role = roles?.find((candidate) => candidate.code === roleCode);
    return role ? (i18n.language === 'vi' ? role.label.vi : role.label.en) : roleCode;
  };
  const visibleUsers = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return (users ?? []).filter((user) => !query || user.username.includes(query) || user.fullName.toLowerCase().includes(query));
  }, [users, searchText]);
  const mutationError = update.error ?? revoke.error;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t('admin.users.title')}</h1>
          <p className="text-sm text-muted">{t('admin.users.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder={t('admin.users.search')} className="w-64" />
          {canManage ? (
            <Button onClick={() => setCreating(true)} data-testid="create-user">
              <Plus size={16} /> {t('admin.users.create')}
            </Button>
          ) : null}
        </div>
      </div>
      {mutationError ? <p className="mb-3 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(mutationError)}</p> : null}
      {isLoading ? <p className="text-muted">{t('common.loading')}</p> : null}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2">{t('admin.users.user')}</th>
              <th className="px-4 py-2">{t('common.status')}</th>
              <th className="px-4 py-2">{t('admin.users.roles')}</th>
              <th className="px-4 py-2 text-right">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {visibleUsers.map((user) => (
              <tr key={user.id} className="border-t border-line align-top" data-testid={`user-row-${user.username}`}>
                <td className="px-4 py-3">
                  <div className="font-semibold">{user.fullName}</div>
                  <div className="text-xs text-muted">
                    {user.username} · {user.email}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <Badge tone={STATUS_TONE[user.status]}>{t(`admin.userStatus.${user.status}`)}</Badge>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {user.siteRoles.length === 0 ? <span className="text-xs text-muted">{t('admin.users.noRoles')}</span> : null}
                    {user.siteRoles.map((assignment) => (
                      <span key={assignment.id} className="inline-flex items-center gap-1 rounded-md bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand">
                        {roleLabel(assignment.roleCode)} · {assignment.siteCode ?? t('admin.users.allSites')}
                        {can(undefined, 'identity.role.manage') ? (
                          <button
                            type="button"
                            aria-label={t('admin.users.revoke')}
                            className="rounded p-0.5 hover:bg-white"
                            onClick={() => revoke.mutate({ userId: user.id, assignmentId: assignment.id, reason: 'Revoked by administrator' })}
                          >
                            <X size={12} />
                          </button>
                        ) : null}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1">
                    {can(undefined, 'identity.role.manage') ? (
                      <Button size="sm" variant="secondary" onClick={() => setGrantingUser(user)} data-testid={`grant-role-${user.username}`}>
                        <ShieldPlus size={14} /> {t('admin.users.grant')}
                      </Button>
                    ) : null}
                    {canManage ? (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setResettingUser(user)} aria-label={t('admin.users.reset')}>
                          <KeyRound size={14} />
                        </Button>
                        {user.id !== currentUserId ? (
                          user.status === 'ACTIVE' ? (
                            <Button size="sm" variant="ghost" className="text-bad" onClick={() => update.mutate({ userId: user.id, body: { status: 'DISABLED' } })} aria-label={t('admin.users.disable')}>
                              <UserX size={14} />
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" className="text-ok" onClick={() => update.mutate({ userId: user.id, body: { status: 'ACTIVE' } })} aria-label={t('admin.users.enable')}>
                              <UserCheck size={14} />
                            </Button>
                          )
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating ? <CreateUserDialog onClose={() => setCreating(false)} /> : null}
      {grantingUser ? <GrantRoleDialog user={grantingUser} onClose={() => setGrantingUser(null)} /> : null}
      {resettingUser ? <ResetPasswordDialog user={resettingUser} onClose={() => setResettingUser(null)} /> : null}
    </div>
  );
}
