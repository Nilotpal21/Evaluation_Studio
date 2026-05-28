import { describe, expect, it } from 'vitest';

import {
  getAuthProfileMigrationState,
  LEGACY_OAUTH2_TOKEN_READ_ONLY_MESSAGE,
} from '../legacy-auth-profile.js';

describe('getAuthProfileMigrationState', () => {
  it('returns migration metadata for legacy oauth2_token profiles', () => {
    expect(
      getAuthProfileMigrationState({
        authType: 'oauth2_token',
        linkedAppProfileId: 'app-profile-1',
      }),
    ).toEqual({
      status: 'legacy_read_only',
      message: LEGACY_OAUTH2_TOKEN_READ_ONLY_MESSAGE,
      replacementAuthProfileId: 'app-profile-1',
      replacementAuthType: 'oauth2_app',
    });
  });

  it('returns null for active-contract auth profiles', () => {
    expect(
      getAuthProfileMigrationState({
        authType: 'oauth2_app',
        linkedAppProfileId: 'app-profile-1',
      }),
    ).toBeNull();
  });
});
