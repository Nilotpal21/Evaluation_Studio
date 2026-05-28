import { defineConfig } from 'vitest/config';
import fastConfig from './vitest.fast.config';
import { coverageUnitOnlyExcludePatterns } from './vitest.coverage.suites';

const baseTestConfig = fastConfig.test ?? {};
const baseExclude = Array.isArray(baseTestConfig.exclude) ? [...baseTestConfig.exclude] : [];

export default defineConfig({
  test: {
    ...baseTestConfig,
    // Keep the broad unit lane on the fast shared-cache threads pool.
    // Heavyweight regression files are peeled into a dedicated hotspots shard.
    exclude: [...new Set([...baseExclude, ...coverageUnitOnlyExcludePatterns])],
    coverage: {
      provider: 'v8',
      reporter: ['json'],
      reportsDirectory: './coverage/unit',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/__tests__/**'],
    },
  },
});
