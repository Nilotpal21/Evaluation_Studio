/**
 * Token Refresh Service
 *
 * Handles proactive and reactive OAuth2 token refresh with distributed locking.
 * Uses native fetch() for all token exchanges (NOT simple-oauth2).
 */
import { createLogger } from '@agent-platform/shared-observability';
import { assertUrlSafeForSSRF } from '@agent-platform/shared-kernel';
import type { RedisClient } from '@agent-platform/redis';
import { emitAuthProfileTraceEvent, AUTH_PROFILE_TRACE_EVENTS } from './trace-events.js';
import { buildAuthProfileOAuthProviderKey } from './oauth-provider-key.js';
import type { OAuth2AppCredentials, ResolveAppCredentialsParams } from './oauth2-app-resolver.js';

const log = createLogger('token-refresh-service');

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry
const CONCURRENT_REFRESH_POLL_MS = 100;
const CONCURRENT_REFRESH_WAIT_MS = 2_000;
const TENANT_SHARED_OAUTH_GRANT_USER_ID = '__tenant__';

export interface RefreshTokenParams {
  profileId: string;
  tenantId: string;
  authScope?: 'session' | 'user' | 'tenant';
  userId?: string;
  connectionMode?: 'shared' | 'per_user';
  projectId?: string;
  sessionPrincipal?: string;
  redis?: RedisClient;
}

export interface RefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  refreshed: boolean;
}

export interface RefreshableAuthProfile {
  _id?: string;
  authType?: string;
  linkedAppProfileId?: string;
  scope?: 'tenant' | 'project';
  visibility?: 'shared' | 'personal';
  projectId?: string | null;
  createdBy?: string;
  encryptedSecrets: string;
  config?: Record<string, unknown>;
  updatedAt?: Date | string;
  save: () => Promise<void>;
}

export interface RefreshableDurableGrant {
  encryptedAccessToken?: string | null;
  encryptedRefreshToken?: string | null;
  scope?: string | null;
  expiresAt?: Date | string | null;
  refreshedAt?: Date | string | null;
  updatedAt?: Date | string;
  save: () => Promise<void>;
}

export interface RefreshableSessionOAuthArtifact extends RefreshableDurableGrant {
  projectId?: string;
  sessionPrincipal?: string;
  sessionId?: string | null;
  runtimeSessionId?: string | null;
  sessionExpiresAt?: Date | string | null;
}

interface RefreshTargetDescriptor {
  lockResourceId: string;
  loadState: () => Promise<LoadedRefreshState>;
}

interface LoadedRefreshState {
  revision: string;
  refreshToken: string;
  resolveAppCredentialsParams: ResolveAppCredentialsParams;
  parseStoredTokens: () => Omit<RefreshResult, 'refreshed'>;
  persistTokens: (tokens: ReturnType<typeof parseRefreshTokenResponse>) => Promise<void>;
}

function parseRefreshTokenResponse(payload: unknown): {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
} {
  if (typeof payload !== 'object' || payload == null) {
    throw new Error('Token refresh returned an invalid token payload');
  }

  const {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    scope,
  } = payload as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };

  if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    throw new Error('Token refresh returned an invalid access_token');
  }

  if (refreshToken !== undefined && refreshToken !== null && typeof refreshToken !== 'string') {
    throw new Error('Token refresh returned an invalid refresh_token');
  }

  if (expiresIn !== undefined) {
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error('Token refresh returned an invalid expires_in value');
    }
  }

  if (scope !== undefined && scope !== null && typeof scope !== 'string') {
    throw new Error('Token refresh returned an invalid scope value');
  }

  return {
    accessToken,
    refreshToken:
      typeof refreshToken === 'string' && refreshToken.length > 0 ? refreshToken : undefined,
    expiresIn: typeof expiresIn === 'number' ? expiresIn : undefined,
    scope: typeof scope === 'string' && scope.trim().length > 0 ? scope.trim() : undefined,
  };
}

