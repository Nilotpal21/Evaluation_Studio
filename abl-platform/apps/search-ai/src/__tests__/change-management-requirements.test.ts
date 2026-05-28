import { describe, expect, test } from 'vitest';
import { getSearchAiChangeRequirement } from '../change-management/requirements.js';

describe('getSearchAiChangeRequirement', () => {
  test('resolves search-ai requirements by environment and enforcement mode', () => {
    const requirement = getSearchAiChangeRequirement({
      environment: 'prod',
      enforcementMode: 'warn_only',
    });

    expect(requirement).toMatchObject({
      service: 'search-ai',
      environment: 'prod',
      enforcementMode: 'warn_only',
      requiredChangeIds: ['seed.platform-core'],
      optionalChangeIds: [],
    });
  });
});
