import { expect, type Page, test } from '@playwright/test';

const PASSWORD = 'WareTrack@2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/sites\/[A-Z0-9-]+/);
}

test.describe('WareTrack demo', () => {
  test('login → dashboard shows KPIs and live indicator', async ({ page }) => {
    await login(page, 'manager');
    await page.goto('/sites/WH-01');
    await expect(page.getByText('WH-01').first()).toBeVisible();
    await expect(page.locator('header [title="live"]')).toBeVisible();
    // 3 ô KPI có đơn vị + phạm vi site (BR-31)
    await expect(page.getByText('pallets · WH-01')).toBeVisible();
  });

  test('wrong password is rejected', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#username', 'manager');
    await page.fill('#password', 'nope-nope');
    await page.click('button[type=submit]');
    await expect(page).toHaveURL(/\/login/);
  });

  test('vehicle yard: list, filter and VIN history', async ({ page }) => {
    await login(page, 'manager');
    await page.goto('/sites/WH-06/vehicles');
    const firstVin = page.locator('button .font-mono').first();
    await expect(firstVin).toHaveText(/^[A-HJ-NPR-Z0-9]{17}$/);
    // Lọc xe đang giữ → mọi dòng có biểu tượng giữ, chi tiết hiện lý do
    await page.locator('button', { hasText: /On hold ·|Đang giữ ·/ }).click();
    await expect(page.locator('.bg-bad-soft').first()).toBeVisible();
    await expect(page.getByText(/VIN history|Lịch sử theo VIN/)).toBeVisible();
  });

  test('exceptions: report an incident and see it in the open list', async ({ page }) => {
    await login(page, 'supervisor');
    await page.goto('/sites/WH-01/exceptions');
    await page.locator('button', { hasText: /Report incident|Báo sự cố/ }).first().click();
    const text = `E2E incident ${Date.now()}`;
    await page.locator('textarea').fill(text);
    await page.locator('form button[type=submit]').click();
    await expect(page.getByText(text).first()).toBeVisible();
  });

  test('viewer cannot see management pages', async ({ page }) => {
    await login(page, 'viewer');
    await page.goto('/sites/WH-01');
    // Điều hướng nằm trong menu người dùng (bố cục video)
    await page.getByTestId('user-menu').click();
    await expect(page.getByRole('menuitem', { name: /Exceptions|Ngoại lệ/ })).toHaveCount(1);
    await expect(page.getByRole('menuitem', { name: /Inbound|Nhập/ })).toHaveCount(0);
  });
});
