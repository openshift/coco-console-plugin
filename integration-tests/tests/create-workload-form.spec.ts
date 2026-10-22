import { test, expect } from '@playwright/test';
import { navigateTo, assertNoReactErrors, waitForContent } from './helpers.js';

/**
 * Manual matrix B-41: Create CoCo workload form (no submit).
 */
test.describe('Create CoCo workload form', () => {
  test('B-41 create form renders', async ({ page, baseURL }) => {
    await navigateTo(page, baseURL!, '/confidential-containers/workloads/~new');
    await waitForContent(page, /create|workload|confidential|runtime|kata-cc/i);

    const body = await page.locator('#content-scrollable, body').first().innerText();
    expect(body.length).toBeGreaterThan(80);
    expect(body).toMatch(/runtime|kata|name|image|namespace/i);
    await assertNoReactErrors(page);
  });
});
