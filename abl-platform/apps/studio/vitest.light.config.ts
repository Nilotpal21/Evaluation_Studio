import { defineConfig } from 'vitest/config';
import path from 'path';
import { studioCoverageConfig } from './vitest.coverage';

/**
 * Lightweight vitest config for pure-logic unit tests (.test.ts files that do
 * NOT use React Testing Library or happy-dom).
 *
 * Runs under environment: 'node' with a minimal setup file.  This avoids the
 * heavy mocking (lucide-react proxy, next-intl ICU, framer-motion, happy-dom)
 * that causes OOM and open-handle hangs in the full config.
 *
 * Keep the fast lane focused on cheap contract and unit coverage.
 * The full Studio round-trip/project IO integration tests still run under
 * `pnpm --filter=@agent-platform/studio test` / `test:full` in CI.
 */
export default defineConfig({
  root: __dirname,
  test: {
    // Include .test.ts files (not .test.tsx) — exclude e2e which needs real infra
    include: ['src/__tests__/**/*.test.ts'],
    exclude: [
      'dist/**',
      'node_modules/**',
      '.next/**',
      'e2e/**',
      'src/**/*.repro.test.ts',
      'src/**/*.repro.test.tsx',
      // E2E tests need real infra (MongoDB, Express servers)
      'src/__tests__/e2e/**',
      'src/__tests__/**/*.e2e.test.ts',
      // Hook tests run under vitest.unit.config.ts with happy-dom
      'src/__tests__/hooks/**/*.test.ts',
      // These .test.ts files use React Testing Library and need happy-dom
      'src/__tests__/behavior-section.test.ts',
      // Uses FileReader and browser FormData semantics during upload parsing
      'src/__tests__/arch-ai/upload-files.test.ts',
      // Uses renderHook from @testing-library/react which needs happy-dom
      'src/__tests__/studio-transport.test.ts',
      // Imports browser-only web-sdk UI pieces that touch HTMLElement
      'src/__tests__/template-catalog.test.ts',
      // Full export→preview→apply→re-export project I/O round-trip. Valuable, but
      // too expensive for the local fast lane and still covered by the full suite.
      'src/__tests__/api-routes/api-project-io-roundtrip.test.ts',
      // Dynamic import() hangs under forks pool
      'src/__tests__/channel-registry.test.ts',
      // Uses renderHook from @testing-library/react which requires a DOM (happy-dom)
      'src/__tests__/hooks/use-multi-page-progress.test.ts',
    ],
    environment: 'node',
    setupFiles: ['./src/__tests__/setup-light.ts'],
    globalSetup: ['./vitest-force-exit.ts'],
    css: false,
    pool: 'forks',
    hookTimeout: 30_000,
    testTimeout: 30_000,
    teardownTimeout: 3_000,
    coverage: studioCoverageConfig,
  },
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'server-only': path.resolve(__dirname, 'src/__tests__/server-only.stub.ts'),
    },
  },
});
