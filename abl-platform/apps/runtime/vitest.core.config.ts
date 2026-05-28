import { defineConfig } from 'vitest/config';
import { resolveVitestPathSelection } from './vitest.path-filters';
import { runtimeDefaultTestExcludes, runtimeVitestInclude } from './vitest.shared';

const selection = resolveVitestPathSelection(runtimeVitestInclude, runtimeDefaultTestExcludes);

export default defineConfig({
  test: {
    include: selection.include,
    exclude: selection.exclude,
    pool: 'forks',
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: 2,
  },
});
