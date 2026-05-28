import { defineConfig, devices } from '@playwright/test';

const TEST_TIMEOUT_MS = 60_000;

export default defineConfig({
  testDir: '.',
  testMatch: ['git-bitbucket-e2e.spec.ts', 'git-lifecycle-boundary.spec.ts'],
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: TEST_TIMEOUT_MS,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'echo "Using existing server"',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
  },
});
