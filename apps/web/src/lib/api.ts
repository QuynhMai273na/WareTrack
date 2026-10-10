import type { ProblemDetails } from '@waretrack/shared-schemas';
import { ErrorCode } from '@waretrack/shared-schemas';

export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || '/api/v1';

/** Lỗi API theo RFC 9457 (mục 16.2) — client xử lý theo `code`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails,
  ) {
    super(problem.title);
  }
  get code() {
    return this.problem.code;
  }
}

let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
const tokenListeners = new Set<(t: string | null) => void>();

export function getAccessToken() {
  return accessToken;
}

export function setAccessToken(token: string | null) {
  accessToken = token;
  for (const l of tokenListeners) l(token);
}

export function onTokenChange(listener: (t: string | null) => void) {
  tokenListeners.add(listener);
  return () => tokenListeners.delete(listener);
}

/** Xoay refresh token (cookie httpOnly); single-flight để nhiều request 401 cùng lúc chỉ refresh một lần. */
export function refreshAccessToken(): Promise<string | null> {
  refreshing ??= fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) return null;
      const body = (await res.json()) as { accessToken: string };
      return body.accessToken;
    })
    .catch(() => null)
    .then((token) => {
      setAccessToken(token);
      return token;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Idempotency-Key cho POST/DELETE — giữ nguyên khi retry cùng một ý định (mục 16.1). */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const idempotencyKey = method === 'POST' || method === 'DELETE' ? (opts.idempotencyKey ?? crypto.randomUUID()) : undefined;
  const doFetch = (token: string | null) =>
    fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      signal: opts.signal,
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let res = await doFetch(accessToken);
  if (res.status === 401 || res.status === 403) {
    const problem = (await res.clone().json().catch(() => null)) as ProblemDetails | null;
    const retryable = problem?.code === ErrorCode.TOKEN_EXPIRED || problem?.code === ErrorCode.PERMISSION_VERSION_STALE || (res.status === 401 && problem?.code === ErrorCode.UNAUTHENTICATED && !!accessToken);
    if (retryable) {
      const token = await refreshAccessToken();
      if (token) res = await doFetch(token);
    }
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const problem: ProblemDetails = data?.code ? data : { type: 'about:blank', title: res.statusText || 'Request failed', status: res.status, code: `HTTP_${res.status}` };
    throw new ApiError(res.status, problem);
  }
  return data as T;
}

/** Thông điệp thân thiện cho lỗi nghiệp vụ, kèm danh sách blocker nếu có. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const blockers = (err.problem.details?.blockers as Array<{ message: string }> | undefined)?.map((b) => b.message);
    const missing = err.problem.details?.missing as string[] | undefined;
    return [err.problem.title, blockers?.join(' · '), missing ? `Missing: ${missing.join(', ')}` : null].filter(Boolean).join(' — ');
  }
  return err instanceof Error ? err.message : String(err);
}
