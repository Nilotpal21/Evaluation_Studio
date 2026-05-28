import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default Redis port for Docker dev environment (abl-redis on 6380)
    env: {
      REDIS_PORT: process.env.REDIS_PORT || '6380',
    },
    exclude: [
      'dist/**',
      'node_modules/**',
      // MongoDB integration tests — require MongoMemoryServer binary.
      'src/__tests__/integration/**',
      // E2E tests — require MongoMemoryServer; run via vitest.forks.config.ts.
      'src/__tests__/e2e/**',
    ],
    // Use forked processes for test isolation.
    // Required because mongoose/MongoMemoryServer use module-level singletons
    // that can't be safely shared across test files in the same thread.
    pool: 'forks',
    // The root monorepo test run already fans out packages in parallel. Keep
    // Search AI itself single-worker so its MongoMemoryServer suites don't
    // contend with each other and time out during setup.
    maxWorkers: 1,
    fileParallelism: false,
    // Mongo-backed integration suites and dynamic imports can exceed the
    // default budget under root test load.
    hookTimeout: 60_000,
    testTimeout: 60_000,
    // Transient failures under concurrent load: socket hang up (supertest),
    // import timeouts (dynamic import stalls). Retry twice to absorb them.
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
