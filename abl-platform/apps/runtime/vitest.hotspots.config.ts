import { defineConfig } from 'vitest/config';
import { coverageHotspotSuites } from './vitest.coverage.suites';

export default defineConfig({
  test: {
    include: [...coverageHotspotSuites],
    exclude: ['dist/**', 'node_modules/**'],

    // These files are deterministic in isolation but become unstable when
    // they share the broad threads-pool unit shard during monorepo runs.
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    retry: 2,
  },
});
