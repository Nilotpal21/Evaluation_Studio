import { defineConfig } from 'vitest/config';
import path from 'path';
import { studioCoverageConfig } from './vitest.coverage';

/**
 * Node-only Vitest config for API/integration suites that need real servers,
 * sockets, or long-lived resources without happy-dom's forced-exit harness.
 */
process.env.VITEST_WATCHDOG_MS ??= String(5 * 60 * 1000);

export default defineConfig({
  root: __dirname,
  test: {
    include: [
      'src/__tests__/**/*.test.ts',
      'src/store/__tests__/**/*.test.ts',
      'src/**/*.e2e.test.ts',
    ],
    environment: 'node',
    exclude: [
      'dist/**',
      'node_modules/**',
      '.next/**',
      'e2e/**',
      'src/__tests__/arch-ai/**',
      'src/__tests__/components/**',
      'src/__tests__/hooks/**',
      'src/__tests__/search-ai/**',
      'src/__tests__/stores/**',
      'src/__tests__/behavior-section.test.ts',
      'src/__tests__/studio-transport.test.ts',
      'src/components/**/__tests__/**',
      'src/hooks/**/__tests__/**',
      'src/lib/__tests__/**',
    ],
    setupFiles: ['./src/__tests__/setup-node.ts'],
    globalSetup: ['./vitest-force-exit.ts'],
    css: false,
    pool: 'forks',
    hookTimeout: 120_000,
    testTimeout: 120_000,
    teardownTimeout: 10_000,
    coverage: studioCoverageConfig,
  },
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'server-only': path.resolve(__dirname, 'src/__tests__/server-only.stub.ts'),
      '@abl/compiler/platform/logger.js': path.resolve(
        __dirname,
        '../../packages/compiler/src/platform/logger.ts',
      ),
      '@abl/compiler/platform/stores': path.resolve(
        __dirname,
        '../../packages/compiler/src/platform/stores/index.ts',
      ),
      '@abl/compiler/platform': path.resolve(
        __dirname,
        '../../packages/compiler/src/platform/logger.ts',
      ),
      '@agent-platform/arch-ai/system-agent': path.resolve(
        __dirname,
        '../../packages/arch-ai/src/system-agent.ts',
      ),
      '@agent-platform/shared/validation': path.resolve(
        __dirname,
        '../../packages/shared/src/validation/index.ts',
      ),
      '@agent-platform/shared/rbac': path.resolve(
        __dirname,
        '../../packages/shared/src/rbac/index.ts',
      ),
      '@agent-platform/shared/errors': path.resolve(
        __dirname,
        '../../packages/shared/src/errors.ts',
      ),
      '@agent-platform/shared/services/auth-profile': path.resolve(
        __dirname,
        '../../packages/shared/src/services/auth-profile/index.ts',
      ),
      '@agent-platform/shared/security': path.resolve(
        __dirname,
        '../../packages/shared/src/security/index.ts',
      ),
      '@agent-platform/shared': path.resolve(__dirname, 'src/__tests__/_stubs/shared-minimal.ts'),
    },
  },
});
