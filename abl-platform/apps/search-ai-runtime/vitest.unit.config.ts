/**
 * Vitest unit tier — pure unit tests only, no external service dependencies.
 *
 * Excludes tests requiring: MongoDB, OpenSearch, or external HTTP services.
 *
 * Run with: pnpm test:fast
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      'dist/**',
      'node_modules/**',

      // ── MongoDB-dependent tests (require MongoMemoryServer) ───────────────
      'src/__tests__/capability-service.test.ts',
      'src/__tests__/dynamic-vocabulary-resolver.test.ts',
      'src/db/__tests__/dual-connection.test.ts',
      // Query services OOMs in forked worker - needs separate run with increased heap
      'src/__tests__/query-services.test.ts',

      // ── E2E tests (MongoMemoryServer + real HTTP server + real Express routes) ──
      'src/__tests__/search-ai-runtime.integration.test.ts',

      // Route-level supertest coverage is kept in the full suite/CI path. This
      // file is cheap in isolation but intermittently flakes with socket hang
      // ups under the monorepo fast-test pool.
      'src/routes/__tests__/agent-integration.routes.test.ts',
    ],

    // Keep startup fast with threads, but run files serially. The monorepo
    // turbo test run already parallelizes across packages, and this package's
    // router tests use module-scoped Express apps plus hoisted mocks that are
    // flaky when multiple workers execute them concurrently.
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
