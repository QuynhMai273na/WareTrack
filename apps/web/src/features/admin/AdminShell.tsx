import { Boxes, Building2, ChevronLeft, LogOut, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Navigate, NavLink, Outlet } from 'react-router';
import { cn } from '@/lib/utils';
import { useAuth } from '@/stores/auth';
import { Logo } from '../shell/TopBar';
import { useCanAdminister } from './admin-access';

/**
 * Khu quản trị (vận hành thật): thiết lập site + sơ đồ, user & phân quyền, danh mục.
 * Không gắn với một site cụ thể nên có header riêng thay cho TopBar của site.
 */
export function AdminShell() {
  const { t } = useTranslation();
  const me = useAuth((state) => state.me);
  const logout = useAuth((state) => state.logout);
  const can = useAuth((state) => state.can);
  const canAdminister = useCanAdminister();
  if (!canAdminister) return <Navigate to="/" replace />;

  const sections = [
    { to: '/admin/sites', label: t('admin.nav.sites'), icon: Building2, show: can(undefined, 'site.manage') || can(undefined, 'layout.manage') || can(undefined, 'equipment.manage') },
    { to: '/admin/users', label: t('admin.nav.users'), icon: Users, show: can(undefined, 'identity.user.read') },
    { to: '/admin/master-data', label: t('admin.nav.masterData'), icon: Boxes, show: can(undefined, 'master.sku.manage') || can(undefined, 'master.partner.manage') },
  ].filter((section) => section.show);
  const hasSites = (me?.sites.length ?? 0) > 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-[66px] shrink-0 items-center gap-4 border-b border-line bg-white px-5">
        <Logo />
        <span className="rounded-md bg-slate-800 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-white">{t('admin.title')}</span>
        <div className="flex-1" />
        {hasSites ? (
          <NavLink to="/" className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-medium text-brand hover:bg-brand-soft">
            <ChevronLeft size={16} /> {t('admin.backToOperations')}
          </NavLink>
        ) : null}
        <div className="text-right leading-tight">
          <div className="text-sm font-semibold">{me?.user.fullName}</div>
          <div className="text-xs text-muted">{me?.user.username}</div>
        </div>
        <button type="button" onClick={() => void logout()} className="rounded-lg p-2 text-muted hover:bg-slate-100 hover:text-bad" aria-label={t('app.logout')}>
          <LogOut size={18} />
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="w-60 shrink-0 border-r border-line bg-white/70 p-3">
          {sections.map((section) => (
            <NavLink
              key={section.to}
              to={section.to}
              className={({ isActive }) => cn('mb-1 flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium', isActive ? 'bg-brand-soft text-brand' : 'text-ink hover:bg-slate-100')}
            >
              <section.icon size={17} /> {section.label}
            </NavLink>
          ))}
        </nav>
        <main className="min-w-0 flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
