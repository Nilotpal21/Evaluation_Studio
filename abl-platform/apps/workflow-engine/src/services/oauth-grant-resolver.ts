/**
 * OAuth Grant Resolver
 *
 * Looks up durable EndUserOAuthToken grants for oauth2_app auth profiles
 * so that connector actions receive actual access/refresh tokens, not app credentials.
 * Proactively refreshes expired tokens using the app profile's client credentials.
 */

import type { OAuthGrantResolver } from '@agent-platform/connectors';
import { parseTokenResponse } from '@agent-platform/connectors/oauth/parse-token-response';
import { createLogger } from '@abl/compiler/platform';
import { runLuaScript, type LuaScript } from '@agent-platform/redis';
import { isDEKEnvelopeFormat } from '@agent-platform/shared-encryption';
import { safeFetch as defaultSafeFetch } from '@agent-platform/shared-kernel/security/safe-fetch';

const log = createLogger('workflow-engine:oauth-grant-resolver');

// ─── Types ──────────────────────────────────────────────────────────────

/** Mongoose-like model for EndUserOAuthToken */
export interface OAuthTokenModel {
  findOne(filter: Record<string, unknown>): {
    lean(): Promise<OAuthTokenRecord | null>;
  };
  collection: {
    updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown>;
  };
}

/** Mongoose-like model for AuthProfile (app profiles) */
export interface AuthProfileModel {
  findOne(filter: Record<string, unknown>): {
    lean(): Promise<AuthProfileRecord | null>;
  };
}

interface OAuthTokenRecord {
  _id: unknown;
  tenantId: string;
  userId: string;
  provider: string;
  encryptedAccessToken?: string;
  encryptedRefreshToken?: string;
  expiresAt?: Date | string;
  revokedAt?: Date | string | null;
}

interface AuthProfileRecord {
  _id: unknown;
  tenantId: string;
  /** May be a ciphertext string or already-decrypted object (Mongoose plugin) */
  encryptedSecrets: string | Record<string, unknown> | null;
  config?: {
    tokenUrl?: string;
    refreshUrl?: string;
    [key: string]: unknown;
  };
}

export interface EncryptionFacade {
  encrypt: (plaintext: string, tenantId: string) => string | Promise<string>;
  decrypt: (ciphertext: string, tenantId: string) => string | Promise<string>;
}

