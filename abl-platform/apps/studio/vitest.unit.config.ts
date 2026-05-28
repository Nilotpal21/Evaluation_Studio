import { defineConfig } from 'vitest/config';
import path from 'path';
import { studioCoverageConfig } from './vitest.coverage';

/**
 * Component test configuration for apps/studio.
 *
 * Covers .test.tsx files and .test.ts files that use React Testing Library
 * (hooks tests). Pure-logic .test.ts files run under vitest.light.config.ts
 * with environment: 'node' for much faster execution.
 *
 * Used by the `test:fast` script in sharded mode.
 * The global setup now acts as a watchdog only; component suites are expected
 * to exit cleanly on their own, and hangs should fail loudly.
 */
export default defineConfig({
  root: __dirname,
  test: {
    // Only include component tests and hook tests that need happy-dom
    include: [
      'src/__tests__/**/*.test.tsx',
      'src/__tests__/hooks/agent-hooks.test.ts',
      'src/__tests__/hooks/agent-ir-hook.test.ts',
      'src/__tests__/behavior-section.test.ts',
      'src/__tests__/hooks/data-hooks.test.ts',
      'src/__tests__/hooks/section-edit-hook.test.ts',
      'src/__tests__/hooks/session-hooks.test.ts',
      'src/__tests__/hooks/**/*.test.ts',
      'src/__tests__/arch-ai/upload-files.test.ts',
      'src/__tests__/studio-transport.test.ts',
      'src/__tests__/template-catalog.test.ts',
    ],
    exclude: [
      'dist/**',
      'node_modules/**',
      '.next/**',
      'e2e/**',
      'src/**/*.repro.test.ts',
      'src/**/*.repro.test.tsx',
      // Dynamic import() inside test blocks hangs under happy-dom forks pool
      'src/__tests__/channel-registry.test.ts',
    ],
    environment: 'happy-dom',
    environmentOptions: {
      // Use a non-connectable URL so happy-dom does not attempt real TCP
      // connections to localhost:3000 during env initialization/teardown.
      // The default http://localhost:3000/ causes ECONNREFUSED unhandled
      // rejections under concurrent Turbo runs, inflating process.exitCode.
      url: 'http://localhost/',
    },
    setupFiles: ['./src/__tests__/setup.tsx'],
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
      '@agent-platform/web-sdk/react': path.resolve(
        __dirname,
        '../../packages/web-sdk/src/react/index.ts',
      ),
      '@agent-platform/web-sdk': path.resolve(__dirname, '../../packages/web-sdk/src/index.ts'),
    },
  },
});
