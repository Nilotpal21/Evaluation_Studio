import { defineConfig, devices } from '@playwright/test';

const studioBaseUrl = process.env.STUDIO_URL ?? 'http://localhost:5173';
const TEST_TIMEOUT_MS = 60_000;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  timeout: TEST_TIMEOUT_MS,
  use: {
    baseURL: studioBaseUrl,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'echo "Using existing PM2 server"',
    url: studioBaseUrl,
    reuseExistingServer: true,
  },
});