/** Minimal Redis-like interface for distributed locking (SET NX PX) */
export interface RedisLike {
  set(key: string, value: string, nx: 'NX', px: 'PX', ms: number): Promise<'OK' | null>;
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface OAuthGrantResolverDeps {
  tokenModel: OAuthTokenModel;
  authProfileModel: AuthProfileModel;
  encryption: EncryptionFacade;
  redis?: RedisLike;
  safeFetch?: typeof defaultSafeFetch;
}

// ─── Constants ──────────────────────────────────────────────────────────

const TENANT_SHARED_PRINCIPAL = '__tenant__';
const AUTH_PROFILE_PROVIDER_PREFIX = 'auth-profile:';
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry
const TOKEN_REFRESH_TIMEOUT_MS = 15_000;
const SECONDS_TO_MS = 1000;
const REFRESH_LOCK_TTL_MS = 30_000;
const REFRESH_LOCK_RETRY_DELAY_MS = 500;
const REFRESH_LOCK_MAX_RETRIES = 6; // ~3 seconds total wait
const REFRESH_LOCK_PREFIX = 'oauth-grant-refresh:';

/** Lua script: compare-and-delete — only deletes the key if it holds the expected value */
const RELEASE_LOCK_LUA: LuaScript = {
  name: 'oauth-grant-release-lock',
  body: `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`,
  numberOfKeys: 1,
};

// ─── Implementation ─────────────────────────────────────────────────────

/**
 * Safely decrypt a value that may have already been decrypted by the Mongoose
 * encryption plugin's post-find hook. If the value is not a string or looks like
 * plaintext (not base64 ciphertext), return it as-is.
 */
async function safeDecrypt(
  value: unknown,
  tenantId: string,
  encryption: EncryptionFacade,
): Promise<string> {
  if (typeof value !== 'string') {
    throw new Error('Cannot decrypt non-string value');
  }
  // The Mongoose encryption plugin's post('findOne') hook decrypts encryptedAccessToken
  // even for .lean() queries. If the value is already plaintext, isDEKEnvelopeFormat
  // returns false and we return it as-is — avoiding the double-decryption that caused
  // "Unsupported tenant ciphertext format. Expected DEK envelope." for hex OAuth tokens
  // (e.g. Zendesk's 64-char hex access tokens pass a naive base64 regex but are not
  // DEK envelopes).
  if (!isDEKEnvelopeFormat(value)) {
    return value;
  }
  return await Promise.resolve(encryption.decrypt(value, tenantId));
}

/**
 * Refresh an expired OAuth grant token using the app profile's client credentials.
 */
async function refreshGrantToken(
  appProfileId: string,
  tenantId: string,
  refreshTokenValue: string,
  deps: OAuthGrantResolverDeps,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  // ABLP-1123: block revoked AND disabled profiles. A revoked/disabled AuthProfile
  // still holds valid clientId/clientSecret that could mint new tokens at the
  // provider — refuse the refresh at this boundary as defense-in-depth alongside
  // the EndUserOAuthToken.revokedAt filter.
  const appProfile = await deps.authProfileModel
    .findOne({ _id: appProfileId, tenantId, status: { $ne: 'revoked' }, enabled: { $ne: false } })
    .lean();
  if (!appProfile) {
    log.error('OAuth app profile not found or revoked for token refresh', {
      appProfileId,
      tenantId,
    });
    throw new Error('OAuth app profile not found or revoked for token refresh');
  }

  // encryptedSecrets may already be decrypted by Mongoose encryption plugin's post-find hook.
  // If it's already a plaintext JSON string (starts with '{'), parse directly.
  // Only call decrypt if it looks like ciphertext (e.g. base64 DEK envelope).
  let appSecrets: Record<string, unknown>;
  const rawSecrets = appProfile.encryptedSecrets;
  if (typeof rawSecrets === 'object' && rawSecrets !== null) {
    appSecrets = rawSecrets as Record<string, unknown>;
  } else if (
    typeof rawSecrets === 'string' &&
    (rawSecrets.startsWith('{') || rawSecrets.startsWith('['))
  ) {
    appSecrets = JSON.parse(rawSecrets);
  } else if (typeof rawSecrets === 'string') {
    appSecrets = JSON.parse(await safeDecrypt(rawSecrets, tenantId, deps.encryption));
  } else {
    throw new Error('OAuth app profile has no encrypted secrets');
  }
  const clientId = typeof appSecrets.clientId === 'string' ? appSecrets.clientId : '';
  const clientSecret = typeof appSecrets.clientSecret === 'string' ? appSecrets.clientSecret : '';
  const rawTokenUrl = appProfile.config?.tokenUrl ?? appProfile.config?.refreshUrl;
  const tokenUrl = typeof rawTokenUrl === 'string' ? rawTokenUrl : '';

  if (!clientId || !clientSecret || !tokenUrl) {
    log.error('OAuth app profile missing required fields', { appProfileId, tenantId });
    throw new Error('OAuth app profile missing clientId, clientSecret, or tokenUrl');
  }

  // SSRF guard: only allow HTTPS token URLs to prevent requests to internal services
  let parsedTokenUrl: URL;
  try {
    parsedTokenUrl = new URL(tokenUrl);
  } catch {
    throw new Error('Invalid tokenUrl format');
  }
  if (parsedTokenUrl.protocol !== 'https:') {
    log.error('Token URL must use HTTPS', { appProfileId, tenantId });
    throw new Error('Token URL must use HTTPS');
  }

  const tokenBody = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await (deps.safeFetch ?? defaultSafeFetch)(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: tokenBody,
    signal: AbortSignal.timeout(TOKEN_REFRESH_TIMEOUT_MS),
  });

