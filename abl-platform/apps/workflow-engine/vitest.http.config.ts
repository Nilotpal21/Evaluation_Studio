/**
 * Vitest HTTP tier — Express / Supertest / entrypoint tests that need stronger
 * isolation than the fast unit-test tier.
 *
 * These tests are reliable when run in a single fork, but they intermittently
 * fail with socket hangups when bundled into the default parallel package run.
 * Keep them out of the fast tier and execute them sequentially here instead.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'src/__tests__/graceful-shutdown.test.ts',
      'src/__tests__/workflow-executions-routes.test.ts',
      'src/__tests__/workflow-callbacks.test.ts',
      'src/__tests__/workflow-approvals.test.ts',
      'src/__tests__/route-integration.test.ts',
      'src/__tests__/notification-rules.test.ts',
      'src/__tests__/connectors-routes.test.ts',
      'src/__tests__/connections-routes.test.ts',
      'src/__tests__/executions-isolation.integration.test.ts',
      'src/__tests__/azure-di-usage-routes.test.ts',
      // Supertest route tests in src/routes/__tests__/ — excluded from fast tier
      'src/routes/__tests__/**/*.test.ts',
    ],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
