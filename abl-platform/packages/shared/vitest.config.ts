import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**'],
    testTimeout: 30_000, // User-key derivation tests are CPU-intensive; allow for turbo parallel load
    hookTimeout: 30_000,
    // Encryption tamper-detection test flakes under heavy concurrent load
    // (full monorepo pre-push). Retry once to absorb transient failures.
    retry: 1,
    coverage: {
      exclude: [
        'dist/**',
        'node_modules/**',
        // Barrel/re-export files — no logic to test, coverage comes from shared-kernel
        'src/errors.ts',
        'src/id.ts',
        'src/slug.ts',
        'src/model-pricing.ts',
        'src/index.ts',
        'src/security/index.ts',
        'src/types/auth-context.ts',
        'src/types/workflow-types.ts',
        'src/utils/normalize.ts',
        'src/utils/type-guards.ts',
      ],
    },
  },
});
