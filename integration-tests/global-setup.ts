import { test as setup, expect } from '@playwright/test';
import path from 'path';

const authFile = path.join(__dirname, '.auth', 'kubeadmin.json');

setup('authenticate as kubeadmin', async ({ page, baseURL }) => {
  const password = process.env.BRIDGE_KUBEADMIN_PASSWORD;
  if (!password) {
    throw new Error('BRIDGE_KUBEADMIN_PASSWORD is required');
  }

  await page.goto(`${baseURL}/auth/login`, {
    waitUntil: 'domcontentloaded',
    timeout: 120_000,
  });

  const kubeLink = page.locator('a', { hasText: 'kube:admin' }).first();
  if (await kubeLink.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await kubeLink.click();
  }

  await page.fill('input[name="username"], #inputUsername', 'kube:admin');
  await page.fill('input[name="password"], #inputPassword', password);
  await page.click('button[type="submit"]');

  await page.waitForURL(
    (url) =>
      url.origin.includes('console-openshift-console') &&
      !url.pathname.includes('/login') &&
      !url.pathname.includes('/auth/error'),
    { timeout: 120_000 },
  );

  // Console SPA can mount empty after OAuth; retry navigation instead of reload.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(baseURL!, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });
    await page.waitForTimeout(4_000);
    const len = (await page.locator('body').innerText()).length;
    if (len > 200) break;
  }

  await expect(async () => {
    const body = await page.locator('body').innerText();
    expect(body.length).toBeGreaterThan(200);
    expect(body).toMatch(/kube:admin|Home|Overview|Administrator/i);
  }).toPass({ timeout: 180_000, intervals: [3_000] });

  const skipTour = page.getByRole('button', { name: /Skip tour/i });
  if (await skipTour.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await skipTour.click();
  }

  await page.context().storageState({ path: authFile });
});
