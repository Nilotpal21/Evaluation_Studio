import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    pool: 'forks',
    // The root monorepo test run already executes many packages in parallel.
    // Keep this package to a single worker and disable file parallelism so
    // MongoMemoryServer setup and dynamic-import-heavy tests do not time out
    // while the machine is saturated.
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    exclude: ['dist/**', 'node_modules/**', 'src/**/*.repro.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/__tests__/**'],
    },
  },
});
