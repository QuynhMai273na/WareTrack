import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import './i18n';
import './index.css';
import { LoginPage } from './features/auth/LoginPage';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { ExceptionsPage } from './features/exceptions/ExceptionsPage';
import { InventoryPage } from './features/inventory/InventoryPage';
import { InboundPage } from './features/inbound/InboundPage';
import { OutboundPage } from './features/outbound/OutboundPage';
import { TasksPage } from './features/tasks/TasksPage';
import { VehiclesPage } from './features/vehicles/VehiclesPage';
import { SiteShell } from './features/shell/SiteShell';
import { YardPage } from './features/yard/YardPage';
import { ApiError } from './lib/api';
import { disconnectRealtime } from './realtime/useSiteRealtime';
import { useAuth } from './stores/auth';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

function RequireAuth({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status);
  if (status === 'unknown') return <div className="flex h-full items-center justify-center text-muted">Loading…</div>;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** Site mặc định: site làm việc gần nhất (preference cục bộ), nếu không thì site đầu tiên được phép. */
export function defaultSiteCode(sites: Array<{ code: string }>): string | null {
  let last: string | null = null;
  try {
    last = localStorage.getItem('wt.lastSite');
  } catch {
    /* bỏ qua */
  }
  return sites.find((s) => s.code === last)?.code ?? sites[0]?.code ?? null;
}

function HomeRedirect() {
  const me = useAuth((s) => s.me);
  const code = defaultSiteCode(me?.sites ?? []);
  return code ? <Navigate to={`/sites/${code}`} replace /> : <div className="p-8 text-muted">No site access</div>;
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <HomeRedirect />
      </RequireAuth>
    ),
  },
  {
    path: '/sites/:siteCode',
    element: (
      <RequireAuth>
        <SiteShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'yard', element: <YardPage /> },
      { path: 'inventory', element: <InventoryPage /> },
      { path: 'inbound', element: <InboundPage /> },
      { path: 'outbound', element: <OutboundPage /> },
      { path: 'vehicles', element: <VehiclesPage /> },
      { path: 'tasks', element: <TasksPage /> },
      { path: 'exceptions', element: <ExceptionsPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

function App() {
  const bootstrap = useAuth((s) => s.bootstrap);
  const status = useAuth((s) => s.status);
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);
  useEffect(() => {
    if (status === 'anonymous') {
      disconnectRealtime();
      queryClient.clear();
    }
  }, [status]);
  return <RouterProvider router={router} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
