import { test } from '@playwright/test';
import { waitForContent, assertNoReactErrors } from './helpers.js';

test.describe('CoCo plugin pages load without errors', () => {
  const routes = [
    {
      name: 'Overview',
      path: '/confidential-containers',
      content: /overview|confidential|TEE|kata/i,
    },
    {
      name: 'Setup',
      path: '/confidential-containers/setup',
      content: /setup|checklist|confidential|TEE detection/i,
    },
    {
      name: 'Workloads',
      path: '/confidential-containers/workloads',
      content: /workloads|name|namespace|confidential/i,
    },
    {
      name: 'Runtime classes',
      path: '/confidential-containers/runtime-classes',
      content: /runtime class|kata|handler/i,
    },
    {
      name: 'Create workload',
      path: '/confidential-containers/workloads/~new',
      content: /create.*workload|confidential|runtime class|namespace/i,
    },
    {
      name: 'Attestation topology',
      path: '/confidential-containers/attestation-topology',
      content: /attestation|topology|confidential|workload/i,
    },
  ];

  for (const route of routes) {
    test(`${route.name} (${route.path}) renders`, async ({
      page,
      baseURL,
    }) => {
      await page.goto(`${baseURL}${route.path}`, {
        waitUntil: 'domcontentloaded',
        timeout: 120_000,
      });
      await waitForContent(page, route.content);
      await assertNoReactErrors(page);
    });
  }
});
