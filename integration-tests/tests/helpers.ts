import { Page, expect } from '@playwright/test';

const REACT_ERROR_PATTERNS = [
  'Something wrong happened',
  'Minified React error',
  'error #130',
  'error #310',
];

export async function waitForConsoleReady(page: Page, timeout = 120_000) {
  await expect(async () => {
    const body = await page.locator('body').innerText();
    expect(body.length).toBeGreaterThan(200);
    expect(body).toMatch(/Home|Confidential|Overview|Administrator/i);
  }).toPass({ timeout, intervals: [2_000] });
}

export async function waitForContent(
  page: Page,
  patterns: RegExp | string[],
  timeout = 180_000,
) {
  await waitForConsoleReady(page, Math.min(timeout, 60_000));
  const regex =
    patterns instanceof RegExp
      ? patterns
      : new RegExp(patterns.join('|'), 'i');
  // Prefer main content so sidebar chrome cannot satisfy the match early.
  const main = page.locator('#content-scrollable, .pf-v6-c-page__main, main, #content').first();
  await expect(async () => {
    const mainText = (await main.innerText().catch(() => '')) || '';
    const body = await page.locator('body').innerText();
    const haystack = mainText.length > 40 ? mainText : body;
    expect(haystack).toMatch(regex);
    expect(haystack.length).toBeGreaterThan(80);
  }).toPass({ timeout, intervals: [2_000] });
}

export async function assertNoReactErrors(page: Page) {
  const body = await page.locator('body').innerText();
  for (const pattern of REACT_ERROR_PATTERNS) {
    expect(body, `page should not contain "${pattern}"`).not.toContain(
      pattern,
    );
  }
}

export async function expandNavSection(page: Page, sectionName: string) {
  const section = page
    .locator('nav button, nav a', {
      hasText: new RegExp(`^${sectionName}$`, 'i'),
    })
    .first();
  if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
    const expanded = await section.getAttribute('aria-expanded');
    if (expanded !== 'true') {
      await section.click();
      await page.waitForTimeout(500);
    }
  }
}

export async function navigateTo(page: Page, baseURL: string, path: string) {
  await page.goto(`${baseURL}${path}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120_000,
  });
  await waitForConsoleReady(page);
}

export function collectJsErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

export function filterCriticalErrors(errors: string[]): string[] {
  return errors.filter(
    (msg) =>
      !msg.includes('ResizeObserver') &&
      !msg.includes('Non-Error promise rejection'),
  );
}
