import { defineConfig, devices } from '@playwright/test';
import path from 'path';

const baseURL = process.env.BRIDGE_BASE_ADDRESS;
if (!baseURL) {
  throw new Error(
    'BRIDGE_BASE_ADDRESS is required (e.g. https://console-openshift-console.apps.example.com)',
  );
}

const authFile = path.join(__dirname, '.auth', 'kubeadmin.json');

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },

  reporter: process.env.CI
    ? [
        ['junit', { outputFile: 'results/junit-results.xml' }],
        ['html', { open: 'never', outputFolder: 'results/html' }],
      ]
    : [['html', { open: 'on-failure', outputFolder: 'results/html' }]],

  outputDir: 'results/test-output',

  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 120_000,
    ...(process.env.PROXY_SERVER
      ? { proxy: { server: process.env.PROXY_SERVER } }
      : {}),
  },

  projects: [
    {
      name: 'setup',
      testDir: '.',
      testMatch: /global-setup\.ts/,
    },
    {
      name: 'coco-e2e',
      use: {
        ...devices['Desktop Chrome'],
        storageState: authFile,
      },
      dependencies: ['setup'],
    },
  ],
});

export { authFile };
