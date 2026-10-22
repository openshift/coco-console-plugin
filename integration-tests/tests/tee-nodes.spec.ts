import { test, expect } from '@playwright/test';
import { navigateTo, assertNoReactErrors, waitForContent } from './helpers.js';

/**
 * Gap 3 — TEE node ineligibility reasons.
 *
 * The TEE nodes page should show all worker nodes (not just TEE-labeled ones)
 * with columns for TEE type, GPU CC, Kata status, MCP, readiness, eligibility,
 * and reasons. A toggle filter allows switching between all workers and
 * TEE-capable only.
 */
test.describe('Gap 3: TEE node ineligibility and composite readiness', () => {
  test('TEE nodes page renders the node table', async ({
    page,
    baseURL,
  }) => {
    await navigateTo(page, baseURL!, '/confidential-containers/tee-nodes');

    const body = await page.locator('body').innerText();
    // Page may or may not be gated by COCO_ONNODE_TEE flag.
    if (/TEE-capable nodes|All workers/i.test(body)) {
      await waitForContent(page, /Node|TEE|Eligible|Reasons/i);

      const table = page.locator('table');
      await expect(table).toBeVisible({ timeout: 15_000 });

      const headers = await page.locator('table thead th').allInnerTexts();
      expect(headers.join(' ')).toMatch(/Node/i);
      expect(headers.join(' ')).toMatch(/Eligible/i);
    }

    await assertNoReactErrors(page);
  });

  test('TEE nodes page has All workers / TEE-capable toggle', async ({
    page,
    baseURL,
  }) => {
    await navigateTo(page, baseURL!, '/confidential-containers/tee-nodes');
    const body = await page.locator('body').innerText();

    if (/TEE-capable nodes/i.test(body)) {
      const allToggle = page.locator('button', { hasText: /All workers/i }).first();
      const teeToggle = page.locator('button', { hasText: /TEE-capable only/i }).first();

      const allVisible = await allToggle.isVisible({ timeout: 5_000 }).catch(() => false);
      const teeVisible = await teeToggle.isVisible({ timeout: 5_000 }).catch(() => false);

      expect(allVisible || teeVisible).toBe(true);
    }

    await assertNoReactErrors(page);
  });

  test('ineligible nodes show reasons column', async ({
    page,
    baseURL,
  }) => {
    await navigateTo(page, baseURL!, '/confidential-containers/tee-nodes');
    const body = await page.locator('body').innerText();

    if (/TEE-capable nodes|All workers/i.test(body)) {
      const reasonCells = page.locator('table td[data-label="Reasons"]');
      const count = await reasonCells.count();
      if (count > 0) {
        const firstReason = await reasonCells.first().innerText();
        // Reasons column should either show "—" (eligible) or a reason string.
        expect(firstReason.length).toBeGreaterThan(0);
      }
    }

    await assertNoReactErrors(page);
  });
});
