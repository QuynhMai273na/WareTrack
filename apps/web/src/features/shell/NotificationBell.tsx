import * as Menu from '@radix-ui/react-dropdown-menu';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationCreated, NotificationList } from '@waretrack/shared-schemas';
import { AlertTriangle, Bell, Car, CheckCheck, Forklift, Info, Truck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { api } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';
import { getSocket } from '@/realtime/useSiteRealtime';

const ICON = { EXCEPTION: AlertTriangle, EQUIPMENT: Forklift, VEHICLE: Car, YARD: Truck } as const;
const TONE: Record<string, string> = { CRITICAL: 'bg-bad text-white', HIGH: 'bg-bad-soft text-bad', WARNING: 'bg-warn-soft text-warn', INFO: 'bg-brand-soft text-brand' };

/** Chuông thông báo (dropdown Radix) in-app (FR-18.01): danh sách, đếm chưa đọc, nhận realtime qua room user:{id}. */
export function NotificationBell({ timeZone }: { timeZone?: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<NotificationCreated | null>(null);
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => api<NotificationList>('/notifications'), refetchInterval: 60_000 });
  const read = useMutation({ mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: 'POST', body: {} }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }) });
  const readAll = useMutation({ mutationFn: () => api('/notifications/read-all', { method: 'POST', body: {} }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }) });

  useEffect(() => {
    const socket = getSocket();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onCreated = (notification: NotificationCreated) => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      setToast(notification);
      clearTimeout(timer);
      timer = setTimeout(() => setToast(null), 6000);
    };
    socket.on('notification.created', onCreated);
    return () => {
      socket.off('notification.created', onCreated);
      clearTimeout(timer);
    };
  }, [queryClient]);

  const go = (id: string, link: string | null) => {
    read.mutate(id);
    setOpen(false);
    setToast(null);
    if (link) navigate(link);
  };
  const unread = data?.unreadCount ?? 0;

  return (
    <>
      <Menu.Root open={open} onOpenChange={setOpen}>
        <Menu.Trigger className="relative flex h-9 w-9 items-center justify-center rounded-full bg-white shadow-sm outline-none" aria-label={t('notifications.title')}>
          <Bell size={16} />
          {unread > 0 ? <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-bad px-1 text-[10px] font-bold text-white">{unread > 99 ? '99+' : unread}</span> : null}
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content align="end" sideOffset={8} className="card z-50 w-[380px] p-0 outline-none">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <span className="font-semibold">{t('notifications.title')}</span>
              {unread > 0 ? (
                <button className="flex items-center gap-1 text-xs font-medium text-brand hover:underline" onClick={(event) => (event.preventDefault(), readAll.mutate())}>
                  <CheckCheck size={14} /> {t('notifications.readAll')}
                </button>
              ) : null}
            </div>
            <div className="max-h-[420px] overflow-auto">
              {data?.items.length ? null : <p className="p-6 text-center text-sm text-muted">{t('notifications.empty')}</p>}
              {data?.items.map((notification) => {
                const Icon = ICON[notification.category as keyof typeof ICON] ?? Info;
                return (
                  <Menu.Item key={notification.id} onSelect={() => go(notification.id, notification.link)} className={cn('flex w-full gap-3 border-b border-line/60 px-4 py-3 text-left cursor-pointer outline-none hover:bg-slate-50 data-[highlighted]:bg-slate-50', !notification.readAt && 'bg-brand-soft/30')}>
                    <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', TONE[notification.severity])}>
                      <Icon size={15} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{notification.title}</span>
                      {notification.body ? <span className="block truncate text-xs text-muted">{notification.body}</span> : null}
                      <span className="block text-[11px] text-muted">
                        {notification.siteCode} · {formatDateTime(notification.createdAt, timeZone)}
                      </span>
                    </span>
                    {!notification.readAt ? <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-brand" /> : null}
                  </Menu.Item>
                );
              })}
            </div>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      {toast ? (
        <button onClick={() => go(toast.notificationId, toast.link)} className="card fixed bottom-6 right-6 z-50 flex w-[340px] items-center gap-3 p-3 text-left shadow-lg">
          <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', TONE[toast.severity])}>
            <Bell size={16} />
          </span>
          <span className="min-w-0">
            <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted">{t(`notifications.category.${toast.category}`, { defaultValue: toast.category })}</span>
            <span className="block truncate text-sm font-semibold">{toast.title}</span>
          </span>
        </button>
      ) : null}
    </>
  );
}
