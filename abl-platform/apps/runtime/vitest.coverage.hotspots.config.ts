import { defineConfig } from 'vitest/config';
import { coverageHotspotSuites } from './vitest.coverage.suites';

export default defineConfig({
  test: {
    include: [...coverageHotspotSuites],
    // These suites are the ones that historically push the unit lane into
    // unstable territory under the shared threads pool. Keep them isolated
    // and deterministic, but separate from the broad fast lane.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['json'],
      reportsDirectory: './coverage/hotspots',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/__tests__/**'],
    },
  },
});
