/**
 * Resolves OAuth2 app credentials (clientId, clientSecret, tokenUrl, etc.)
 * from a linked oauth2_app profile. Used during token refresh and OAuth flows.
 */
import { createLogger } from '@agent-platform/shared-observability';
import { assertUrlSafeForSSRF } from '@agent-platform/shared-kernel';
const log = createLogger('oauth2-app-resolver');

export interface ResolveAppCredentialsParams {
  linkedAppProfileId: string;
  tenantId: string;
  expectedScope?: 'tenant' | 'project';
  expectedVisibility?: 'shared' | 'personal';
  expectedProjectId?: string | null;
  expectedOwnerId?: string;
  // NOTE: The `decryptor` parameter is accepted for backwards compat with callers
  // that pass pre-resolved (non-DB) secrets. For DB-loaded profiles, the encryption
  // plugin auto-decrypts on findOne() so the decryptor is NOT called.
  decryptor?: { decryptForTenant: (data: string) => string };
}

export interface OAuth2AppCredentials {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  refreshUrl?: string;
  revocationUrl?: string;
  authorizationUrl: string;
  defaultScopes: string[];
  pkceRequired: boolean;
  pkceMethod?: 'S256' | 'plain';
  tokenParams?: Record<string, string>;
}

function resolveExpectedProjectId(params: {
  expectedScope?: 'tenant' | 'project';
  expectedProjectId?: string | null;
}): string | null | undefined {
  if (params.expectedScope === 'project') {
    if (typeof params.expectedProjectId !== 'string' || params.expectedProjectId.length === 0) {
      throw new Error('Linked OAuth app profile validation requires a projectId context.');
    }

    return params.expectedProjectId;
  }

  if (params.expectedScope === 'tenant') {
    return params.expectedProjectId ?? null;
  }

  return params.expectedProjectId;
}

function isExpired(expiresAt: unknown): boolean {
  if (!expiresAt) {
    return false;
  }

  const expiresAtMs =
    expiresAt instanceof Date ? expiresAt.getTime() : new Date(String(expiresAt)).getTime();
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

function validateOAuthEndpointUrl(urlValue: unknown, fieldName: string): string {
  if (typeof urlValue !== 'string' || urlValue.length === 0) {
    throw new Error(`OAuth app profile is missing ${fieldName}.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(urlValue);
  } catch (err) {
    throw new Error(`OAuth app profile has an invalid ${fieldName}.`, { cause: err });
  }

  if (
    parsed.protocol !== 'https:' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '127.0.0.1'
  ) {
    throw new Error(`OAuth app profile ${fieldName} must use HTTPS.`);
  }

  assertUrlSafeForSSRF(
    urlValue,
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
      ? { allowLocalhost: true }
      : {},
  );
  return urlValue;
}

export async function resolveOAuth2AppCredentials(
  params: ResolveAppCredentialsParams,
): Promise<OAuth2AppCredentials> {
  const { AuthProfile } = await import('@agent-platform/database/models');
  const expectedProjectId = resolveExpectedProjectId(params);

  const appProfile = await AuthProfile.findOne({
    _id: params.linkedAppProfileId,
    tenantId: params.tenantId,
  });

  if (!appProfile) {
    throw new Error(
      'Linked OAuth app profile not found. It may have been deleted. Reconfigure the OAuth connection.',
    );
  }

  if (appProfile.authType !== 'oauth2_app') {
    throw new Error(`Linked profile has authType '${appProfile.authType}', expected 'oauth2_app'.`);
  }

  if (appProfile.status !== 'active') {
    throw new Error(`Linked OAuth app profile is not active (status: ${appProfile.status}).`);
  }

  if (params.expectedScope && appProfile.scope !== params.expectedScope) {
    throw new Error(`Linked OAuth app profile must use scope '${params.expectedScope}'.`);
  }

  if (params.expectedVisibility && appProfile.visibility !== params.expectedVisibility) {
    throw new Error(`Linked OAuth app profile must use visibility '${params.expectedVisibility}'.`);
  }

  if (expectedProjectId !== undefined) {
    const actualProjectId = appProfile.projectId ?? null;
    if (actualProjectId !== expectedProjectId) {
      throw new Error(
        expectedProjectId
          ? 'Linked OAuth app profile must belong to the same project.'
          : 'Linked OAuth app profile must be workspace-scoped.',
      );
    }
  }

  if (params.expectedOwnerId !== undefined && appProfile.createdBy !== params.expectedOwnerId) {
    throw new Error('Linked OAuth app profile must belong to the same owner.');
  }

  if (isExpired(appProfile.expiresAt)) {
    throw new Error('Linked OAuth app profile has expired. Reconfigure the OAuth connection.');
  }

  // encryptedSecrets is already auto-decrypted by the encryption plugin's
  // post('findOne') hook. Just JSON.parse the plaintext string.
  let secrets: Record<string, unknown>;
  try {
    secrets = JSON.parse(appProfile.encryptedSecrets);
  } catch {
    throw new Error('Failed to parse OAuth app profile secrets — decryption may have failed');
  }

  // Validate required secret fields
  if (typeof secrets.clientId !== 'string' || !secrets.clientId) {
    throw new Error('OAuth app profile missing or invalid clientId in secrets');
  }
  if (typeof secrets.clientSecret !== 'string' || !secrets.clientSecret) {
    throw new Error('OAuth app profile missing or invalid clientSecret in secrets');
  }

  return {
    clientId: secrets.clientId as string,
    clientSecret: secrets.clientSecret as string,
    tokenUrl: validateOAuthEndpointUrl(appProfile.config.tokenUrl, 'tokenUrl'),
    refreshUrl: appProfile.config.refreshUrl
      ? validateOAuthEndpointUrl(appProfile.config.refreshUrl, 'refreshUrl')
      : undefined,
    revocationUrl: appProfile.config.revocationUrl
      ? validateOAuthEndpointUrl(appProfile.config.revocationUrl, 'revocationUrl')
      : undefined,
    authorizationUrl: validateOAuthEndpointUrl(
      appProfile.config.authorizationUrl,
      'authorizationUrl',
    ),
    defaultScopes: (appProfile.config.defaultScopes as string[]) || [],
    pkceRequired: (appProfile.config.pkceRequired as boolean) || false,
    pkceMethod: appProfile.config.pkceMethod as 'S256' | 'plain' | undefined,
    tokenParams:
      appProfile.config.tokenParams && typeof appProfile.config.tokenParams === 'object'
        ? (appProfile.config.tokenParams as Record<string, string>)
        : undefined,
  };
}
