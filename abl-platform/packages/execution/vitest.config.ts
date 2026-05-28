import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    pool: 'forks',
    testTimeout: 10_000,
    // *.cluster.test.ts runs via root `pnpm test:cluster` with the docker
    // harness — exclude from regular runs.
    exclude: ['dist/**', 'node_modules/**', '.worktrees/**', '**/*.cluster.test.ts'],
  },
});
