import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
    include: ['src/__tests__/system-*.test.ts'],
  },
});
