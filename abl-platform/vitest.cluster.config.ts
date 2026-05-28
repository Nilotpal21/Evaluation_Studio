import { defineConfig } from 'vitest/config';

/**
 * Vitest config for cluster-mode integration tests.
 *
 * Picks up `*.cluster.test.ts` and `*.cluster.e2e.test.ts` suites that talk
 * to a real Redis Cluster started by `docker-compose.cluster.yml`. The harness
 * exposes seed nodes at 127.0.0.1:7000-7005.
 *
 * Usage: see the `test:cluster` script in the root `package.json`.
 */
export default defineConfig({
  test: {
    include: ['**/*.cluster.test.ts', '**/*.cluster.e2e.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    teardownTimeout: 60_000,
    pool: 'forks',
    // Cluster harness state is shared across files — run sequentially.
    // (Vitest 4 removed nested `poolOptions`; the equivalent is the two
    // top-level flags below.)
    fileParallelism: false,
    isolate: false,
  },
});
