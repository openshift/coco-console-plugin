import { test, expect } from '@playwright/test';
import { navigateTo, assertNoReactErrors, waitForContent } from './helpers.js';
import { oc, ocAvailable } from './cluster.js';

const expectedBannerVisibility = (): boolean | null => {
  if (!ocAvailable()) return null;

  try {
    const infra = JSON.parse(oc('get infrastructure cluster -o json'));

    const platform = infra.status?.platformStatus?.type ?? infra.status?.platform;

    if (!platform) return null;

    const raw = oc(
      'get configmap peer-pods-cm -n openshift-sandboxed-containers-operator --ignore-not-found -o json',
    );

    const data = raw ? (JSON.parse(raw).data ?? {}) : {};

    const hasCvmPeerPods = Boolean(data.CLOUD_PROVIDER) && data.DISABLECVM !== 'true';

    return platform !== 'BareMetal' && platform !== 'None' && !hasCvmPeerPods;
  } catch {
    return null;
  }
};

test.describe('Bare-metal infrastructure banner', () => {
  for (const [name, route, content] of [
    ['Overview', '/confidential-containers', /overview|confidential/i],
    ['Setup', '/confidential-containers/setup', /setup|checklist/i],
  ] as const) {
    test(`${name} banner matches cluster configuration`, async ({ page, baseURL }) => {
      const expected = expectedBannerVisibility();

      if (expected === null) {
        test.skip(true, 'Cluster configuration unavailable');
        return;
      }

      await navigateTo(page, baseURL!, route);
      await waitForContent(page, content);

      const banner = page.getByText('Unsupported infrastructure', {
        exact: true,
      });

      if (expected) {
        await expect(banner).toBeVisible();
      } else {
        await expect(banner).toHaveCount(0);
      }

      await assertNoReactErrors(page);
    });
  }
});
