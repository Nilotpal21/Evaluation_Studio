import { defineConfig } from 'vitest/config';
import { runtimeDefaultTestExcludes, runtimeVitestInclude } from './vitest.shared';

export default defineConfig({
  test: {
    include: runtimeVitestInclude,
    exclude: runtimeDefaultTestExcludes,
    // Use forked processes for test isolation.
    // Required because mongoose/MongoMemoryServer use module-level singletons
    // that can't be safely shared across test files in the same thread.
    pool: 'forks',
    // Cap worker fan-out so the root `pnpm turbo test --concurrency=4` run
    // does not oversubscribe CI and surface transient socket/race failures in
    // otherwise stable suites under heavy monorepo parallelism.
    maxWorkers: 4,
    // Higher timeouts for concurrent turbo runs where resource contention
    // slows dynamic imports and beforeAll hooks significantly.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: 2,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**'],
    },
  },
});
