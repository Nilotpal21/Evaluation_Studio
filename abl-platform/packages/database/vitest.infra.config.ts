import { mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';
import { databaseInfraDependentSuites } from './vitest.test-groups';

export default mergeConfig(baseConfig, {
  test: {
    include: [...databaseInfraDependentSuites],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
