import { defineConfig } from 'vitest/config';

/**
 * shared-kernel vitest config.
 *
 * Explicitly excludes `dist/` so the architecture-fitness suite does not
 * double-run from compiled `.test.js` shadows alongside the `.test.ts`
 * sources. Vitest's default exclude includes `**\/dist/**`, but shared-kernel's
 * `tsc -b` emits test files to `dist/__tests__/` because `tsconfig.json`
 * includes `src/**\/*.ts`. Picking up the compiled shadows doubles every
 * filesystem-walking fitness test and pushes them past the default 5s
 * `testTimeout`. Per-package config applied here keeps the fix local.
 */
export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
    ],
    // Architecture fitness tests walk the entire packages/ tree; default 5s
    // is too aggressive on cold filesystems (e.g. fresh worktrees).
    testTimeout: 60_000,
  },
});
