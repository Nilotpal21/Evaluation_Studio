import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    include: ['src/**/*.repro.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
