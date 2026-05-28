import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    // *.cluster.test.ts requires the docker-compose harness; runs via the
    // root `pnpm test:cluster` script with `vitest.cluster.config.ts`.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.cluster.test.ts'],
    testTimeout: 10_000,
  },
});
