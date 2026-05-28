import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Pre-push runs multiple package suites concurrently; admin route tests
    // occasionally exceed 30s under CPU contention even when behavior is correct.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ['./src/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/__tests__/**'],
    },
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
