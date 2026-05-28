export const AUTH_PROFILE_OAUTH_PROVIDER_PREFIX = 'auth-profile:' as const;

export function buildAuthProfileOAuthProviderKey(authProfileId: string): string {
  return `${AUTH_PROFILE_OAUTH_PROVIDER_PREFIX}${authProfileId}`;
}

export function parseAuthProfileOAuthProviderKey(provider: string): string | undefined {
  if (!provider.startsWith(AUTH_PROFILE_OAUTH_PROVIDER_PREFIX)) {
    return undefined;
  }

  const authProfileId = provider.slice(AUTH_PROFILE_OAUTH_PROVIDER_PREFIX.length).trim();
  return authProfileId.length > 0 ? authProfileId : undefined;
}
