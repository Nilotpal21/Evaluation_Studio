import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      'dist/**',
      'node_modules/**',
      // ClamAV stub contract test uses raw TCP with tight timeouts — flaky in
      // CI where port binding and socket I/O are slower.  Run locally via:
      //   pnpm --filter @agent-platform/multimodal-service exec vitest run src/__tests__/external-services-contract.test.ts
      'src/__tests__/external-services-contract.test.ts',
    ],
    // Use forked processes for test isolation.
    // Required because mongoose/MongoMemoryServer use module-level singletons
    // that can't be safely shared across test files in the same thread.
    pool: 'forks',
    // The full monorepo test run already executes many packages in parallel.
    // Keep this package to a single worker and disable file parallelism so its
    // module-heavy suites and Express/Supertest tests do not fight each other
    // for CPU and ports while the machine is saturated.
    maxWorkers: 1,
    fileParallelism: false,
    // Full-suite tests exercise real MongoMemoryServer plus Sharp/FFmpeg-adjacent
    // integration paths. Under the full monorepo run, 30s is occasionally too
    // tight once other packages are saturating CPU and I/O.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**'],
    },
  },
});
