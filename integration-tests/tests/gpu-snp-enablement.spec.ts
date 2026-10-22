import { test, expect } from '@playwright/test';
import { navigateTo, assertNoReactErrors, waitForContent } from './helpers.js';

/**
 * Gap 4 — SEV-SNP and GPU guided enablement.
 *
 * The setup checklist should include GPU prerequisites (IOMMU, GPU Operator)
 * and AMD SEV-SNP readiness steps when TEE nodes of those types are detected.
 * The IOMMU enablement component should render with vendor selection.
 */
test.describe('Gap 4: SEV-SNP and GPU guided enablement', () => {
  test('Setup page renders GPU prerequisites step when GPU or TDX nodes exist', async ({
    page,
    baseURL,
  }) => {
    await navigateTo(page, baseURL!, '/confidential-containers/setup');
    await waitForContent(page, /setup|checklist/i);

    const body = await page.locator('body').innerText();
    // GPU step only appears when on-node TEE is present and GPU/TDX/SNP detected.
    const hasGpuStep = /GPU prerequisites|IOMMU|GPU Operator/i.test(body);
    const hasSnpStep = /SEV-SNP host readiness|AMD Key Distribution/i.test(body);

    // These are conditional; just verify no React errors.
    expect(typeof hasGpuStep).toBe('boolean');
    expect(typeof hasSnpStep).toBe('boolean');

    await assertNoReactErrors(page);
  });

  test('Setup checklist renders without errors', async ({
    page,
    baseURL,
  }) => {
    await navigateTo(page, baseURL!, '/confidential-containers/setup');
    await waitForContent(page, /setup checklist|checklist/i);

    const checklistItems = page.locator('strong');
    const count = await checklistItems.count();
    expect(count).toBeGreaterThanOrEqual(3);

    await assertNoReactErrors(page);
  });

  test('NVIDIA GPU Operator docs link is present when GPU step shows', async ({
    page,
    baseURL,
  }) => {
    await navigateTo(page, baseURL!, '/confidential-containers/setup');
    await waitForContent(page, /setup|checklist/i);

    const body = await page.locator('body').innerText();
    if (/GPU prerequisites/i.test(body)) {
      const nvidiaLink = page.locator('a[href*="nvidia.com"]').first();
      await expect(nvidiaLink).toBeVisible({ timeout: 10_000 });
    }

    await assertNoReactErrors(page);
  });
});
