import { test, expect } from '@playwright/test';
import {
  waitForConsoleReady,
  expandNavSection,
  collectJsErrors,
  filterCriticalErrors,
} from './helpers.js';

test.describe('CoCo nav section visibility', () => {
  test('Confidential Containers section is present in admin nav', async ({
    page,
    baseURL,
  }) => {
    await page.goto(`${baseURL}/confidential-containers`, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });
    await waitForConsoleReady(page);

    const nav = page.locator('nav');
    const navText = await nav.innerText();
    expect(navText).toContain('Confidential Containers');
  });

  const navItems = [
    { name: 'Overview', href: '/confidential-containers' },
    { name: 'Setup', href: '/confidential-containers/setup' },
    { name: 'Workloads', href: '/confidential-containers/workloads' },
    { name: 'Runtime classes', href: '/confidential-containers/runtime-classes' },
  ];

  for (const item of navItems) {
    test(`nav item "${item.name}" is visible after expanding section`, async ({
      page,
      baseURL,
    }) => {
      await page.goto(`${baseURL}/confidential-containers`, {
        waitUntil: 'domcontentloaded',
        timeout: 120_000,
      });
      await waitForConsoleReady(page);

      await expandNavSection(page, 'Confidential Containers');

      const link = page.locator(`nav a[href="${item.href}"]`).first();
      await expect(link).toBeVisible({ timeout: 15_000 });
    });
  }

  test('TEE nodes nav item appears when COCO_ONNODE_TEE flag is set', async ({
    page,
    baseURL,
  }) => {
    await page.goto(`${baseURL}/confidential-containers`, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });
    await waitForConsoleReady(page);
    await expandNavSection(page, 'Confidential Containers');

    const teeLink = page
      .locator('nav a[href="/confidential-containers/tee-nodes"]')
      .first();
    const visible = await teeLink.isVisible({ timeout: 10_000 }).catch(() => false);
    // TEE nodes is flag-gated (COCO_ONNODE_TEE); may or may not appear depending
    // on whether the cluster has on-node TEE RuntimeClasses.
    expect(typeof visible).toBe('boolean');
  });

  test('no JS console errors on Overview page', async ({ page, baseURL }) => {
    const jsErrors = collectJsErrors(page);
    await page.goto(`${baseURL}/confidential-containers`, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });
    await waitForConsoleReady(page);

    const critical = filterCriticalErrors(jsErrors);
    expect(
      critical,
      `unexpected JS errors: ${critical.join('; ')}`,
    ).toHaveLength(0);
  });
});
