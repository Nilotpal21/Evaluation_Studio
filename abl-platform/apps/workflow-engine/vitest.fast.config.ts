/**
 * Vitest FAST tier — pure unit tests only.
 *
 * Uses `pool: 'threads'` to share the V8 module cache across test files.
 * Excludes the isolated-vm function-step tests, which require process-level
 * isolation under Linux/Node 24 to avoid native worker-thread crashes.
 *
 * Excludes tests that need fork-level isolation:
 *   - Supertest / HTTP tests (create real TCP servers)
 *   - Dynamic app import tests (heavy module loading)
 *   - System tests (real DB, Redis, external services)
 *
 * Run with: pnpm test:fast
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: [
      // ── E2E / cluster integration tests (need live infra) ───────────────
      'src/**/*.e2e.test.ts',
      'src/**/*.cluster.test.ts',
      'src/**/*.cluster.e2e.test.ts',

      // ── System tests (real DB, Redis) ──────────────────────────────────
      'src/__tests__/system-*.test.ts',

      // ── Supertest / HTTP / dynamic app import ──────────────────────────
      // These create real TCP servers or dynamically import the full app
      // entrypoint — both time out under parallel turbo load in threads pool
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

      // ── Native isolated-vm tests (forks-only) ────────────────────────────
      'src/__tests__/function-executor.test.ts',
      'src/__tests__/step-dispatcher.test.ts',
      'src/__tests__/e2e-basic.test.ts',

      // ── Supertest route tests in subdirectories ───────────────────────────
      'src/routes/__tests__/**',
    ],

    pool: 'threads',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
