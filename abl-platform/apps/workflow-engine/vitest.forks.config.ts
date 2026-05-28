/**
 * Vitest FORKS tier — tests that exercise isolated-vm and need process
 * isolation under Linux/Node 24.
 *
 * These files are excluded from the shared-cache threads pool because the
 * native isolated-vm runtime can abort when executed inside Vitest worker
 * threads under CI load.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/__tests__/function-executor.test.ts',
      'src/__tests__/step-dispatcher.test.ts',
      'src/__tests__/e2e-basic.test.ts',
    ],
    exclude: ['dist/**', 'node_modules/**'],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
