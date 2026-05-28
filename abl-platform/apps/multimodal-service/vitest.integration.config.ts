import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/__tests__/attachment-routes.test.ts',
      'src/__tests__/attachment-rate-limit.test.ts',
      'src/__tests__/pii-pipeline-integration.test.ts',
    ],
    exclude: ['dist/**', 'node_modules/**'],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
