export const LEGACY_OAUTH2_TOKEN_MIGRATION_STATUS = 'legacy_read_only' as const;

export const LEGACY_OAUTH2_TOKEN_READ_ONLY_MESSAGE =
  'Legacy oauth2_token profiles are migration records and cannot be edited, revoked, deleted, or validated. Re-authorize the linked OAuth app instead.';

export interface AuthProfileMigrationState {
  status: typeof LEGACY_OAUTH2_TOKEN_MIGRATION_STATUS;
  message: string;
  replacementAuthProfileId: string | null;
  replacementAuthType: 'oauth2_app';
}

export function getAuthProfileMigrationState(profile: {
  authType?: string | null;
  linkedAppProfileId?: string | null;
}): AuthProfileMigrationState | null {
  if (profile.authType !== 'oauth2_token') {
    return null;
  }

  const replacementAuthProfileId =
    typeof profile.linkedAppProfileId === 'string' && profile.linkedAppProfileId.trim().length > 0
      ? profile.linkedAppProfileId
      : null;

  return {
    status: LEGACY_OAUTH2_TOKEN_MIGRATION_STATUS,
    message: LEGACY_OAUTH2_TOKEN_READ_ONLY_MESSAGE,
    replacementAuthProfileId,
    replacementAuthType: 'oauth2_app',
  };
}