function normalizeScopeValue(scopeValue: string | null | undefined): string | undefined {
  if (typeof scopeValue !== 'string') {
    return undefined;
  }

  const normalized = scopeValue
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);

  return normalized.length > 0 ? normalized.join(' ') : undefined;
}

function parseProfileGrantedScope(config?: Record<string, unknown>): string | undefined {
  if (!config) {
    return undefined;
  }

  const grantedScopes = Array.isArray(config.grantedScopes)
    ? config.grantedScopes
        .filter((scope): scope is string => typeof scope === 'string')
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0)
    : [];

  if (grantedScopes.length > 0) {
    return grantedScopes.join(' ');
  }

  const configuredScopes = Array.isArray(config.scopes)
    ? config.scopes
        .filter((scope): scope is string => typeof scope === 'string')
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0)
    : [];

  return configuredScopes.length > 0 ? configuredScopes.join(' ') : undefined;
}

function buildProfileRevision(profile: RefreshableAuthProfile): string {
  const updatedAtMs =
    profile.updatedAt instanceof Date
      ? profile.updatedAt.getTime()
      : profile.updatedAt
        ? new Date(String(profile.updatedAt)).getTime()
        : 0;
  const expiresAt =
    profile.config && typeof profile.config.expiresAt === 'string' ? profile.config.expiresAt : '';
  const grantedScope = parseProfileGrantedScope(profile.config) ?? '';
  return `${updatedAtMs}:${profile.encryptedSecrets}:${expiresAt}:${grantedScope}`;
}

function toEpochMs(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (!value) {
    return 0;
  }

  return new Date(String(value)).getTime();
}

function buildGrantRevision(grant: RefreshableDurableGrant): string {
  return `${toEpochMs(grant.updatedAt)}:${toEpochMs(grant.refreshedAt)}:${toEpochMs(grant.expiresAt)}:${grant.encryptedAccessToken ?? ''}:${grant.encryptedRefreshToken ?? ''}:${normalizeScopeValue(grant.scope) ?? ''}`;
}

function resolveStoredSessionId(artifact: RefreshableSessionOAuthArtifact): string | undefined {
  if (typeof artifact.sessionId === 'string' && artifact.sessionId.trim().length > 0) {
    return artifact.sessionId.trim();
  }

  if (
    typeof artifact.runtimeSessionId === 'string' &&
    artifact.runtimeSessionId.trim().length > 0
  ) {
    return artifact.runtimeSessionId.trim();
  }

  return undefined;
}

function buildSessionArtifactRevision(artifact: RefreshableSessionOAuthArtifact): string {
  return `${buildGrantRevision(artifact)}:${toEpochMs(artifact.sessionExpiresAt)}:${resolveStoredSessionId(artifact) ?? ''}`;
}

function parseStoredTokens(profile: RefreshableAuthProfile): Omit<RefreshResult, 'refreshed'> {
  let secrets: Record<string, unknown>;
  try {
    secrets = JSON.parse(profile.encryptedSecrets);
  } catch {
    throw new Error(
      'Failed to parse refreshed secrets from concurrent refresh — encryption may have failed',
    );
  }

  if (typeof secrets.accessToken !== 'string') {
    throw new Error('Refreshed profile has invalid accessToken');
  }

  return {
    accessToken: secrets.accessToken,
    refreshToken: typeof secrets.refreshToken === 'string' ? secrets.refreshToken : undefined,
    expiresAt:
      profile.config && typeof profile.config.expiresAt === 'string'
        ? profile.config.expiresAt
        : undefined,
    scope: parseProfileGrantedScope(profile.config),
  };
}

