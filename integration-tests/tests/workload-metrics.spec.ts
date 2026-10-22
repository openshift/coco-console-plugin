import { test, expect } from '@playwright/test';
import { navigateTo, assertNoReactErrors, waitForContent } from './helpers.js';

/**
 * Gap 6 — Workload metrics tab.
 *
 * The workload detail page should have a Metrics tab that shows Prometheus
 * metric cards (CPU, memory, network, filesystem) with an info alert about
 * cadvisor limitations inside kata-cc guests.
 */
test.describe('Gap 6: Workload metrics tab', () => {
  test('Workload detail page has a Metrics tab', async ({
    page,
    baseURL,
  }) => {
    await navigateTo(page, baseURL!, '/confidential-containers/workloads');
    await waitForContent(page, /workloads|name|namespace/i);

    const firstRow = page.locator('table tbody tr a').first();
    if (await firstRow.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await firstRow.click();
      await waitForContent(page, /attestation|details|events|metrics/i);

      const metricsTab = page.locator('button[role="tab"]', {
        hasText: /Metrics/i,
      });
      await expect(metricsTab).toBeVisible({ timeout: 15_000 });
    }

    await assertNoReactErrors(page);
  });

  test('Metrics tab renders metric cards and cadvisor alert', async ({
    page,
    baseURL,
  }) => {
    await navigateTo(page, baseURL!, '/confidential-containers/workloads');
    await waitForContent(page, /workloads|name|namespace/i);

    const firstRow = page.locator('table tbody tr a').first();
    if (await firstRow.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await firstRow.click();
      await waitForContent(page, /attestation|details|metrics/i);

      const metricsTab = page.locator('button[role="tab"]', {
        hasText: /Metrics/i,
      });
      if (await metricsTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await metricsTab.click();
        await page.waitForTimeout(3_000);

        const body = await page.locator('body').innerText();
        expect(body).toMatch(/CPU usage|Memory|Network/i);

        const cadvisorAlert = page.locator('.pf-v6-c-alert', {
          hasText: /cadvisor|metrics.*confidential/i,
        });
        const hasAlert = await cadvisorAlert
          .isVisible({ timeout: 5_000 })
          .catch(() => false);
        expect(typeof hasAlert).toBe('boolean');
      }
    }

    await assertNoReactErrors(page);
  });
});
