import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // Run test files sequentially to avoid mongodb-memory-server
    // binary download race conditions (multiple files starting
    // MongoMemoryServer.create() concurrently causes lockfile contention)
    fileParallelism: false,
    // Cold CI runners may need extra time to download the MongoDB binary once.
    hookTimeout: 120000,
    testTimeout: 120000,
  },
});
