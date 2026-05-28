import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // *.cluster.test.ts requires the docker-compose harness; runs via the
    // root `pnpm test:cluster` script with `vitest.cluster.config.ts`.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.cluster.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/__tests__/**'],
    },
  },
});
