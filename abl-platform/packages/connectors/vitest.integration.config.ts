import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000, // Integration tests need more time
    include: ['src/__tests__/integration/**/*.test.ts'],
    pool: 'forks', // MongoMemoryServer requires process isolation
    maxWorkers: 2, // Limit concurrency — too many MongoMemoryServer instances exhaust resources
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
  },
});
