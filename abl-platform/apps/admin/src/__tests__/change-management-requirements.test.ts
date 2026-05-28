import { describe, expect, test } from 'vitest';
import { getAdminChangeRequirement } from '../change-management/requirements.js';

describe('getAdminChangeRequirement', () => {
  test('keeps admin in proxy_only mode for phase 1', () => {
    const requirement = getAdminChangeRequirement({
      environment: 'prod',
    });

    expect(requirement).toMatchObject({
      service: 'admin',
      environment: 'prod',
      enforcementMode: 'proxy_only',
      requiredChangeIds: ['seed.platform-core', 'seed.rbac-tool-permissions'],
      optionalChangeIds: [],
    });
  });
});
