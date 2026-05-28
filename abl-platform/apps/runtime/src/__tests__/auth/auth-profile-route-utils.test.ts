import { describe, expect, it } from 'vitest';
import { buildAuthProfileConsumerDependencyFilter } from '../../routes/auth-profile-route-utils.js';

describe('buildAuthProfileConsumerDependencyFilter', () => {
  it('includes tenantId for tenant-scoped consumer models', () => {
    expect(
      buildAuthProfileConsumerDependencyFilter({
        type: 'ConnectorConfig',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
      }),
    ).toEqual({
      authProfileId: 'profile-1',
      tenantId: 'tenant-1',
    });
  });

  it('omits tenantId for ServiceNode consumers', () => {
    expect(
      buildAuthProfileConsumerDependencyFilter({
        type: 'ServiceNode',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
      }),
    ).toEqual({
      authProfileId: 'profile-1',
    });
  });

  it('preserves alternate fields and extra filters', () => {
    expect(
      buildAuthProfileConsumerDependencyFilter({
        type: 'AuthProfile',
        field: 'linkedAppProfileId',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        filter: { status: 'active' },
      }),
    ).toEqual({
      linkedAppProfileId: 'profile-1',
      tenantId: 'tenant-1',
      status: 'active',
    });
  });
});
