import type { LoginResponse, MeResponse } from '@waretrack/shared-schemas';
import { create } from 'zustand';
import { api, refreshAccessToken, setAccessToken } from '@/lib/api';

type Status = 'unknown' | 'authenticated' | 'anonymous';

interface AuthState {
  status: Status;
  me: MeResponse | null;
  bootstrap: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  reloadMe: () => Promise<void>;
  can: (siteId: string | undefined, permission: string) => boolean;
}

/** Access token chỉ nằm trong bộ nhớ (không localStorage — mục 19.1); refresh token ở cookie httpOnly. */
export const useAuth = create<AuthState>((set, get) => ({
  status: 'unknown',
  me: null,
  async bootstrap() {
    const token = await refreshAccessToken();
    if (!token) return set({ status: 'anonymous', me: null });
    try {
      set({ status: 'authenticated', me: await api<MeResponse>('/auth/me') });
    } catch {
      set({ status: 'anonymous', me: null });
    }
  },
  async login(username, password) {
    const res = await api<LoginResponse>('/auth/login', { method: 'POST', body: { username, password } });
    setAccessToken(res.accessToken);
    set({ status: 'authenticated', me: await api<MeResponse>('/auth/me') });
  },
  async logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setAccessToken(null);
    set({ status: 'anonymous', me: null });
  },
  async reloadMe() {
    set({ me: await api<MeResponse>('/auth/me') });
  },
  can(siteId, permission) {
    const me = get().me;
    if (!me) return false;
    if (!siteId) return me.enterprisePermissions.includes(permission) || me.sites.some((s) => s.permissions.includes(permission));
    return me.sites.find((s) => s.id === siteId)?.permissions.includes(permission) ?? false;
  },
}));
