import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // *.cluster.test.ts runs via root `pnpm test:cluster` with the docker
    // harness — exclude from regular runs.
    exclude: ['dist/**', 'node_modules/**', '**/*.cluster.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/__tests__/**'],
    },
  },
});