function parseStoredGrantTokens(grant: RefreshableDurableGrant): Omit<RefreshResult, 'refreshed'> {
  if (typeof grant.encryptedAccessToken !== 'string') {
    throw new Error('Refreshed OAuth grant has invalid access token');
  }

  return {
    accessToken: grant.encryptedAccessToken,
    refreshToken:
      typeof grant.encryptedRefreshToken === 'string' ? grant.encryptedRefreshToken : undefined,
    expiresAt:
      grant.expiresAt instanceof Date
        ? grant.expiresAt.toISOString()
        : typeof grant.expiresAt === 'string'
          ? grant.expiresAt
          : undefined,
    scope: normalizeScopeValue(grant.scope),
  };
}

function getGrantPrincipalId(
  profile: Pick<RefreshableAuthProfile, '_id' | 'visibility' | 'createdBy'>,
  params: Pick<RefreshTokenParams, 'profileId' | 'userId' | 'connectionMode'>,
): string {
  if (typeof params.userId === 'string' && params.userId.trim().length > 0) {
    return params.userId.trim();
  }

  if (params.connectionMode === 'per_user' || profile.visibility === 'personal') {
    if (typeof profile.createdBy === 'string' && profile.createdBy.trim().length > 0) {
      return profile.createdBy.trim();
    }

    throw new Error(
      `Per-user OAuth app refresh for profile ${params.profileId} requires an owning user.`,
    );
  }

  return TENANT_SHARED_OAUTH_GRANT_USER_ID;
}

function getSessionArtifactProjectId(
  params: Pick<RefreshTokenParams, 'profileId' | 'projectId'>,
): string {
  if (typeof params.projectId === 'string' && params.projectId.trim().length > 0) {
    return params.projectId.trim();
  }

  throw new Error(
    `Session-scoped OAuth refresh for profile ${params.profileId} requires projectId.`,
  );
}

function getSessionArtifactPrincipalId(
  params: Pick<RefreshTokenParams, 'profileId' | 'sessionPrincipal' | 'userId'>,
): string {
  if (typeof params.sessionPrincipal === 'string' && params.sessionPrincipal.trim().length > 0) {
    return params.sessionPrincipal.trim();
  }

  if (typeof params.userId === 'string' && params.userId.trim().length > 0) {
    return params.userId.trim();
  }

  throw new Error(
    `Session-scoped OAuth refresh for profile ${params.profileId} requires sessionPrincipal.`,
  );
}

function buildLegacyRefreshAppParams(
  profile: RefreshableAuthProfile,
  params: Pick<RefreshTokenParams, 'tenantId'>,
): ResolveAppCredentialsParams {
  if (!profile.linkedAppProfileId) {
    throw new Error('Token profile has no linkedAppProfileId — cannot resolve app credentials');
  }

  if (profile.authType !== 'oauth2_token') {
    throw new Error(`Token profile ${String(profile._id ?? 'unknown')} is not oauth2_token`);
  }

  if (profile.scope !== 'tenant' && profile.scope !== 'project') {
    throw new Error(`Token profile ${String(profile._id ?? 'unknown')} has invalid scope`);
  }

  if (profile.visibility !== 'shared' && profile.visibility !== 'personal') {
    throw new Error(`Token profile ${String(profile._id ?? 'unknown')} has invalid visibility`);
  }

  if (profile.visibility === 'personal' && !profile.createdBy) {
    throw new Error(`Token profile ${String(profile._id ?? 'unknown')} is missing createdBy`);
  }

  return {
    linkedAppProfileId: profile.linkedAppProfileId,
    tenantId: params.tenantId,
    expectedScope: profile.scope,
    expectedVisibility: profile.visibility,
    expectedProjectId: profile.projectId === undefined ? undefined : (profile.projectId ?? null),
    expectedOwnerId: profile.visibility === 'personal' ? profile.createdBy : undefined,
  };
}

