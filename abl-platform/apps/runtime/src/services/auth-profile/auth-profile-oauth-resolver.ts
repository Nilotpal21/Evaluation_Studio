import { createLogger } from '@abl/compiler/platform';
import type { OAuthProviderConfig } from '../tool-oauth-service.js';
import { resolveByName } from '../auth-profile-resolver.js';
import {
  buildAuthProfileOAuthProviderKey,
  resolveOAuth2AppCredentials,
} from '@agent-platform/shared/services/auth-profile';

const log = createLogger('auth-profile-oauth-resolver');

export const AUTH_PROFILE_OAUTH_PROVIDER_ID = 'auth-profile';

export interface ResolvedAuthProfileOAuthProvider {
  authProfileId: string;
  authProfileRef: string;
  providerKey: string;
  config: OAuthProviderConfig;
}

export interface ResolveAuthProfileOAuthProviderParams {
  tenantId: string;
  authProfileRef: string;
  projectId?: string;
  environment?: string;
  userId?: string;
  scopes?: string[];
  lookupScope?: 'user' | 'tenant';
}

function dedupeScopes(scopes: string[]): string[] {
  return Array.from(
    new Set(scopes.map((scope) => scope.trim()).filter((scope) => scope.length > 0)),
  );
}

export async function resolveAuthProfileOAuthProvider(
  params: ResolveAuthProfileOAuthProviderParams,
): Promise<ResolvedAuthProfileOAuthProvider | null> {
  const profile = await resolveByName(
    params.authProfileRef,
    params.tenantId,
    params.environment,
    params.projectId,
    params.lookupScope === 'tenant' ? undefined : params.userId,
  );

  if (!profile) {
    return null;
  }

  if (profile.authType !== 'oauth2_app') {
    log.debug('Auth profile does not resolve to an oauth2_app', {
      authProfileRef: params.authProfileRef,
      authType: profile.authType,
    });
    return null;
  }

  return resolveAuthProfileOAuthProviderById({
    tenantId: params.tenantId,
    authProfileId: profile.profileId,
    authProfileRef: params.authProfileRef,
    scopes: params.scopes,
  });
}

export async function resolveAuthProfileOAuthProviderById(params: {
  tenantId: string;
  authProfileId: string;
  authProfileRef: string;
  scopes?: string[];
}): Promise<ResolvedAuthProfileOAuthProvider | null> {
  try {
    const oauthCreds = await resolveOAuth2AppCredentials({
      linkedAppProfileId: params.authProfileId,
      tenantId: params.tenantId,
    });

    return {
      authProfileId: params.authProfileId,
      authProfileRef: params.authProfileRef,
      providerKey: buildAuthProfileOAuthProviderKey(params.authProfileId),
      config: {
        clientId: oauthCreds.clientId,
        clientSecret: oauthCreds.clientSecret,
        authorizeUrl: oauthCreds.authorizationUrl,
        tokenUrl: oauthCreds.tokenUrl,
        revokeUrl: oauthCreds.revocationUrl,
        scopes: dedupeScopes([
          ...(oauthCreds.defaultScopes ?? []),
          ...(params.scopes ?? []).filter((scope): scope is string => typeof scope === 'string'),
        ]),
      },
    };
  } catch (error) {
    log.warn('Failed to resolve auth-profile-backed OAuth provider', {
      authProfileId: params.authProfileId,
      authProfileRef: params.authProfileRef,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
