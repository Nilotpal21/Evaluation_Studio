import { defineConfig } from 'vitest/config';
import { coverageContractSuites } from './vitest.coverage.suites';

export default defineConfig({
  test: {
    include: [...coverageContractSuites],
    // These suites are deterministic but resource-sensitive. Run them in the
    // coverage lane with fully serialized file execution so they contribute to
    // the gate without competing with the default fast lane.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['json'],
      reportsDirectory: './coverage/contracts',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/__tests__/**'],
    },
  },
});
