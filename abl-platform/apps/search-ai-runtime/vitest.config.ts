import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      'dist/**',
      'node_modules/**',
      // OOMs in forked worker due to heavy transitive imports from database models.
      // Run separately with increased heap: NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/__tests__/query-services.test.ts
      'src/__tests__/query-services.test.ts',
      // MongoDB-dependent tests (require MongoMemoryServer binary).
      // Run in integration tier: npx vitest run --config vitest.integration.config.ts
      'src/__tests__/capability-service.test.ts',
      'src/__tests__/dynamic-vocabulary-resolver.test.ts',
    ],
    // Use forked processes for test isolation.
    // Required because mongoose/MongoMemoryServer use module-level singletons
    // that can't be safely shared across test files in the same thread.
    pool: 'forks',
    // The root monorepo test run already parallelizes packages. Keep this
    // package single-worker to avoid cross-file flakiness in router tests that
    // rely on module-scoped Express apps and hoisted mocks.
    maxWorkers: 1,
    fileParallelism: false,
    teardownTimeout: 60_000,
    hookTimeout: 60_000,
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**'],
    },
  },
});
