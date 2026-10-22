import { test, expect } from '@playwright/test';
import { assertNoReactErrors, waitForContent, waitForConsoleReady } from './helpers.js';
import { viewerCreds } from './cluster.js';

/**
 * Manual matrix B-45/46/47: view-only gating on CoCo mutating surfaces.
 * Requires BRIDGE_VIEWER_USER / BRIDGE_VIEWER_PASSWORD (cluster-local; not shared with OSC CI).
 */
test.describe('CoCo view-only RBAC', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  const creds = viewerCreds();

  test.beforeEach(async ({ page, baseURL }) => {
    test.skip(!creds, 'Set BRIDGE_VIEWER_USER and BRIDGE_VIEWER_PASSWORD to run view-only checks');

    await page.goto(`${baseURL}/auth/login`, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });
    const provider = page.locator('a').filter({ hasText: /htpasswd|plugin-viewer/i }).first();
    if (await provider.isVisible({ timeout: 15_000 }).catch(() => false)) {
      await provider.click();
    }
    await page.fill('input[name="username"], #inputUsername', creds!.user);
    await page.fill('input[name="password"], #inputPassword', creds!.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(
      (u) =>
        u.origin.includes('console-openshift-console') &&
        !u.pathname.includes('/login') &&
        !u.pathname.includes('/auth/error'),
      { timeout: 180_000 },
    );
    await page.goto(baseURL!, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await waitForConsoleReady(page);
  });

  test('B-46 Create workload control hidden or disabled for viewer', async ({
    page,
    baseURL,
  }) => {
    await page.goto(`${baseURL}/confidential-containers/workloads`, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });
    await waitForContent(page, /workloads|confidential|create|name/i);

    const create = page.getByRole('link', { name: /^Create$/i }).or(
      page.getByRole('button', { name: /create.*workload|create/i }),
    ).first();
    const visible = await create.isVisible({ timeout: 10_000 }).catch(() => false);
    if (visible) {
      const disabled = await create.isDisabled().catch(() => false);
      const aria = await create.getAttribute('aria-disabled');
      expect(disabled || aria === 'true').toBeTruthy();
    }
    await assertNoReactErrors(page);
  });

  test('B-45/47 Enable / TEE actions disabled for viewer', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/confidential-containers/setup`, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });
    await waitForContent(page, /setup|checklist|confidential|enable|TEE/i);

    const mutators = page.locator('button').filter({
      hasText: /enable confidential|enable TEE|TEE detection/i,
    });
    const n = await mutators.count();
    for (let i = 0; i < n; i++) {
      const btn = mutators.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        await expect(btn).toBeDisabled();
      }
    }
    await assertNoReactErrors(page);
  });
});
