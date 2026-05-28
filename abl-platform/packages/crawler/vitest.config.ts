import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      'dist/**',
      'node_modules/**',
      // Integration tests make real HTTP calls to external sites.
      // Run separately via `pnpm test:integration` — not in CI.
      'src/__tests__/integration/**',
      // B3: Catch integration tests anywhere in the test tree (e.g., intelligence/)
      '**/*.integration.test.ts',
    ],
    testTimeout: 10_000,
    // Use forks pool — vitest v4 threads pool doesn't inherit env vars
    // (OPENAI_API_KEY, etc. needed for intelligence POC tests)
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/__tests__/**'],
    },
  },
});
