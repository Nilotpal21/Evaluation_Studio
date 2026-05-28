import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    pool: 'forks',
    // The root monorepo test run already executes many packages in parallel.
    // Keep this package to a single worker and disable file parallelism so
    // global encryption state and MongoMemoryServer-backed tests stay isolated
    // under Vitest 4's worker model.
    maxWorkers: 1,
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 30_000,
    exclude: ['dist/**', 'node_modules/**'],
    // MongoMemoryServer emits SyntaxError during mongod shutdown (stdout JSON parsing).
    // These are teardown artifacts, not real test failures.
    dangerouslyIgnoreUnhandledErrors: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**'],
    },
  },
});
