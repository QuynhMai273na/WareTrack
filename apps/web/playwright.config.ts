import { defineConfig, devices } from '@playwright/test';

/**
 * E2E (mục 20): chạy trên Vite dev server (proxy /api, /ws → API local cổng 3000).
 * Cần API đang chạy với dữ liệu seed: pnpm db:seed && pnpm --filter @waretrack/api start
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1600, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      // WebGL phần mềm để scene 3D chạy được trên máy CI không có GPU
      use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 900 }, launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: 'pnpm exec vite --port 5173 --strictPort', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 120_000 },
});
