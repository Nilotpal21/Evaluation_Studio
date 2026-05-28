import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/integration/**/*.test.ts', 'src/__tests__/**/*.integration.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
