import { useQuery } from '@tanstack/react-query';
import type { SearchResult } from '@waretrack/shared-schemas';
import { ChevronDown, ChevronRight, Languages, LogOut, Search } from 'lucide-react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { setLanguage } from '@/i18n';
import { api } from '@/lib/api';
import { useSites } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { useLive } from '@/realtime/useSiteRealtime';
import { useAuth } from '@/stores/auth';
import { useScene } from '@/stores/scene';
import { useCanAdminister } from '../admin/admin-access';
import { NotificationBell } from './NotificationBell';

export function Logo() {
  return (
    <div className="flex items-center gap-2">
      <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden>
        <path fill="#2f6fe4" d="M16 2 29 9v14l-13 7-13-7V9z" />
        <path fill="#5b8ff0" d="M16 2 29 9l-13 7L3 9z" />
        <path fill="#1f4fb8" d="M16 16v14l13-7V9z" />
      </svg>
      <span className="text-[22px] font-bold tracking-tight">WareTrack</span>
    </div>
  );
}

function LiveClock({ timeZone }: { timeZone?: string }) {
  const { t } = useTranslation();
  const state = useLive((s) => s.state);
  const since = useLive((s) => s.since);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(id);
  }, []);
  const fmt = (d: Date) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(d);
  const live = state === 'live';
  const stale = state === 'stale';
  return (
    <div className={cn('flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 text-sm font-medium', live ? 'bg-ok-soft text-ok' : stale ? 'bg-bad-soft text-bad' : 'bg-warn-soft text-warn')} title={state}>
      <span className={cn('h-2 w-2 rounded-full', live ? 'bg-ok' : stale ? 'bg-bad' : 'animate-pulse bg-warn')} />
      {live ? `${t('app.live')} ${fmt(now)}` : stale ? `${t('app.stale')} ${since ? fmt(new Date(since)) : ''}` : t('app.reconnecting')}
    </div>
  );
}