function buildAppProfileRefreshParams(
  profile: RefreshableAuthProfile,
  params: Pick<RefreshTokenParams, 'tenantId'>,
): ResolveAppCredentialsParams {
  if (profile.authType !== 'oauth2_app') {
    throw new Error(`Profile ${String(profile._id ?? 'unknown')} is not oauth2_app`);
  }

  if (profile.scope !== 'tenant' && profile.scope !== 'project') {
    throw new Error(`OAuth app profile ${String(profile._id ?? 'unknown')} has invalid scope`);
  }

  if (profile.visibility !== 'shared' && profile.visibility !== 'personal') {
    throw new Error(`OAuth app profile ${String(profile._id ?? 'unknown')} has invalid visibility`);
  }

  if (typeof profile._id !== 'string' || profile._id.length === 0) {
    throw new Error('OAuth app profile is missing an _id and cannot be refreshed');
  }

  return {
    linkedAppProfileId: profile._id,
    tenantId: params.tenantId,
    expectedScope: profile.scope,
    expectedVisibility: profile.visibility,
    expectedProjectId: profile.projectId === undefined ? undefined : (profile.projectId ?? null),
    expectedOwnerId: profile.visibility === 'personal' ? profile.createdBy : undefined,
  };
}

function validateRefreshEndpoint(urlValue: string): string {
  let parsed: URL;
  try {
    parsed = new URL(urlValue);
  } catch (err) {
    throw new Error(`OAuth refresh endpoint is invalid: ${urlValue}`, { cause: err });
  }

  if (
    parsed.protocol !== 'https:' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '127.0.0.1'
  ) {
    throw new Error(`OAuth refresh endpoint must use HTTPS: ${urlValue}`);
  }

  assertUrlSafeForSSRF(
    urlValue,
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
      ? { allowLocalhost: true }
      : {},
  );
  return urlValue;
}

async function waitForConcurrentRefresh(
  loadState: () => Promise<LoadedRefreshState>,
  baselineRevision: string,
): Promise<LoadedRefreshState> {
  const deadline = Date.now() + CONCURRENT_REFRESH_WAIT_MS;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, CONCURRENT_REFRESH_POLL_MS));
    const freshState = await loadState();
    if (freshState.revision !== baselineRevision) {
      return freshState;
    }
  }

  throw new Error('Concurrent token refresh did not finish before timeout. Retry the request.');
}

async function loadLegacyTokenRefreshState(
  AuthProfile: {
    findOne: (filter: Record<string, unknown>) => Promise<RefreshableAuthProfile | null>;
  },
  params: Pick<RefreshTokenParams, 'profileId' | 'tenantId'>,
): Promise<LoadedRefreshState> {
  const profile = await AuthProfile.findOne({
    _id: params.profileId,
    tenantId: params.tenantId,
  });

  if (!profile) {
    throw new Error(`Token profile ${params.profileId} not found`);
  }

  let secrets: Record<string, unknown>;
  try {
    secrets = JSON.parse(profile.encryptedSecrets);
  } catch {
    throw new Error('Failed to parse encrypted secrets for token refresh');
  }

  if (typeof secrets.refreshToken !== 'string' || !secrets.refreshToken) {
    throw new Error('No refresh token available — cannot refresh');
  }

  return {
    revision: buildProfileRevision(profile),
    refreshToken: secrets.refreshToken,
    resolveAppCredentialsParams: buildLegacyRefreshAppParams(profile, params),
    parseStoredTokens: () => parseStoredTokens(profile),
    persistTokens: async (tokens) => {
      profile.encryptedSecrets = JSON.stringify({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken || secrets.refreshToken,
      });

      const normalizedScope = normalizeScopeValue(tokens.scope);
      if (tokens.expiresIn || normalizedScope) {
        profile.config = {
          ...profile.config,
          ...(tokens.expiresIn
            ? {
                issuedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
              }
            : {}),
          ...(normalizedScope ? { grantedScopes: normalizedScope.split(' ') } : {}),
        };
      }

      await profile.save();
    },
  };
}

