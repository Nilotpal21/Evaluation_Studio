import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // E2E tests use mongodb-memory-server: no parallel to avoid binary download races
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
