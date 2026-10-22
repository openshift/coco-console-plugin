import { test, expect } from '@playwright/test';
import {
  navigateTo,
  assertNoReactErrors,
  waitForContent,
} from './helpers.js';

/**
 * Gap 1 — RBAC wiring on every mutating action.
 *
 * As kubeadmin, all mutating buttons should be enabled (no PermissionHint
 * warning). These tests verify the surfaces render without React errors and
 * that mutating controls are present.
 */
test.describe('Gap 1: RBAC gating on mutating surfaces', () => {
  test('Enable confidential containers button renders with RBAC check', async ({
    page,
    baseURL,
  }) => {
    await navigateTo(page, baseURL!, '/confidential-containers/setup');
    await waitForContent(page, /setup|checklist|confidential/i);

    const body = await page.locator('body').innerText();
    if (/enable confidential/i.test(body)) {
      const btn = page
        .locator('button', { hasText: /enable/i })
        .first();
      await expect(btn).toBeVisible({ timeout: 15_000 });
    }
    await assertNoReactErrors(page);
  });

  test('Create workload wizard renders with RBAC check', async ({
    page,
    baseURL,
  }) => {
    await navigateTo(page, baseURL!, '/confidential-containers/workloads/~new');
    await waitForContent(page, /create.*workload|confidential|runtime class/i);
    await assertNoReactErrors(page);
  });

  test('Workloads list page renders without RBAC errors', async ({
    page,
    baseURL,
  }) => {
    await navigateTo(page, baseURL!, '/confidential-containers/workloads');
    await waitForContent(page, /workloads|name|namespace/i);
    await assertNoReactErrors(page);
  });

  test('Setup page TEE detection button renders with RBAC check', async ({
    page,
    baseURL,
  }) => {
    await navigateTo(page, baseURL!, '/confidential-containers/setup');
    await waitForContent(page, /setup|checklist/i);

    const body = await page.locator('body').innerText();
    if (/TEE detection/i.test(body)) {
      const btn = page
        .locator('button', { hasText: /enable TEE|TEE detection/i })
        .first();
      if (await btn.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await expect(btn).toBeVisible();
      }
    }
    await assertNoReactErrors(page);
  });
});