  if (!res.ok) {
    log.error('Token refresh failed', { appProfileId, tenantId, status: res.status });
    throw new Error(`Token refresh failed with status ${res.status}`);
  }

  const tokens = await parseTokenResponse(res);
  if (typeof tokens.access_token !== 'string') {
    log.error('Token refresh response missing access_token', { appProfileId, tenantId });
    throw new Error('Token refresh response missing access_token');
  }

  return {
    access_token: tokens.access_token,
    refresh_token: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined,
    expires_in: typeof tokens.expires_in === 'number' ? tokens.expires_in : undefined,
  };
}

/**
 * Create an OAuthGrantResolver that looks up durable EndUserOAuthToken grants.
 *
 * Resolution order:
 * 1. User-specific grant (if userId provided)
 * 2. Tenant-shared grant (__tenant__)
 *
 * Proactively refreshes expired tokens (5-minute buffer before expiry).
 */
export function createOAuthGrantResolver(deps: OAuthGrantResolverDeps): OAuthGrantResolver {
  return {
    async resolveGrant(opts: {
      authProfileId: string;
      tenantId: string;
      userId?: string;
    }): Promise<{ access_token: string; refresh_token?: string } | null> {
      const provider = `${AUTH_PROFILE_PROVIDER_PREFIX}${opts.authProfileId}`;
      const candidates = opts.userId
        ? [opts.userId, TENANT_SHARED_PRINCIPAL]
        : [TENANT_SHARED_PRINCIPAL];

      for (const userId of candidates) {
        const grant = await deps.tokenModel
          .findOne({
            tenantId: opts.tenantId,
            userId,
            provider,
            revokedAt: null,
          })
          .lean();

        if (!grant || typeof grant.encryptedAccessToken !== 'string') {
          continue;
        }

        // Check if token needs refresh
        const expiresAtMs = grant.expiresAt ? new Date(grant.expiresAt).getTime() : 0;
        const needsRefresh = expiresAtMs > 0 && Date.now() > expiresAtMs - REFRESH_BUFFER_MS;

        if (needsRefresh && typeof grant.encryptedRefreshToken === 'string') {
          const lockKey = `${REFRESH_LOCK_PREFIX}${String(grant._id)}`;
          const lockValue = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          let lockAcquired = false;

          try {
            // Acquire distributed lock to prevent concurrent refresh attempts.
            // If Redis is not available, proceed without locking (single-instance fallback).
            if (deps.redis) {
              const lockResult = await deps.redis.set(
                lockKey,
                lockValue,
                'NX',
                'PX',
                REFRESH_LOCK_TTL_MS,
              );
              lockAcquired = lockResult === 'OK';

              if (!lockAcquired) {
                // Another instance is refreshing — wait and re-read the grant
                for (let i = 0; i < REFRESH_LOCK_MAX_RETRIES; i++) {
                  await new Promise((resolve) => setTimeout(resolve, REFRESH_LOCK_RETRY_DELAY_MS));
                  const updated = await deps.tokenModel
                    .findOne({
                      _id: grant._id,
                      tenantId: opts.tenantId,
                      revokedAt: null,
                    })
                    .lean();
                  if (updated && typeof updated.encryptedAccessToken === 'string') {
                    const updatedExpiresMs = updated.expiresAt
                      ? new Date(updated.expiresAt).getTime()
                      : 0;
                    if (
                      updatedExpiresMs === 0 ||
                      Date.now() < updatedExpiresMs - REFRESH_BUFFER_MS
                    ) {
                      // Token was refreshed by the winner — decrypt and return
                      const freshAccess = await safeDecrypt(
                        updated.encryptedAccessToken,
                        opts.tenantId,
                        deps.encryption,
                      );
                      const freshRefresh =
                        typeof updated.encryptedRefreshToken === 'string'
                          ? await safeDecrypt(
                              updated.encryptedRefreshToken,
                              opts.tenantId,
                              deps.encryption,
                            )
                          : undefined;
                      return {
                        access_token: freshAccess,
                        ...(freshRefresh ? { refresh_token: freshRefresh } : {}),
                      };
                    }
                  }
                }
                // Lock holder did not refresh in time — fall through to return existing token
                log.warn('OAuth refresh lock wait timed out, returning existing token', {
                  authProfileId: opts.authProfileId,
                  tenantId: opts.tenantId,
                });
              }
            } else {
              // No Redis — proceed with refresh (single-instance mode)
              lockAcquired = true;
            }

            if (lockAcquired) {
              const refreshToken = await safeDecrypt(
                grant.encryptedRefreshToken,
                opts.tenantId,
                deps.encryption,
              );
              const tokens = await refreshGrantToken(
                opts.authProfileId,
                opts.tenantId,
                refreshToken,
                deps,
              );

              // Persist refreshed tokens back to the grant.
              // Use raw MongoDB collection to bypass Mongoose encryption plugin
              // which blocks updateOne with encrypted fields.
              const newAccessEncrypted = await Promise.resolve(
                deps.encryption.encrypt(tokens.access_token, opts.tenantId),
              );
              const updateSet: Record<string, unknown> = {
                encryptedAccessToken: newAccessEncrypted,
                refreshedAt: new Date(),
                updatedAt: new Date(),
              };
              if (tokens.expires_in) {
                updateSet.expiresAt = new Date(Date.now() + tokens.expires_in * SECONDS_TO_MS);
              }
              if (tokens.refresh_token) {
                updateSet.encryptedRefreshToken = await Promise.resolve(
                  deps.encryption.encrypt(tokens.refresh_token, opts.tenantId),
                );
              }
              // ABLP-1123: include `revokedAt: null` in the filter so a revoke
              // that lands between our read and this write loses the race —
              // the refresh aborts and the in-flight workflow gets an auth
              // error instead of one more provider call with a fresh token.
              const updateResult = (await deps.tokenModel.collection.updateOne(
                { _id: grant._id, tenantId: opts.tenantId, revokedAt: null },
                { $set: updateSet },
              )) as { matchedCount?: number };
              if ((updateResult?.matchedCount ?? 0) === 0) {
                throw new Error('OAuth grant was revoked during token refresh');
              }

              return {
                access_token: tokens.access_token,
                ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
              };
            }
          } catch (refreshErr) {
            const msg = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
            log.warn('Token refresh failed, returning existing (possibly expired) token', {
              authProfileId: opts.authProfileId,
              tenantId: opts.tenantId,
              error: msg,
            });
            // Fall through to return the existing token below
          } finally {
            // Release lock if we acquired it
            if (lockAcquired && deps.redis) {
              await runLuaScript(
                deps.redis as unknown as Parameters<typeof runLuaScript>[0],
                RELEASE_LOCK_LUA,
                [lockKey],
                [lockValue],
              ).catch(() => {
                // Lock TTL will expire — safe to ignore release failure
              });
            }
          }
        }

        // Token is still valid — decrypt and return
        const accessToken = await safeDecrypt(
          grant.encryptedAccessToken,
          opts.tenantId,
          deps.encryption,
        );
        const refreshToken =
          typeof grant.encryptedRefreshToken === 'string'
            ? await safeDecrypt(grant.encryptedRefreshToken, opts.tenantId, deps.encryption)
            : undefined;

        return {
          access_token: accessToken,
          ...(refreshToken ? { refresh_token: refreshToken } : {}),
        };
      }

      return null;
    },
  };
}
