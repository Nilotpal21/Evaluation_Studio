/**
 * Playwright config for real E2E tests against live environments.
 *
 * Multi-project DAG config: projects declare dependencies so that
 * `--project=browse-create` automatically runs the setup chain first.
 *
 * NOT FOR CI — these tests require a running environment and are run manually.
 *
 * Usage:
 *   # Full create flow
 *   npx playwright test --config e2e-env.config.ts
 *
 *   # Single project (dependencies auto-run)
 *   npx playwright test --config e2e-env.config.ts --project=browse-create
 *
 *   # Against abl-dev
 *   TEST_BASE_URL=https://agents-dev.kore.ai npx playwright test --config e2e-env.config.ts
 *
 *   # Headed mode (watch the browser)
 *   npx playwright test --config e2e-env.config.ts --headed
 */

import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:5173';
const TEST_TIMEOUT_MS = 180_000;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1, // REQUIRED — state file is not concurrent-safe (D8)
  timeout: TEST_TIMEOUT_MS,
  globalSetup: './e2e/helpers/global-setup.ts',
  globalTeardown: './e2e/helpers/global-teardown.ts',
  reporter: [['list'], ['html', { outputFolder: 'e2e/reports', open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'on',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
  },
  projects: [
    // ─── Create Flow ───
    {
      name: 'setup-create',
      testMatch: 'searchai/phases/setup-create.spec.ts',
    },
    {
      name: 'with-llm',
      testMatch: 'searchai/phases/llm-config.spec.ts',
      dependencies: ['setup-create'],
    },
    {
      name: 'enriched',
      testMatch: 'searchai/phases/wait-enrichment.spec.ts',
      dependencies: ['with-llm'],
    },
    {
      name: 'search-create',
      testMatch: 'searchai/search-quality.spec.ts',
      dependencies: ['enriched'],
    },
    {
      name: 'browse-create',
      testMatch: 'searchai/browse-preview.spec.ts',
      dependencies: ['enriched'],
    },
    {
      name: 'intelligence-create',
      testMatch: 'searchai/intelligence.spec.ts',
      dependencies: ['enriched'],
    },
    {
      name: 'edge-cases',
      testMatch: 'searchai/edge-cases.spec.ts',
      // Independent — no dependencies on shared state
    },
    {
      name: 'cleanup',
      testMatch: 'searchai/phases/cleanup.spec.ts',
      dependencies: ['search-create', 'browse-create', 'intelligence-create'],
    },

    // ─── Existing Flow ───
    {
      name: 'setup-existing',
      testMatch: 'searchai/phases/setup-existing.spec.ts',
    },
    {
      name: 'search-existing',
      testMatch: 'searchai/search-quality.spec.ts',
      dependencies: ['setup-existing'],
    },
    {
      name: 'browse-existing',
      testMatch: 'searchai/browse-preview.spec.ts',
      dependencies: ['setup-existing'],
    },
    {
      name: 'intelligence-existing',
      testMatch: 'searchai/intelligence.spec.ts',
      dependencies: ['setup-existing'],
    },
  ],
});
