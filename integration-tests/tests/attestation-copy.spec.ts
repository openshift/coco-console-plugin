import { test, expect } from '@playwright/test';
import { navigateTo, assertNoReactErrors, waitForContent } from './helpers.js';

/**
 * Gap 5 — Stale attestation copy cleanup.
 *
 * The setup and overview pages should NOT contain the old "Verify attestation"
 * copy. Instead they should reference the evidence sidecar pattern.
 */
test.describe('Gap 5: Stale attestation copy cleanup', () => {
  test('Setup page does not contain "Verify attestation" text', async ({
    page,
    baseURL,
  }) => {
    await navigateTo(page, baseURL!, '/confidential-containers/setup');
    await waitForContent(page, /setup|checklist/i);

    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/Verify attestation/);
    await assertNoReactErrors(page);
  });

  test('Setup page references evidence sidecar in run-workload step', async ({
    page,
    baseURL,
  }) => {
    await navigateTo(page, baseURL!, '/confidential-containers/setup');
    await waitForContent(page, /setup|checklist/i);

    const body = await page.locator('body').innerText();
    if (/run a confidential workload/i.test(body)) {
      expect(body).toMatch(/evidence sidecar|trust status/i);
    }
    await assertNoReactErrors(page);
  });

  test('Overview page does not contain stale attestation copy', async ({
    page,
    baseURL,
  }) => {
    await navigateTo(page, baseURL!, '/confidential-containers');
    await waitForContent(page, /overview|confidential/i);

    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/Verify attestation/);
    await assertNoReactErrors(page);
  });

  test('Workload detail attestation tab shows sidecar guidance when empty', async ({
    page,
    baseURL,
  }) => {
    await navigateTo(page, baseURL!, '/confidential-containers/workloads');
    await waitForContent(page, /workloads|name|namespace/i);

    const firstRow = page.locator('table tbody tr a').first();
    if (await firstRow.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await firstRow.click();
      await waitForContent(page, /attestation|details|events/i);

      const body = await page.locator('body').innerText();
      // If no evidence, should show sidecar guidance not "Verify attestation".
      if (/no evidence|no attestation/i.test(body)) {
        expect(body).toMatch(/sidecar|evidence/i);
        expect(body).not.toMatch(/Verify attestation/);
      }
    }

    await assertNoReactErrors(page);
  });
});
