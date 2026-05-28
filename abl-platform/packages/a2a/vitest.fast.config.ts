import { defineConfig } from 'vitest/config';

/**
 * Fast test config — excludes live E2E tests that require a running runtime,
 * pre-seeded DB, and real LLM credentials.
 */
export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**', 'src/__tests__/*e2e*', 'src/**/*.repro.test.ts'],
  },
});
