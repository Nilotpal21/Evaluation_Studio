/**
 * MCP Auth Header Resolver
 *
 * Resolves MCP authentication headers from either:
 * 1. Legacy inline MCP auth config (authType + encryptedAuthConfig JSON), or
 * 2. Auth-profile references (authProfileId).
 *
 * Security:
 * - Header values/names are CRLF-sanitized to prevent header injection.
 * - OAuth token endpoints are SSRF-validated.
 * - OAuth token exchange is rate-limited per {tenantId, profileId}.
 *
 * Caching:
 * - OAuth2 client_credentials uses CK-1 cache key shape.
 * - Redis cache is preferred when available.
 * - In-memory fallback cache is used only when Redis is unavailable.
 */

import { createHash } from 'node:crypto';
import { createLogger } from '@agent-platform/shared-observability';
import { assertUrlSafeForSSRF } from '@agent-platform/shared-kernel/security';
import type { RedisClient } from '@agent-platform/redis';
import { resolveRedisOptionsFromEnv, createRedisConnection } from '@agent-platform/redis';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import type { RateLimiterAbstract } from 'rate-limiter-flexible';
import type { McpAuthConfig } from '../types/mcp-auth.js';
import {
  AuthProfileError,
  applyAuth,
  buildAuthProfileOAuthProviderKey,
  refreshOAuth2Token,
  resolveClientCredentialsToken,
  resolveWithGracePeriod,
} from './auth-profile/index.js';

const log = createLogger('mcp-auth-resolver');

const CRLF_RE = /[\r\n]/g;
const TENANT_SHARED_OAUTH_GRANT_USER_ID = '__tenant__';
const CACHE_BUFFER_MS = 60_000;
const MAX_FALLBACK_CACHE_SIZE = 200;
const AUTH_TOKEN_CACHE_PREFIX = 'auth-token:';
const OAUTH2_CLIENT_CREDENTIALS_AUTH_TYPE = 'oauth2_client_credentials';
const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_KEY_PREFIX = 'auth-profile:rl';

const MCP_INCOMPATIBLE_AUTH_TYPES = new Set([
  'aws_iam',
  'digest',
  'hawk',
  'ssh_key',
  'ws_security',
]);

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

interface ResolvedAccessToken {
  accessToken: string;
  expiresAt?: string;
}

const fallbackTokenCache = new Map<string, CachedToken>();

let sharedRedisClient: RedisClient | null = null;
let redisRateLimiter: RateLimiterAbstract | null = null;
let memoryRateLimiter: RateLimiterAbstract | null = null;

function sanitizeHeaderValue(val: string): string {
  return val.replace(CRLF_RE, '');
}

function sanitizeHeaderName(name: string): string {
  return name.replace(CRLF_RE, '');
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[sanitizeHeaderName(name)] = sanitizeHeaderValue(value);
  }
  return out;
}

function normalizeMcpTlsOptions(
  tlsOptions: Awaited<ReturnType<typeof applyAuth>>['tlsOptions'],
): { cert: string; key: string; ca?: string } | undefined {
  if (!tlsOptions) {
    return undefined;
  }

  const cert = typeof tlsOptions.cert === 'string' ? tlsOptions.cert.trim() : '';
  const key = typeof tlsOptions.key === 'string' ? tlsOptions.key.trim() : '';
  const ca = typeof tlsOptions.ca === 'string' ? tlsOptions.ca.trim() : '';
  if (!cert || !key) {
    return undefined;
  }

  return {
    cert,
    key,
    ...(ca ? { ca } : {}),
  };
}