async function loadDurableGrantRefreshState(
  EndUserOAuthToken: {
    findOne: (filter: Record<string, unknown>) => Promise<RefreshableDurableGrant | null>;
  },
  params: Pick<RefreshTokenParams, 'profileId' | 'tenantId'>,
  authProfile: RefreshableAuthProfile,
  grantUserId: string,
): Promise<LoadedRefreshState> {
  const provider = buildAuthProfileOAuthProviderKey(params.profileId);
  const grant = await EndUserOAuthToken.findOne({
    tenantId: params.tenantId,
    userId: grantUserId,
    provider,
    revokedAt: null,
  });

  if (!grant) {
    throw new Error(
      `OAuth grant for profile ${params.profileId} and principal ${grantUserId} not found`,
    );
  }

  if (typeof grant.encryptedRefreshToken !== 'string' || !grant.encryptedRefreshToken) {
    throw new Error('No refresh token available — cannot refresh');
  }

  return {
    revision: buildGrantRevision(grant),
    refreshToken: grant.encryptedRefreshToken,
    resolveAppCredentialsParams: buildAppProfileRefreshParams(authProfile, params),
    parseStoredTokens: () => parseStoredGrantTokens(grant),
    persistTokens: async (tokens) => {
      grant.encryptedAccessToken = tokens.accessToken;
      grant.encryptedRefreshToken = tokens.refreshToken || grant.encryptedRefreshToken;
      grant.scope = normalizeScopeValue(tokens.scope) ?? grant.scope;
      if (tokens.expiresIn) {
        grant.expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);
      }
      grant.refreshedAt = new Date();
      await grant.save();
    },
  };
}

async function loadSessionArtifactRefreshState(
  SessionOAuthArtifact: {
    findOne: (filter: Record<string, unknown>) => Promise<RefreshableSessionOAuthArtifact | null>;
  },
  params: Pick<RefreshTokenParams, 'profileId' | 'tenantId'>,
  authProfile: RefreshableAuthProfile,
  projectId: string,
  sessionPrincipal: string,
): Promise<LoadedRefreshState> {
  const provider = buildAuthProfileOAuthProviderKey(params.profileId);
  const artifact = await SessionOAuthArtifact.findOne({
    tenantId: params.tenantId,
    projectId,
    sessionPrincipal,
    provider,
  });

  if (!artifact) {
    throw new Error(
      `Session OAuth artifact for profile ${params.profileId} and session principal ${sessionPrincipal} not found`,
    );
  }

  if (typeof artifact.encryptedRefreshToken !== 'string' || !artifact.encryptedRefreshToken) {
    throw new Error('No refresh token available — cannot refresh');
  }

  const sessionId = resolveStoredSessionId(artifact);
  if (!sessionId) {
    throw new Error(
      `Session OAuth artifact for profile ${params.profileId} is missing sessionId metadata`,
    );
  }

  const sessionExpiresAtMs = toEpochMs(artifact.sessionExpiresAt);
  if (!Number.isFinite(sessionExpiresAtMs)) {
    throw new Error(
      `Session OAuth artifact for profile ${params.profileId} is missing session expiry metadata`,
    );
  }

  if (sessionExpiresAtMs <= Date.now()) {
    throw new Error(`Session OAuth artifact for profile ${params.profileId} has expired`);
  }

  return {
    revision: buildSessionArtifactRevision(artifact),
    refreshToken: artifact.encryptedRefreshToken,
    resolveAppCredentialsParams: buildAppProfileRefreshParams(authProfile, params),
    parseStoredTokens: () => parseStoredGrantTokens(artifact),
    persistTokens: async (tokens) => {
      artifact.encryptedAccessToken = tokens.accessToken;
      artifact.encryptedRefreshToken = tokens.refreshToken || artifact.encryptedRefreshToken;
      artifact.scope = normalizeScopeValue(tokens.scope) ?? artifact.scope;
      if (tokens.expiresIn) {
        artifact.expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);
      }
      artifact.refreshedAt = new Date();
      await artifact.save();
    },
  };
}

