/**
 * Vitest E2E tier — scenarios that exercise the real running stack.
 *
 * Each E2E test probes externally-provisioned infrastructure via
 * `helpers/e2e-gate.ts` and SKIPS (never fails) if the required flags
 * are off or any service is unreachable. Safe to run unconditionally in
 * CI — `--passWithNoTests` keeps the lane green when the whole suite
 * skips.
 *
 * Run locally:
 *   pnpm --filter=@agent-platform/workflow-engine test:e2e
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/__tests__/*.e2e.test.ts'],
    // Forks so each scenario gets its own process — avoids shared module
    // state bleeding between scenarios that hit different services.
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    // Budgets are generous: real Kafka + CH flush + projection can take
    // tens of seconds on a cold stack. Individual assertions inside the
    // test use tighter budgets via `pollUntil(..., budgetMs, intervalMs)`.
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
