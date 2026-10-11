import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { SOCKET_NAMESPACE, SOCKET_PATH, type EventsReplayResponse, type RealtimeEnvelope, type SiteJoinAck, type SiteSnapshot } from '@waretrack/shared-schemas';
import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import { api, getAccessToken, refreshAccessToken } from '@/lib/api';
import { applyEventToSnapshot, SiteSequencer } from './sync';

export type LiveState = 'connecting' | 'live' | 'recovering' | 'reconnecting' | 'stale';

interface LiveStore {
  state: LiveState;
  since: number | null;
  lastEventAt: number | null;
  set: (state: LiveState) => void;
  touch: () => void;
}

export const useLive = create<LiveStore>((set, get) => ({
  state: 'connecting',
  since: null,
  lastEventAt: null,
  set: (state) => {
    if (get().state === state) return;
    set({ state, since: Date.now() });
  },
  touch: () => set({ lastEventAt: Date.now() }),
}));

const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) ?? '';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(`${WS_URL}${SOCKET_NAMESPACE}`, {
      path: SOCKET_PATH,
      transports: ['websocket', 'polling'],
      auth: (cb) => cb({ token: getAccessToken() }),
      reconnectionDelay: 500,
      reconnectionDelayMax: 10_000,
      randomizationFactor: 0.4,
    });
  }
  return socket;
}

export const snapshotKey = (siteId: string) => ['site', siteId, 'snapshot'] as const;

/** Invalidate (debounce) các query danh sách bị ảnh hưởng — danh sách lọc khó patch chính xác (mục 17.7). */
function invalidateRelated(qc: QueryClient, siteId: string, event: RealtimeEnvelope) {
  const keys: string[][] = [];
  if (event.type.startsWith('truck.')) keys.push(['site', siteId, 'visits'], ['site', siteId, 'visit', event.aggregate.id], ['site', siteId, 'docks']);
  if (event.type === 'dock.status_changed') keys.push(['site', siteId, 'docks']);
  if (event.type.startsWith('forklift.')) keys.push(['site', siteId, 'equipment']);
  if (event.type === 'inventory.updated' || event.type === 'pallet.moved') keys.push(['site', siteId, 'inventory']);
  if (event.type === 'shipment.progress_updated' || event.type === 'inventory.updated') keys.push(['site', siteId, 'shipments'], ['site', siteId, 'shipment', event.aggregate.id]);
  if (event.type === 'shipment.progress_updated') keys.push(['site', siteId, 'shipment']);
  if (event.type.startsWith('vehicle.') || event.type === 'slot.status_changed') keys.push(['site', siteId, 'vehicles']);
  if (event.type === 'task.status_changed' || event.type === 'forklift.task_updated') keys.push(['site', siteId, 'tasks']);
  if (event.type === 'exception.raised') keys.push(['site', siteId, 'exceptions']);
  if (event.type.startsWith('vehicle.')) keys.push(['site', siteId, 'vehicles'], ['vehicle-history']);
  if (event.type === 'slot.status_changed') keys.push(['site', siteId, 'vehicles', 'slots']);
  // Sơ đồ vừa publish → tải lại layout + snapshot (vị trí mới/đổi) cho scene 3D và các bảng
  if (event.type === 'layout.published') keys.push(['site', siteId, 'layout'], ['site', siteId, 'snapshot'], ['admin', 'locations', siteId]);
  for (const affectedKey of keys) void qc.invalidateQueries({ queryKey: affectedKey });
}

/**
 * Đồng bộ realtime cho site hiện hành (mục 17.6): join → buffer → snapshot → áp dụng event > asOfSeq;
 * phát hiện gap → replay afterSeq → truncated thì tải lại snapshot; mất kết nối > 10s → Stale.
 */
export function useSiteRealtime(siteId: string | undefined) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!siteId) return;
    const siteSocket = getSocket();
    const live = useLive.getState();
    const seq = new SiteSequencer(siteId);
    let syncing = true;
    let pending: RealtimeEnvelope[] = [];
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const apply = (events: RealtimeEnvelope[]) => {
      if (events.length === 0) return;
      qc.setQueryData<SiteSnapshot>(snapshotKey(siteId), (old) => (old ? events.reduce(applyEventToSnapshot, old) : old));
      for (const event of events) invalidateRelated(qc, siteId, event);
      useLive.getState().touch();
    };

    const resync = async () => {
      syncing = true;
      live.set('recovering');
      try {
        const snap = await qc.fetchQuery({ queryKey: snapshotKey(siteId), queryFn: () => api<SiteSnapshot>(`/sites/${siteId}/snapshot`), staleTime: 0 });
        if (disposed) return;
        seq.reset(snap.asOfSeq);
        const buffered = pending;
        pending = [];
        for (const event of buffered) apply(seq.accept(event).ready);
        syncing = false;
        useLive.getState().set('live');
      } catch {
        syncing = false;
      }
    };

    const replay = async () => {
      live.set('recovering');
      try {
        const res = await api<EventsReplayResponse>(`/sites/${siteId}/events?afterSeq=${seq.lastSeq}`);
        if (res.truncated) return resync();
        for (const event of res.events) apply(seq.accept(event).ready);
        useLive.getState().set('live');
      } catch {
        await resync();
      }
    };

    const onEvent = (event: RealtimeEnvelope) => {
      if (event.siteId !== siteId) return;
      if (syncing) {
        pending.push(event);
        return;
      }
      const { ready, gap } = seq.accept(event);
      apply(ready);
      if (gap) void replay();
    };

    const join = () => {
      siteSocket.emit('site:join', { siteId }, (ack: SiteJoinAck) => {
        if (!ack.ok) return useLive.getState().set('stale');
        if (staleTimer) clearTimeout(staleTimer);
        // Lần đầu: snapshot; reconnect: thử replay trước (mục 17.6 bước 4)
        if (seq.lastSeq === 0) void resync();
        else void replay();
      });
    };

    const onDisconnect = () => {
      useLive.getState().set('reconnecting');
      staleTimer = setTimeout(() => useLive.getState().set('stale'), 10_000);
    };

    const onConnectError = async (err: Error & { data?: { code?: string } }) => {
      if (err.data?.code === 'UNAUTHENTICATED') {
        const token = await refreshAccessToken();
        if (token) siteSocket.connect();
      }
    };

    const onSessionExpired = async () => {
      await refreshAccessToken();
      siteSocket.connect();
    };

    siteSocket.on('connect', join);
    siteSocket.on('event', onEvent);
    siteSocket.on('disconnect', onDisconnect);
    siteSocket.on('connect_error', onConnectError);
    siteSocket.on('session:expired', onSessionExpired);
    if (siteSocket.connected) join();
    else {
      live.set('connecting');
      siteSocket.connect();
    }

    return () => {
      disposed = true;
      if (staleTimer) clearTimeout(staleTimer);
      siteSocket.off('connect', join);
      siteSocket.off('event', onEvent);
      siteSocket.off('disconnect', onDisconnect);
      siteSocket.off('connect_error', onConnectError);
      siteSocket.off('session:expired', onSessionExpired);
      siteSocket.emit('site:leave');
    };
  }, [siteId, qc]);
}

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
}
