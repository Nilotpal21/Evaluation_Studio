import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/__tests__/**/*.live.e2e.test.ts',
      'src/__tests__/traveldesk-supervisor-ws-flow.e2e.test.ts',
      'src/__tests__/integration/afg-blue-advisory/afg-conversational.e2e.test.ts',
    ],
    exclude: ['dist/**', 'node_modules/**'],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
