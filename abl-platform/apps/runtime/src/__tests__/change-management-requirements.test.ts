import { describe, expect, test } from 'vitest';
import { getRuntimeChangeRequirement } from '../change-management/requirements.js';

describe('getRuntimeChangeRequirement', () => {
  test('resolves runtime requirements by environment and enforcement mode', () => {
    const requirement = getRuntimeChangeRequirement({
      environment: 'staging',
      enforcementMode: 'hard_fail',
    });

    expect(requirement).toMatchObject({
      service: 'runtime',
      environment: 'staging',
      enforcementMode: 'hard_fail',
      requiredChangeIds: ['seed.platform-core', 'seed.rbac-tool-permissions'],
      optionalChangeIds: [],
    });
  });
});