/** Tìm kiếm toàn cục (FR-11.05) với phím tắt "/". */
function GlobalSearch() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const select = useScene((s) => s.select);
  const { data } = useQuery({ queryKey: ['search', q], queryFn: () => api<SearchResult[]>(`/search?q=${encodeURIComponent(q)}`), enabled: q.trim().length >= 2 });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const pick = (r: SearchResult) => {
    setOpen(false);
    setQ('');
    if (!r.siteCode || !r.siteId) return;
    navigate(`/sites/${r.siteCode}`);
    const type = r.type === 'truck' ? 'truck' : r.type === 'forklift' ? 'forklift' : r.type === 'vehicle' ? 'vehicle' : r.type === 'location' ? 'dock' : null;
    if (type) setTimeout(() => select({ siteId: r.siteId!, type, id: r.id }), 400);
  };
  return (
    <div className="relative w-full min-w-[120px] max-w-md">
      <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={16} />
      <input
        ref={input}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={t('app.search')}
        className="h-10 w-full rounded-xl border border-line bg-white pl-9 pr-10 text-sm outline-none focus:border-brand"
      />
      <kbd className="absolute right-3 top-1/2 -translate-y-1/2 rounded border border-line px-1.5 text-xs text-muted">/</kbd>
      {open && data && data.length > 0 ? (
        <div className="card absolute left-0 right-0 top-12 z-30 max-h-80 overflow-auto p-1">
          {data.map((r) => (
            <button key={`${r.type}${r.id}`} className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50" onMouseDown={() => pick(r)}>
              <span>
                <span className="font-medium">{r.code}</span> <span className="text-muted">· {r.label}</span>
              </span>
              <span className="text-xs text-muted">
                {r.type} {r.siteCode ? `· ${r.siteCode}` : ''}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SiteSwitcher({ siteCode }: { siteCode: string }) {
  const { t } = useTranslation();
  const { data: sites } = useSites();
  const navigate = useNavigate();
  const current = sites?.find((s) => s.code === siteCode);
  const fillPct = (s: NonNullable<typeof sites>[number]) => {
    const f = s.fill;
    if (!f) return null;
    if (s.siteType === 'VEHICLE_YARD') return f.slotsTotal ? Math.round((f.slotsUsed / f.slotsTotal) * 100) : null;
    return f.palletPositionsTotal ? Math.round((f.palletPositionsUsed / f.palletPositionsTotal) * 100) : null;
  };
  return (
    <Dropdown.Root>
      <div className="flex h-11 items-center rounded-xl border border-line bg-white shadow-sm">
        <button className="flex h-full items-center gap-2.5 pl-1.5 pr-2 text-left" onClick={() => navigate(`/sites/${siteCode}`)}>
          <span className="rounded-lg bg-brand px-2 py-1.5 text-xs font-bold text-white">{current?.code ?? siteCode}</span>
          <span className="flex flex-col leading-tight">
            <span className="max-w-[150px] truncate whitespace-nowrap text-[14px] font-semibold">{current?.name ?? '…'}</span>
            {current?.fill ? (
              <span className="whitespace-nowrap text-[11px] text-muted">
                {t('v.network.full', { n: fillPct(current) ?? 0 })} · {t('v.network.docked', { a: current.fill.docksOccupied, b: current.fill.docksTotal })}
              </span>
            ) : null}
          </span>
          <ChevronRight size={15} className="ml-1 text-muted" />
        </button>
        <Dropdown.Trigger data-testid="site-switcher" className="flex h-full items-center border-l border-line px-2.5 text-muted outline-none hover:bg-slate-50">
          <ChevronDown size={15} />
        </Dropdown.Trigger>
      </div>
      <Dropdown.Portal>
        <Dropdown.Content align="end" sideOffset={8} className="card z-50 w-[340px] p-1.5">
          <Dropdown.Item
            onSelect={() => {
              navigate(`/sites/${siteCode}`);
              setTimeout(() => useScene.getState().camera('network'), 60);
            }}
            className="mb-1 flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 outline-none data-[highlighted]:bg-slate-50"
          >
            <span className="flex h-10 w-12 shrink-0 items-center justify-center rounded-lg bg-slate-700 text-[11px] font-bold text-white">ALL</span>
            <span className="leading-tight">
              <span className="block text-sm font-semibold">{t('v.network.title')}</span>
              <span className="block text-xs text-muted">{t('v.network.sub', { n: sites?.length ?? 0 })}</span>
            </span>
          </Dropdown.Item>
          {sites?.map((s) => (
            <Dropdown.Item key={s.id} onSelect={() => navigate(`/sites/${s.code}`)} className={cn('flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 outline-none data-[highlighted]:bg-slate-50', s.code === siteCode && 'bg-brand-soft/50')}>
              <span className="flex h-10 w-12 shrink-0 items-center justify-center whitespace-nowrap rounded-lg bg-brand text-[11px] font-bold text-white">{s.code}</span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-semibold">{s.name}</span>
                  <span className="tabular shrink-0 text-xs font-semibold">{fillPct(s) ?? 0}%</span>
                </span>
                <span className="mt-1.5 flex items-center gap-3">
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <span className="block h-full rounded-full bg-brand" style={{ width: `${fillPct(s) ?? 0}%` }} />
                  </span>
                  <span className="tabular w-[120px] shrink-0 whitespace-nowrap text-right text-[11px] text-muted">
                    {t('v.network.docked', { a: s.fill?.docksOccupied ?? 0, b: s.fill?.docksTotal ?? 0 })} · {t('v.network.inbound', { n: s.fill?.inbound ?? 0 })}
                  </span>
                </span>
              </span>
            </Dropdown.Item>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** Ảnh đại diện minh họa (không dùng ảnh người thật). */
function Avatar() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden className="rounded-full">
      <circle cx="20" cy="20" r="20" fill="#dfe7f7" />
      <path fill="#3b4a6b" d="M8 40c0-8 5-12 12-12s12 4 12 12z" />
      <circle cx="20" cy="17" r="7.5" fill="#b07a55" />
      <path fill="#2a2420" d="M12.5 15c0-5 3.5-7.5 7.5-7.5s7.5 2.5 7.5 7.5c-1.5-2-4-3-7.5-3s-6 1-7.5 3z" />
      <path fill="#2a2420" d="M13.5 18c.5 4 3 7 6.5 7s6-3 6.5-7c-1 2-3 3.5-6.5 3.5s-5.5-1.5-6.5-3.5z" />
    </svg>
  );
}

export function TopBar({ siteCode, timeZone, siteId }: { siteCode: string; timeZone?: string; siteId?: string }) {
  const { t, i18n } = useTranslation();
  const me = useAuth((s) => s.me);
  const logout = useAuth((s) => s.logout);
  const can = useAuth((s) => s.can);
  const roles = me?.sites.find((s) => s.code === siteCode)?.roles ?? me?.enterpriseRoles ?? [];
  const { data: sites } = useSites();
  const isVehicleYard = sites?.find((s) => s.code === siteCode)?.siteType === 'VEHICLE_YARD';
  const canAdminister = useCanAdminister();
  const nav = [
    { to: `/sites/${siteCode}`, label: t('nav.overview'), end: true, show: true },
    { to: `/sites/${siteCode}/yard`, label: t('nav.yard'), show: can(siteId, 'yard.visit.read') },
    { to: `/sites/${siteCode}/inventory`, label: t('nav.inventory'), show: can(siteId, 'inventory.read') },
    { to: `/sites/${siteCode}/inbound`, label: t('nav.inbound'), show: can(siteId, 'inventory.read') && (can(siteId, 'inbound.receive') || can(siteId, 'inbound.order.manage')) },
    { to: `/sites/${siteCode}/outbound`, label: t('nav.outbound'), show: can(siteId, 'inventory.read') && (can(siteId, 'outbound.load') || can(siteId, 'outbound.order.manage')) },
    { to: `/sites/${siteCode}/vehicles`, label: t('nav.vehicles'), show: isVehicleYard && can(siteId, 'vehicle.read') },
    { to: `/sites/${siteCode}/tasks`, label: t('nav.tasks'), show: can(siteId, 'task.read') },
    { to: `/sites/${siteCode}/exceptions`, label: t('nav.exceptions'), show: can(siteId, 'exception.read') },
    { to: `/sites/${siteCode}/labels`, label: t('nav.labels'), show: can(siteId, 'site.read') && (can(siteId, 'location.manage') || can(siteId, 'inventory.move') || can(siteId, 'inbound.receive')) },
    { to: `/sites/${siteCode}/inventory/import`, label: t('nav.openingStock'), show: can(siteId, 'inventory.opening.import') },
    { to: '/admin', label: t('nav.administration'), show: canAdminister },
  ];
  const role = roles[0];
  // Tự tính trạng thái active: Dropdown.Item asChild (Radix Slot) chỉ nối className dạng chuỗi, không nhận className dạng hàm của NavLink
  const { pathname } = useLocation();
  const isActive = (n: { to: string; end?: boolean }) => (n.end ? pathname === n.to : pathname === n.to || pathname.startsWith(`${n.to}/`));
  return (
    <header className="pointer-events-auto flex h-[66px] items-center gap-4 border-b border-white/60 bg-white/85 px-5 backdrop-blur-md">
      <Dropdown.Root>
        <Dropdown.Trigger className="flex items-center gap-2 rounded-lg outline-none" aria-label={t('v.menu')}>
          <Logo />
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content align="start" sideOffset={8} className="card z-50 w-56 p-1">
            {nav
              .filter((n) => n.show)
              .map((n) => (
                <Dropdown.Item key={n.to} asChild>
                  <NavLink to={n.to} end={n.end} className={cn('flex cursor-pointer items-center rounded-lg px-3 py-2 text-sm outline-none data-[highlighted]:bg-slate-50', isActive(n) ? 'font-semibold text-brand' : 'text-ink')}>
                    {n.label}
                  </NavLink>
                </Dropdown.Item>
              ))}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      <div className="ml-14 w-[450px] max-w-[34vw]">
        <GlobalSearch />
      </div>
      <div className="flex-1" />
      <SiteSwitcher siteCode={siteCode} />
      <LiveClock timeZone={timeZone} />
      <NotificationBell timeZone={timeZone} />
      <div className="h-8 w-px bg-line" />
      <Dropdown.Root>
        <Dropdown.Trigger data-testid="user-menu" className="flex items-center gap-2.5 rounded-xl px-1 py-1 outline-none hover:bg-white/60">
          <Avatar />
          <span className="hidden flex-col text-left leading-tight lg:flex">
            <span className="whitespace-nowrap text-[14px] font-semibold">{me?.user.fullName}</span>
            <span className="whitespace-nowrap text-xs text-muted">{role ? t(`v.role.${role}`, { defaultValue: role }) : ''}</span>
          </span>
          <ChevronDown size={15} className="ml-1 text-muted" />
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content align="end" sideOffset={6} className="card z-50 w-52 p-1">
            {nav
              .filter((n) => n.show)
              .map((n) => (
                <Dropdown.Item key={n.to} asChild>
                  <NavLink to={n.to} end={n.end} className={cn('flex cursor-pointer items-center rounded-lg px-2 py-2 text-sm outline-none data-[highlighted]:bg-slate-50', isActive(n) && 'font-semibold text-brand')}>
                    {n.label}
                  </NavLink>
                </Dropdown.Item>
              ))}
            <Dropdown.Separator className="my-1 h-px bg-line" />
            <Dropdown.Item onSelect={() => setLanguage(i18n.language === 'vi' ? 'en' : 'vi')} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm outline-none data-[highlighted]:bg-slate-50">
              <Languages size={14} /> {i18n.language === 'vi' ? 'English' : 'Tiếng Việt'}
            </Dropdown.Item>
            <Dropdown.Item onSelect={() => void logout()} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-bad outline-none data-[highlighted]:bg-slate-50">
              <LogOut size={14} /> {t('app.logout')}
            </Dropdown.Item>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
    </header>
  );
}
