import { defineConfig, devices } from '@playwright/test';
import {
  getSdkBrowserRuntimeBaseUrl,
  getSdkBrowserStudioBaseUrl,
  isIsolatedSdkBrowserE2E,
  SDK_BROWSER_STUDIO_READY_PATH,
} from './e2e/helpers/sdk-browser-env';

const studioBaseUrl = getSdkBrowserStudioBaseUrl();
const runtimeBaseUrl = getSdkBrowserRuntimeBaseUrl();
const TEST_TIMEOUT_MS = 180_000;
const WEB_SERVER_TIMEOUT_MS = 90_000;

process.env.TEST_BASE_URL ??= studioBaseUrl;
process.env.TEST_RUNTIME_URL ??= runtimeBaseUrl;

const runtimeStartCommand = process.env.SDK_BROWSER_E2E_RUNTIME_COMMAND;
const studioStartCommand = process.env.SDK_BROWSER_E2E_STUDIO_COMMAND;
const isolatedStackCommand = isIsolatedSdkBrowserE2E()
  ? 'pnpm exec tsx e2e/helpers/sdk-browser-stack.ts'
  : null;
const webServers = isolatedStackCommand
  ? [
      {
        command: isolatedStackCommand,
        url: `${studioBaseUrl}${SDK_BROWSER_STUDIO_READY_PATH}`,
        reuseExistingServer: false,
        timeout: WEB_SERVER_TIMEOUT_MS,
      },
    ]
  : [
      ...(runtimeStartCommand
        ? [
            {
              command: runtimeStartCommand,
              url: `${runtimeBaseUrl}/health`,
              reuseExistingServer: true,
              timeout: WEB_SERVER_TIMEOUT_MS,
            },
          ]
        : []),
      ...(studioStartCommand
        ? [
            {
              command: studioStartCommand,
              url: `${studioBaseUrl}/auth/login`,
              reuseExistingServer: true,
              timeout: WEB_SERVER_TIMEOUT_MS,
            },
          ]
        : []),
    ];

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: TEST_TIMEOUT_MS,
  use: {
    baseURL: studioBaseUrl,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(webServers.length > 0 ? { webServer: webServers } : {}),
});
