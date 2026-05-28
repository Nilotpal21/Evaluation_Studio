import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.e2e.test.ts', '__tests__/**/*.e2e.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