async function loadRefreshTargetDescriptor(
  params: Pick<
    RefreshTokenParams,
    | 'profileId'
    | 'tenantId'
    | 'authScope'
    | 'userId'
    | 'connectionMode'
    | 'projectId'
    | 'sessionPrincipal'
  >,
  deps: {
    AuthProfile: {
      findOne: (filter: Record<string, unknown>) => Promise<RefreshableAuthProfile | null>;
    };
    EndUserOAuthToken: {
      findOne: (filter: Record<string, unknown>) => Promise<RefreshableDurableGrant | null>;
    };
    SessionOAuthArtifact: {
      findOne: (filter: Record<string, unknown>) => Promise<RefreshableSessionOAuthArtifact | null>;
    };
  },
): Promise<RefreshTargetDescriptor> {
  const authProfile = await deps.AuthProfile.findOne({
    _id: params.profileId,
    tenantId: params.tenantId,
  });

  if (!authProfile) {
    throw new Error(`Token profile ${params.profileId} not found`);
  }

  if (authProfile.authType === 'oauth2_token') {
    return {
      lockResourceId: params.profileId,
      loadState: () => loadLegacyTokenRefreshState(deps.AuthProfile, params),
    };
  }

  if (authProfile.authType === 'oauth2_app') {
    if (params.authScope === 'session') {
      const projectId = getSessionArtifactProjectId(params);
      const sessionPrincipal = getSessionArtifactPrincipalId(params);

      return {
        lockResourceId: `${params.profileId}:${projectId}:${sessionPrincipal}`,
        loadState: () =>
          loadSessionArtifactRefreshState(
            deps.SessionOAuthArtifact,
            params,
            authProfile,
            projectId,
            sessionPrincipal,
          ),
      };
    }

    const grantUserId = getGrantPrincipalId(authProfile, params);
    return {
      lockResourceId: `${params.profileId}:${grantUserId}`,
      loadState: () =>
        loadDurableGrantRefreshState(deps.EndUserOAuthToken, params, authProfile, grantUserId),
    };
  }

  throw new Error(
    `Profile ${params.profileId} is not refreshable (authType: ${authProfile.authType ?? 'unknown'})`,
  );
}

export interface RefreshTokenDeps {
  AuthProfile: {
    findOne: (filter: Record<string, unknown>) => Promise<RefreshableAuthProfile | null>;
  };
  EndUserOAuthToken: {
    findOne: (filter: Record<string, unknown>) => Promise<RefreshableDurableGrant | null>;
  };
  SessionOAuthArtifact: {
    findOne: (filter: Record<string, unknown>) => Promise<RefreshableSessionOAuthArtifact | null>;
  };
  resolveOAuth2AppCredentials: (
    params: ResolveAppCredentialsParams,
  ) => Promise<OAuth2AppCredentials>;
  acquireRefreshLock: (
    lockResourceId: string,
    tenantId: string,
    deps: { redis: NonNullable<RefreshTokenParams['redis']> },
  ) => Promise<{ acquired: boolean; release: () => Promise<void> }>;
}

/**
 * Check if a token needs proactive refresh (approaching expiry).
 */
export function needsProactiveRefresh(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return false;
  const expiryMs = new Date(expiresAt).getTime();
  return Date.now() > expiryMs - REFRESH_BUFFER_MS;
}

/**
 * Refresh an OAuth2 token using the refresh_token grant.
 * Uses distributed Redis lock to prevent concurrent refresh from multiple pods.
 */