function safeParseInt(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const parsed = Number.parseInt(val, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeScopeList(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.filter((scope): scope is string => typeof scope === 'string' && scope.length > 0);
  }

  if (typeof input === 'string') {
    return input
      .split(/[\s,]+/u)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
  }

  return [];
}

function ck1ScopeHash(scopes: readonly string[]): string {
  const list = scopes.filter((scope) => scope.length > 0);
  if (list.length === 0) return '';
  return createHash('sha256')
    .update([...list].sort().join(','))
    .digest('hex');
}

function buildClientCredentialsCacheKey(
  tenantId: string,
  profileId: string,
  profileVersion: number,
  scopes: readonly string[],
): string {
  const scopeHash = ck1ScopeHash(scopes);
  return `${AUTH_TOKEN_CACHE_PREFIX}${tenantId}:${OAUTH2_CLIENT_CREDENTIALS_AUTH_TYPE}:${profileId}:${profileVersion}:${scopeHash}`;
}

function parseCachedToken(raw: string): { accessToken: string; expiresAt?: number } | null {
  try {
    const parsed = JSON.parse(raw) as { accessToken?: unknown; expiresAt?: unknown };
    if (typeof parsed.accessToken !== 'string' || parsed.accessToken.trim().length === 0) {
      return null;
    }

    const expiresAtMs =
      typeof parsed.expiresAt === 'string' ? new Date(parsed.expiresAt).getTime() : undefined;

    return {
      accessToken: parsed.accessToken,
      expiresAt: Number.isFinite(expiresAtMs) ? expiresAtMs : undefined,
    };
  } catch {
    return null;
  }
}

function getFallbackCachedToken(cacheKey: string): ResolvedAccessToken | null {
  const cached = fallbackTokenCache.get(cacheKey);
  if (!cached) return null;

  if (cached.expiresAt <= Date.now() + CACHE_BUFFER_MS) {
    fallbackTokenCache.delete(cacheKey);
    return null;
  }

  return {
    accessToken: cached.accessToken,
    expiresAt: new Date(cached.expiresAt).toISOString(),
  };
}

function setFallbackCachedToken(
  cacheKey: string,
  accessToken: string,
  expiresAtIso?: string,
): void {
  const expiresAtMs = expiresAtIso ? new Date(expiresAtIso).getTime() : Number.NaN;
  if (!Number.isFinite(expiresAtMs)) {
    return;
  }

  if (fallbackTokenCache.size >= MAX_FALLBACK_CACHE_SIZE && !fallbackTokenCache.has(cacheKey)) {
    const oldestKey = fallbackTokenCache.keys().next().value;
    if (oldestKey) {
      fallbackTokenCache.delete(oldestKey);
    }
  }

  fallbackTokenCache.set(cacheKey, {
    accessToken,
    expiresAt: expiresAtMs,
  });
}

function ensureSharedRedisClient(): RedisClient | null {
  if (sharedRedisClient) {
    return sharedRedisClient;
  }

  try {
    const opts = resolveRedisOptionsFromEnv();
    // Only create a client when an explicit endpoint is configured. An empty
    // opts object (no url, no host) means "no Redis set" — fall through to the
    // in-memory cache rather than connecting to the docker-compose default.
    if (!opts || (!opts.url && !opts.host)) return null;

    const handle = createRedisConnection({
      ...opts,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });

    sharedRedisClient = handle.client;

    sharedRedisClient.on('error', (err) => {
      log.warn('MCP auth Redis client error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return sharedRedisClient;
  } catch (err) {
    log.warn('Failed to initialize MCP auth Redis client', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function getRedisClient(explicitRedis?: RedisLike): RedisLike | null {
  if (explicitRedis) {
    return explicitRedis;
  }

  return ensureSharedRedisClient() as unknown as RedisLike | null;
}

function getRateLimiter(redisClient: RedisLike | null): RateLimiterAbstract {
  const points = safeParseInt(
    process.env.AUTH_PROFILE_RATE_LIMIT_PER_MINUTE,
    DEFAULT_RATE_LIMIT_PER_MINUTE,
  );

  if (redisClient) {
    if (!redisRateLimiter) {
      redisRateLimiter = new RateLimiterRedis({
        points,
        duration: RATE_LIMIT_WINDOW_SECONDS,
        keyPrefix: RATE_LIMIT_KEY_PREFIX,
        storeClient: redisClient as unknown as RedisClient,
      });
    }

    return redisRateLimiter;
  }

  if (!memoryRateLimiter) {
    memoryRateLimiter = new RateLimiterMemory({
      points,
      duration: RATE_LIMIT_WINDOW_SECONDS,
      keyPrefix: RATE_LIMIT_KEY_PREFIX,
    });
  }

  return memoryRateLimiter;
}

async function consumeTokenExchangeQuota(
  tenantId: string,
  profileId: string,
  redisClient: RedisLike | null,
): Promise<void> {
  const limiter = getRateLimiter(redisClient);
  const key = `${tenantId}:${profileId}`;

  try {
    await limiter.consume(key);
  } catch (rejRes) {
    if (rejRes instanceof Error) {
      // Infrastructure failures should not block auth resolution.
      log.warn('MCP auth rate limiter infrastructure error (fail-open)', {
        tenantId,
        profileId,
        error: rejRes.message,
      });
      return;
    }

    throw new AuthProfileError(
      'AUTH_TOKEN_RATE_LIMITED',
      'Too many token exchange attempts. Please retry later.',
      429,
    );
  }
}

function isGrantExpired(expiresAt: Date | string | null | undefined): boolean {
  if (!expiresAt) {
    return false;
  }

  const expiresAtMs =
    expiresAt instanceof Date ? expiresAt.getTime() : new Date(String(expiresAt)).getTime();
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }

  return Date.now() >= expiresAtMs;
}

function resolveOAuthGrantAppProfileId(profile: AuthProfileRecord): string | null {
  if (profile.authType === 'oauth2_app') {
    return profile._id;
  }

  if (
    profile.authType === 'oauth2_token' &&
    typeof profile.linkedAppProfileId === 'string' &&
    profile.linkedAppProfileId.trim().length > 0
  ) {
    return profile.linkedAppProfileId.trim();
  }

  return null;
}

function normalizeSecretsPayload(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      'Auth profile secrets must be a JSON object',
      400,
    );
  }

  return payload as Record<string, unknown>;
}

async function parseProfileSecrets(profile: AuthProfileRecord): Promise<Record<string, unknown>> {
  try {
    return normalizeSecretsPayload(JSON.parse(profile.encryptedSecrets));
  } catch (primaryError) {
    try {
      const resolved = await resolveWithGracePeriod(
        {
          encryptedSecrets: profile.encryptedSecrets,
          previousEncryptedSecrets: profile.previousEncryptedSecrets,
          rotationGracePeriodMs: profile.rotationGracePeriodMs,
          updatedAt: profile.updatedAt,
        },
        async (value) => value,
      );
      return normalizeSecretsPayload(resolved);
    } catch (fallbackError) {
      if (fallbackError instanceof AuthProfileError) {
        throw fallbackError;
      }
      if (primaryError instanceof AuthProfileError) {
        throw primaryError;
      }

      throw new AuthProfileError(
        'AUTH_PROFILE_SECRETS_DECRYPTION_FAILED',
        'Failed to decrypt auth profile secrets',
        500,
      );
    }
  }
}

async function resolveOAuthGrantAccessToken(
  profile: AuthProfileRecord,
  tenantId: string,
  principalUserId: string | undefined,
  redisClient: RedisLike | null,
  minValidityMs = 0,
): Promise<ResolvedAccessToken> {
  const appProfileId = resolveOAuthGrantAppProfileId(profile);
  if (!appProfileId) {
    throw new AuthProfileError(
      'OAUTH_REAUTH_REQUIRED',
      'OAuth grant is missing. Reconnect the auth profile.',
      401,
    );
  }

  const connectionMode = profile.connectionMode === 'per_user' ? 'per_user' : 'shared';
  const principalCandidates: string[] = [];

  if (connectionMode === 'shared') {
    principalCandidates.push(TENANT_SHARED_OAUTH_GRANT_USER_ID);
  }

  if (typeof principalUserId === 'string' && principalUserId.trim().length > 0) {
    const normalizedPrincipalUserId = principalUserId.trim();
    if (!principalCandidates.includes(normalizedPrincipalUserId)) {
      principalCandidates.push(normalizedPrincipalUserId);
    }
  }

  if (
    connectionMode === 'shared' &&
    typeof profile.createdBy === 'string' &&
    profile.createdBy.trim().length > 0
  ) {
    const createdByPrincipal = profile.createdBy.trim();
    if (!principalCandidates.includes(createdByPrincipal)) {
      principalCandidates.push(createdByPrincipal);
    }
  }

  if (principalCandidates.length === 0) {
    throw new AuthProfileError(
      'OAUTH_REAUTH_REQUIRED',
      'OAuth grant principal is missing. Reconnect the auth profile.',
      401,
    );
  }

  const { EndUserOAuthToken } = await import('@agent-platform/database/models');
  const provider = buildAuthProfileOAuthProviderKey(appProfileId);

  let grant: OAuthGrantRecord | null = null;
  for (const userId of principalCandidates) {
    grant = (await EndUserOAuthToken.findOne({
      tenantId,
      provider,
      userId,
      revokedAt: null,
    })
      .select(
        'tenantId userId encryptedAccessToken encryptedRefreshToken scope expiresAt revokedAt',
      )
      .lean()) as OAuthGrantRecord | null;

    if (grant) {
      break;
    }
  }

  if (
    !grant ||
    typeof grant.encryptedAccessToken !== 'string' ||
    grant.encryptedAccessToken.trim().length === 0
  ) {
    throw new AuthProfileError(
      'OAUTH_REAUTH_REQUIRED',
      'OAuth grant is missing or expired. Reconnect the auth profile.',
      401,
    );
  }

  const grantExpiresAtMs = grant.expiresAt ? new Date(String(grant.expiresAt)).getTime() : NaN;
  const hasUsableValidityWindow =
    Number.isFinite(grantExpiresAtMs) && grantExpiresAtMs > Date.now() + Math.max(0, minValidityMs);

  if (!isGrantExpired(grant.expiresAt) && (minValidityMs <= 0 || hasUsableValidityWindow)) {
    return {
      accessToken: grant.encryptedAccessToken,
      expiresAt: Number.isFinite(grantExpiresAtMs)
        ? new Date(grantExpiresAtMs).toISOString()
        : undefined,
    };
  }

  try {
    const refreshed = await refreshOAuth2Token({
      profileId: appProfileId,
      tenantId,
      authScope: grant.userId === TENANT_SHARED_OAUTH_GRANT_USER_ID ? 'tenant' : 'user',
      userId: grant.userId,
      connectionMode,
      projectId: profile.projectId ?? undefined,
      redis: redisClient ? (redisClient as unknown as RedisClient) : undefined,
    });

    if (typeof refreshed.accessToken !== 'string' || refreshed.accessToken.trim().length === 0) {
      throw new Error('OAuth refresh completed without an access token');
    }

    return {
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
    };
  } catch (err) {
    log.warn('MCP OAuth grant refresh failed', {
      tenantId,
      authProfileId: appProfileId,
      grantPrincipalId: grant.userId,
      error: err instanceof Error ? err.message : String(err),
    });

    throw new AuthProfileError(
      'OAUTH_REAUTH_REQUIRED',
      'OAuth grant refresh failed. Reconnect the auth profile.',
      401,
    );
  }
}

async function resolveClientCredentialsAccessToken(params: {
  profileId: string;
  tenantId: string;
  profileVersion: number;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  audience?: string;
  redisClient: RedisLike | null;
}): Promise<ResolvedAccessToken> {
  const cacheKey = buildClientCredentialsCacheKey(
    params.tenantId,
    params.profileId,
    params.profileVersion,
    params.scopes,
  );

  if (params.redisClient) {
    try {
      const cachedRaw = await params.redisClient.get(cacheKey);
      if (cachedRaw) {
        const cached = parseCachedToken(cachedRaw);
        if (cached && (!cached.expiresAt || cached.expiresAt > Date.now() + CACHE_BUFFER_MS)) {
          return {
            accessToken: cached.accessToken,
            expiresAt:
              typeof cached.expiresAt === 'number'
                ? new Date(cached.expiresAt).toISOString()
                : undefined,
          };
        }
      }
    } catch (err) {
      log.warn('MCP auth redis cache read failed', {
        profileId: params.profileId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    const cached = getFallbackCachedToken(cacheKey);
    if (cached) {
      return cached;
    }
  }

  await consumeTokenExchangeQuota(params.tenantId, params.profileId, params.redisClient);

  const token = await resolveClientCredentialsToken(
    params.profileId,
    params.tenantId,
    params.profileVersion,
    params.tokenUrl,
    params.clientId,
    params.clientSecret,
    params.scopes,
    {
      redis: params.redisClient ? (params.redisClient as unknown as RedisClient) : undefined,
      ...(params.audience ? { audience: params.audience } : {}),
    },
  );

  if (!params.redisClient) {
    setFallbackCachedToken(cacheKey, token.accessToken, token.expiresAt);
  }

  return {
    accessToken: token.accessToken,
    expiresAt: token.expiresAt,
  };
}

async function resolveProfileById(params: {
  authProfileId: string;
  tenantId: string;
  projectId?: string;
}): Promise<AuthProfileRecord> {
  const { AuthProfile } = await import('@agent-platform/database/models');
  const now = new Date();
  const projectFilter = params.projectId
    ? {
        $or: [
          { projectId: params.projectId },
          { projectId: null },
          { projectId: { $exists: false } },
        ],
      }
    : {};

  const profile = (await AuthProfile.findOne({
    _id: params.authProfileId,
    tenantId: params.tenantId,
    status: 'active',
    visibility: { $ne: 'personal' },
    $and: [{ $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }, projectFilter],
  })
    .select(
      '_id tenantId projectId name authType profileVersion connectionMode linkedAppProfileId createdBy config encryptedSecrets previousEncryptedSecrets rotationGracePeriodMs updatedAt',
    )
    .lean()) as AuthProfileRecord | null;

  if (!profile) {
    throw new AuthProfileError('AUTH_PROFILE_NOT_FOUND', 'Auth profile not found', 404);
  }

  return profile;
}

async function resolveAzureAdAccessToken(params: {
  profile: AuthProfileRecord;
  secrets: Record<string, unknown>;
  tenantId: string;
  redisClient: RedisLike | null;
}): Promise<ResolvedAccessToken> {
  const tenantId =
    typeof params.profile.config.tenantId === 'string' && params.profile.config.tenantId.length > 0
      ? params.profile.config.tenantId
      : null;
  const clientId =
    typeof params.secrets.clientId === 'string' && params.secrets.clientId.length > 0
      ? params.secrets.clientId
      : null;
  const clientSecret =
    typeof params.secrets.clientSecret === 'string' && params.secrets.clientSecret.length > 0
      ? params.secrets.clientSecret
      : null;

  if (!tenantId || !clientId || !clientSecret) {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      'Azure AD profile is missing tenant/client credentials',
      400,
    );
  }

  const endpoint =
    typeof params.profile.config.endpoint === 'string' && params.profile.config.endpoint.length > 0
      ? params.profile.config.endpoint
      : 'https://login.microsoftonline.com';

  const tokenUrl = `${endpoint.replace(/\/$/, '')}/${tenantId}/oauth2/v2.0/token`;
  const configuredScopes = normalizeScopeList(params.profile.config.scopes);
  const resourceScope =
    typeof params.profile.config.resource === 'string' && params.profile.config.resource.length > 0
      ? [`${params.profile.config.resource}/.default`]
      : [];

  const scopes = configuredScopes.length > 0 ? configuredScopes : resourceScope;

  return resolveClientCredentialsAccessToken({
    profileId: params.profile._id,
    tenantId: params.tenantId,
    profileVersion: params.profile.profileVersion ?? 1,
    tokenUrl,
    clientId,
    clientSecret,
    scopes,
    redisClient: params.redisClient,
  });
}

async function applyAuthProfileToHeaders(params: {
  profile: AuthProfileRecord;
  tenantId: string;
  principalUserId?: string;
  redisClient: RedisLike | null;
  minValidityMs?: number;
}): Promise<ResolvedAuthHeadersFromProfile> {
  const profile = params.profile;
  const queryParams = new URLSearchParams();
  let expiresAt: string | undefined;

  if (MCP_INCOMPATIBLE_AUTH_TYPES.has(profile.authType)) {
    throw new AuthProfileError(
      'AUTH_TYPE_NOT_MCP_COMPATIBLE',
      `Auth type "${profile.authType}" is not compatible with MCP server auth`,
      400,
    );
  }

  if (profile.authType === 'api_key' && profile.config.placement === 'query') {
    throw new AuthProfileError(
      'AUTH_TYPE_NOT_MCP_COMPATIBLE',
      'api_key auth with query placement is not compatible with MCP server auth',
      400,
    );
  }

  const secrets = await parseProfileSecrets(profile);
  let applied: Awaited<ReturnType<typeof applyAuth>>;

  if (profile.authType === 'oauth2_app' || profile.authType === 'oauth2_token') {
    const token = await resolveOAuthGrantAccessToken(
      profile,
      params.tenantId,
      params.principalUserId,
      params.redisClient,
      params.minValidityMs ?? 0,
    );
    expiresAt = token.expiresAt;

    applied = await applyAuth({
      authType: 'oauth2_token',
      config: profile.config,
      secrets: { accessToken: token.accessToken },
      headers: {},
      queryParams,
    });
  } else if (profile.authType === 'oauth2_client_credentials') {
    const tokenUrl = typeof profile.config.tokenUrl === 'string' ? profile.config.tokenUrl : '';
    const clientId = typeof secrets.clientId === 'string' ? secrets.clientId : '';
    const clientSecret = typeof secrets.clientSecret === 'string' ? secrets.clientSecret : '';

    if (!tokenUrl || !clientId || !clientSecret) {
      throw new AuthProfileError(
        'AUTH_PROFILE_VALIDATION_FAILED',
        'Client credentials profile is missing token URL or client credentials',
        400,
      );
    }

    assertUrlSafeForSSRF(
      tokenUrl,
      tokenUrl.startsWith('http://localhost') || tokenUrl.startsWith('http://127.0.0.1')
        ? { allowLocalhost: true }
        : {},
    );

    const scopes = normalizeScopeList(profile.config.scopes ?? profile.config.scope);
    const audience =
      typeof profile.config.audience === 'string' ? profile.config.audience.trim() : '';
    const token = await resolveClientCredentialsAccessToken({
      profileId: profile._id,
      tenantId: params.tenantId,
      profileVersion: profile.profileVersion ?? 1,
      tokenUrl,
      clientId,
      clientSecret,
      scopes,
      ...(audience ? { audience } : {}),
      redisClient: params.redisClient,
    });
    expiresAt = token.expiresAt;

    applied = await applyAuth({
      authType: 'oauth2_client_credentials',
      config: profile.config,
      secrets: { accessToken: token.accessToken },
      headers: {},
      queryParams,
    });
  } else if (profile.authType === 'azure_ad') {
    const token = await resolveAzureAdAccessToken({
      profile,
      secrets,
      tenantId: params.tenantId,
      redisClient: params.redisClient,
    });
    expiresAt = token.expiresAt;

    applied = await applyAuth({
      authType: 'oauth2_token',
      config: profile.config,
      secrets: { accessToken: token.accessToken },
      headers: {},
      queryParams,
    });
  } else {
    applied = await applyAuth({
      authType: profile.authType,
      config: profile.config,
      secrets,
      headers: {},
      queryParams,
    });
  }

  const tlsOptions = normalizeMcpTlsOptions(applied.tlsOptions);
  if (profile.authType === 'mtls' && !tlsOptions) {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      'mTLS auth profile is missing client certificate or key',
      400,
    );
  }

  return {
    headers: sanitizeHeaders(applied.headers ?? {}),
    authType: profile.authType,
    profileVersion: profile.profileVersion ?? 1,
    expiresAt,
    ...(tlsOptions ? { tlsOptions } : {}),
  };
}

async function resolveLegacyClientCredentialsHeaders(
  config: Extract<McpAuthConfig, { type: 'oauth2_client_credentials' }>,
  tenantId: string,
  deps: McpAuthResolverDeps,
): Promise<Record<string, string>> {
  if (!config.tokenEndpoint.startsWith('https://')) {
    throw new Error('OAuth2 token endpoint must use HTTPS');
  }

  assertUrlSafeForSSRF(config.tokenEndpoint);

  const redisClient = getRedisClient(deps.redis);
  if (!redisClient) {
    log.warn('MCP OAuth client_credentials resolver using in-memory cache fallback (no Redis)');
  }

  const scopes = normalizeScopeList(config.scope);
  const legacyProfileId = `legacy:${createHash('sha256').update(`${config.tokenEndpoint}:${config.clientId}`).digest('hex')}`;
  const token = await resolveClientCredentialsAccessToken({
    profileId: legacyProfileId,
    tenantId,
    profileVersion: 1,
    tokenUrl: config.tokenEndpoint,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scopes,
    redisClient,
  });

  return { Authorization: sanitizeHeaderValue(`Bearer ${token.accessToken}`) };
}

export interface RedisLike {
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<number>;
}

export interface McpAuthResolverDeps {
  redis?: RedisLike;
}

export interface ResolveAuthHeadersFromProfileParams {
  authProfileId: string;
  tenantId: string;
  transport?: 'http' | 'sse' | 'stdio';
  projectId?: string;
  principalUserId?: string;
  /**
   * Minimum required token validity window. If the currently stored grant is
   * valid but expiring within this duration, resolver attempts a proactive
   * refresh and returns a refreshed token.
   */
  minValidityMs?: number;
}

export interface ResolvedAuthHeadersFromProfile {
  headers: Record<string, string>;
  authType: string;
  profileVersion: number;
  expiresAt?: string;
  tlsOptions?: {
    cert: string;
    key: string;
    ca?: string;
  };
}

interface AuthProfileRecord {
  _id: string;
  tenantId: string;
  projectId?: string | null;
  name?: string;
  authType: string;
  profileVersion?: number;
  connectionMode?: 'shared' | 'per_user';
  linkedAppProfileId?: string | null;
  createdBy?: string;
  config: Record<string, unknown>;
  encryptedSecrets: string;
  previousEncryptedSecrets?: string;
  rotationGracePeriodMs?: number;
  updatedAt: Date;
}

interface OAuthGrantRecord {
  tenantId: string;
  userId: string;
  encryptedAccessToken?: string | null;
  encryptedRefreshToken?: string | null;
  scope?: string | null;
  expiresAt?: Date | string | null;
  revokedAt?: Date | null;
}

/**
 * Resolve headers from a legacy MCP auth config object.
 */
export async function resolveAuthHeaders(
  config: McpAuthConfig,
  tenantId: string,
  deps: McpAuthResolverDeps = {},
): Promise<Record<string, string>> {
  switch (config.type) {
    case 'none':
      return {};

    case 'bearer':
      return { Authorization: sanitizeHeaderValue(`Bearer ${config.token}`) };

    case 'api_key':
      return { [sanitizeHeaderName(config.headerName)]: sanitizeHeaderValue(config.value) };

    case 'custom_headers': {
      const headers: Record<string, string> = {};
      const entries = Object.entries(config.headers);
      for (const [name, value] of entries.slice(0, 20)) {
        headers[sanitizeHeaderName(name)] = sanitizeHeaderValue(value);
      }
      return headers;
    }

    case 'oauth2_client_credentials':
      return resolveLegacyClientCredentialsHeaders(config, tenantId, deps);
  }
}

/**
 * Resolve headers from an auth-profile reference attached to an MCP server.
 */
export async function resolveAuthHeadersFromProfileDetailed(
  params: ResolveAuthHeadersFromProfileParams,
  deps: McpAuthResolverDeps = {},
): Promise<ResolvedAuthHeadersFromProfile> {
  const profile = await resolveProfileById({
    authProfileId: params.authProfileId,
    tenantId: params.tenantId,
    projectId: params.projectId,
  });

  if (profile.connectionMode === 'per_user') {
    throw new AuthProfileError(
      'AUTH_PROFILE_PER_USER_IN_MCP',
      'Per-user auth profiles are not supported for MCP server bindings',
      400,
    );
  }

  if (profile.authType === 'mtls' && params.transport === 'sse') {
    throw new AuthProfileError(
      'MCP_TRANSPORT_NOT_TLS_CAPABLE',
      'mTLS auth profiles require HTTP transport',
      400,
    );
  }

  const redisClient = getRedisClient(deps.redis);
  if (!redisClient) {
    log.warn('MCP auth-profile resolver using in-memory fallback cache (Redis unavailable)');
  }

  return applyAuthProfileToHeaders({
    profile,
    tenantId: params.tenantId,
    principalUserId: params.principalUserId,
    redisClient,
    minValidityMs: params.minValidityMs,
  });
}

/**
 * Resolve headers from an auth-profile reference attached to an MCP server.
 * Maintained for backward compatibility with existing call sites.
 */
export async function resolveAuthHeadersFromProfile(
  params: ResolveAuthHeadersFromProfileParams,
  deps: McpAuthResolverDeps = {},
): Promise<Record<string, string>> {
  const resolved = await resolveAuthHeadersFromProfileDetailed(params, deps);
  return resolved.headers;
}

/** Clear all fallback OAuth2 tokens (for testing). */
export function clearOAuth2TokenCache(): void {
  fallbackTokenCache.clear();
  // Reset the shared Redis client so the next call re-reads env vars. This
  // allows tests to control Redis availability via process.env without
  // stale singleton state carrying over between test cases.
  sharedRedisClient = null;
  redisRateLimiter = null;
  memoryRateLimiter = null;
}
