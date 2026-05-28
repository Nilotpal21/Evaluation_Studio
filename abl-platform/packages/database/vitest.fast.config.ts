import { mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';
import { databaseInfraDependentSuites } from './vitest.test-groups';

export default mergeConfig(baseConfig, {
  test: {
    exclude: [
      'dist/**',
      'node_modules/**',
      // Keep the PR lane focused on source-only unit behavior. MongoMemoryServer,
      // seeded encryption stacks, and explicit integration/e2e suites move to
      // `pnpm --filter=@agent-platform/database run test:fast:infra`.
      ...databaseInfraDependentSuites,
    ],
  },
});