export async function refreshOAuth2Token(
  params: RefreshTokenParams,
  _deps?: Partial<RefreshTokenDeps>,
): Promise<RefreshResult> {
  emitAuthProfileTraceEvent({
    eventType: AUTH_PROFILE_TRACE_EVENTS.REFRESH_START,
    profileId: params.profileId,
    tenantId: params.tenantId,
    timestamp: new Date().toISOString(),
  });

  const models =
    _deps?.AuthProfile != null
      ? {
          AuthProfile: _deps.AuthProfile,
          EndUserOAuthToken: _deps.EndUserOAuthToken!,
          SessionOAuthArtifact: _deps.SessionOAuthArtifact!,
        }
      : await import('@agent-platform/database/models');

  const resolveOAuth2AppCredentials =
    _deps?.resolveOAuth2AppCredentials ??
    (await import('./oauth2-app-resolver.js')).resolveOAuth2AppCredentials;

  const refreshTarget = await loadRefreshTargetDescriptor(params, {
    AuthProfile: models.AuthProfile,
    EndUserOAuthToken: models.EndUserOAuthToken,
    SessionOAuthArtifact: models.SessionOAuthArtifact,
  });

  // Acquire distributed lock if Redis is available
  let lock: { acquired: boolean; release: () => Promise<void> } | undefined;
  if (params.redis) {
    const acquireRefreshLock =
      _deps?.acquireRefreshLock ?? (await import('./refresh-lock.js')).acquireRefreshLock;
    lock = await acquireRefreshLock(refreshTarget.lockResourceId, params.tenantId, {
      redis: params.redis,
    });
    if (!lock.acquired) {
      log.info('Token refresh skipped — another pod holds the lock', {
        profileId: params.profileId,
        lockResourceId: refreshTarget.lockResourceId,
      });
      const baselineState = await refreshTarget.loadState();
      const freshState = await waitForConcurrentRefresh(
        refreshTarget.loadState,
        baselineState.revision,
      );

      return {
        ...freshState.parseStoredTokens(),
        refreshed: false,
      };
    }
  }

  try {
    const refreshState = await refreshTarget.loadState();
    const appCreds = await resolveOAuth2AppCredentials(refreshState.resolveAppCredentialsParams);

    // Exchange refresh token (spread provider-specific tokenParams first)
    const tokenBody = new URLSearchParams({
      ...(appCreds.tokenParams ?? {}),
      grant_type: 'refresh_token',
      refresh_token: refreshState.refreshToken,
      client_id: appCreds.clientId,
      client_secret: appCreds.clientSecret,
    });

    const tokenUrl = validateRefreshEndpoint(appCreds.refreshUrl || appCreds.tokenUrl);
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      log.error('Token refresh failed', {
        profileId: params.profileId,
        status: response.status,
      });
      throw new Error(`Token refresh failed with status ${response.status}`);
    }

    const tokens = parseRefreshTokenResponse(await response.json());
    await refreshState.persistTokens(tokens);

    log.info('Token refreshed successfully', {
      profileId: params.profileId,
      expiresIn: tokens.expiresIn,
    });

    emitAuthProfileTraceEvent({
      eventType: AUTH_PROFILE_TRACE_EVENTS.REFRESH_SUCCESS,
      profileId: params.profileId,
      tenantId: params.tenantId,
      timestamp: new Date().toISOString(),
      metadata: { expiresIn: tokens.expiresIn },
    });

    // Return raw OAuth response values directly — do NOT call parseStoredTokens() here.
    // persistTokens() calls grant.save() which triggers the encryption plugin and overwrites
    // the in-memory field with ciphertext. Reading back from the grant after save returns
    // ciphertext, not the plaintext token.
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? refreshState.refreshToken,
      expiresAt: tokens.expiresIn
        ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
        : undefined,
      scope: normalizeScopeValue(tokens.scope),
      refreshed: true,
    };
  } catch (err) {
    emitAuthProfileTraceEvent({
      eventType: AUTH_PROFILE_TRACE_EVENTS.REFRESH_ERROR,
      profileId: params.profileId,
      tenantId: params.tenantId,
      timestamp: new Date().toISOString(),
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  } finally {
    if (lock?.acquired) {
      await lock.release();
    }
  }
}
