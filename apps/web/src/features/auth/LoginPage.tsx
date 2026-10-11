import { zodResolver } from '@hookform/resolvers/zod';
import { LoginRequest } from '@waretrack/shared-schemas';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { api, describeError } from '@/lib/api';
import { useAuth } from '@/stores/auth';

const DEMO_USERS = ['manager', 'dispatcher', 'gate', 'supervisor', 'operator', 'forklift', 'inventory', 'viewer', 'admin'];

export function LoginPage() {
  const { t } = useTranslation();
  const status = useAuth((state) => state.status);
  const me = useAuth((state) => state.me);
  const login = useAuth((state) => state.login);
  const [error, setError] = useState<string | null>(null);
  // Tài khoản mẫu chỉ hiện ở bản demo; vận hành thật không gợi ý username
  const { data: runInfo } = useQuery({ queryKey: ['health', 'info'], queryFn: () => api<{ mode: 'demo' | 'live' }>('/health/info'), staleTime: Infinity });
  const demoMode = runInfo?.mode === 'demo';
  const form = useForm<LoginRequest>({ resolver: zodResolver(LoginRequest), defaultValues: { username: '', password: '' } });

  if (status === 'authenticated' && me) return <Navigate to="/" replace />;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await login(values.username, values.password);
    } catch (err) {
      setError(describeError(err));
    }
  });

  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-[#e9ecf6] via-[#eef2fb] to-[#dfe7fb] p-4">
      <div className="card w-full max-w-sm p-7">
        <div className="mb-6 flex items-center gap-2">
          <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden>
            <path fill="#2f6fe4" d="M16 2 29 9v14l-13 7-13-7V9z" />
            <path fill="#5b8ff0" d="M16 2 29 9l-13 7L3 9z" />
            <path fill="#1f4fb8" d="M16 16v14l13-7V9z" />
          </svg>
          <div>
            <h1 className="text-lg font-bold">{t('login.title')}</h1>
            <p className="text-xs text-muted">{t('login.subtitle')}</p>
          </div>
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <Label htmlFor="username">{t('login.username')}</Label>
            <Input id="username" autoComplete="username" {...form.register('username')} />
          </div>
          <div>
            <Label htmlFor="password">{t('login.password')}</Label>
            <Input id="password" type="password" autoComplete="current-password" {...form.register('password')} />
          </div>
          {error ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{error}</p> : null}
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {t('login.submit')}
          </Button>
        </form>
        {demoMode ? (
        <div className="mt-6 border-t border-line pt-4">
          <p className="mb-2 text-xs text-muted">{t('login.demo')}</p>
          <div className="flex flex-wrap gap-1.5">
            {DEMO_USERS.map((demoUsername) => (
              <button
                key={demoUsername}
                type="button"
                className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-brand-soft hover:text-brand"
                onClick={() => {
                  form.setValue('username', demoUsername);
                  form.setValue('password', 'WareTrack@2026');
                }}
              >
                {demoUsername}
              </button>
            ))}
          </div>
        </div>
        ) : null}
      </div>
    </div>
  );
}
