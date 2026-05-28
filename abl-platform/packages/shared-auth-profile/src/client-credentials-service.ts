/**
 * OAuth2 Client Credentials Service
 *
 * Handles token exchange for client_credentials grant type.
 * Caches tokens in Redis under the canonical CK-1 cache-key shape:
 *   `auth-token:{tenantId}:oauth2_client_credentials:{profileId}:{profileVersion}:{scopeHash}`
 *
 * `profileVersion` is the monotonic-int field added in Phase 0.4 — bumped on
 * every config / secret rewrite — so a profile mutation invalidates every
 * cached entry that referenced the prior version. `scopeHash` is the SHA-256
 * of the canonicalized (sorted, comma-joined) scope list and segments cache
 * entries that share a profile but were issued for different scopes.
 */
import { createHash } from 'node:crypto';
import { createLogger } from '@agent-platform/shared-observability';
import { assertUrlSafeForSSRF } from '@agent-platform/shared-kernel/security';
import { AuthProfileError } from './errors.js';

const log = createLogger('client-credentials-service');

const CACHE_PREFIX = 'auth-token:';
const CC_AUTH_TYPE = 'oauth2_client_credentials';
const CACHE_BUFFER_SECS = 60; // expire cache 60s before actual expiry
// Fallback cache lifetime when the provider omits `expires_in`. Without this
// the token is never cached and every tool call re-exchanges credentials,
// which can hit the provider's token-endpoint rate limit at high concurrency.
// 10 minutes is short enough that a real token expiry is unlikely to be
// exceeded for providers that quietly issue ~1h tokens, and long enough to
// amortize the exchange cost.
const DEFAULT_CACHE_TTL_SECS = 600;
// Cap raw, non-JSON error response bodies so a misbehaving provider returning
// HTML or megabytes of debug output cannot blow up logs or thrown error messages.
const MAX_RAW_ERROR_BODY_CHARS = 200;

/**
 * Hash a scope list into the canonical CK-1 `scopeHash` segment. Empty input
 * (non-OAuth profile, or pure default-scope grant) returns the empty string
 * so `profileVersion` alone drives invalidation; otherwise the SHA-256 of
 * the sorted, comma-joined list is returned (64-char hex).
 */
function ck1ScopeHash(scopes: readonly string[]): string {
  const list = scopes.filter((s) => s.length > 0);
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
  return `${CACHE_PREFIX}${tenantId}:${CC_AUTH_TYPE}:${profileId}:${profileVersion}:${scopeHash}`;
}

interface ParsedClientCredentialsToken {
  accessToken: string;
  expiresAt?: string;
}

function validateClientCredentialsTokenUrl(urlValue: string): string {
  let parsed: URL;
  try {
    parsed = new URL(urlValue);
  } catch (err) {
    throw new Error(`Client credentials token URL is invalid: ${urlValue}`, { cause: err });
  }

  if (
    parsed.protocol !== 'https:' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '127.0.0.1'
  ) {
    throw new Error(`Client credentials token URL must use HTTPS: ${urlValue}`);
  }

  assertUrlSafeForSSRF(
    urlValue,
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
      ? { allowLocalhost: true }
      : {},
  );
  return urlValue;
}

function parseCachedClientCredentialsToken(raw: string): ParsedClientCredentialsToken | null {
  try {
    const parsed = JSON.parse(raw) as {
      accessToken?: unknown;
      expiresAt?: unknown;
    };
    if (typeof parsed.accessToken !== 'string' || parsed.accessToken.trim().length === 0) {
      return null;
    }

    return {
      accessToken: parsed.accessToken,
      expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Coerce `expires_in` from any OAuth 2.0 provider into a positive number, or
 * `undefined` if it cannot be interpreted.
 *
 * RFC 6749 §5.1 uses the value `"3600"` in its example, ambiguous about the
 * underlying JSON type. Real-world providers ship both shapes:
 *   - number:    Azure AD v2 (`/oauth2/v2.0/token`), GitHub, Google, Auth0,
 *                most modern IdPs
 *   - string:    Azure AD v1 (`/oauth2/token`), PingFederate (some configs),
 *                Okta (older tenants), Salesforce (older API versions),
 *                ADFS, custom RFC-literal IdPs
 *
 * `null`, `0`, negative, non-finite, non-numeric strings, and missing fields
 * are all tolerated: returned as `undefined` so the caller falls back to
 * `DEFAULT_CACHE_TTL_SECS`. We do NOT throw — that would prevent the user
 * from authenticating with a perfectly valid provider just because of a
 * cosmetic response-shape difference.
 */
function coerceExpiresIn(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    log.warn('cc_response_expires_in_unparseable_string', { value: trimmed });
    return undefined;
  }
  return undefined;
}

function parseClientCredentialsResponse(payload: unknown): {
  accessToken: string;
  expiresIn?: number;
} {
  if (typeof payload !== 'object' || payload == null) {
    throw new Error('Client credentials exchange returned an invalid token payload');
  }

  const { access_token: accessToken, expires_in: expiresInRaw } = payload as {
    access_token?: unknown;
    expires_in?: unknown;
  };

  if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    throw new Error('Client credentials exchange returned an invalid access_token');
  }

  return {
    accessToken,
    expiresIn: coerceExpiresIn(expiresInRaw),
  };
}

import type { RedisClient } from '@agent-platform/redis';

export interface ClientCredentialsDeps {
  /**
   * Optional Redis client for token caching. Accepts standalone Redis or
   * Cluster — only single-key SET/GET/DEL are used.
   */
  redis?: RedisClient;
  audience?: string;
}

export interface ClientCredentialsResult {
  accessToken: string;
  expiresAt?: string;
  cached: boolean;
}

/**
 * Resolve a client_credentials token. Checks Redis cache first,
 * then exchanges credentials with the provider if needed.
 *
 * `profileVersion` is the auth_profiles row's monotonic-int version field
 * (from the Phase 0.4 pre-save hook) and is part of the CK-1 cache key.
 * Bumping it invalidates every prior cache entry for the profile.
 */
export async function resolveClientCredentialsToken(
  profileId: string,
  tenantId: string,
  profileVersion: number,
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  scopes: string[],
  deps: ClientCredentialsDeps,
): Promise<ClientCredentialsResult> {
  const cacheKey = buildClientCredentialsCacheKey(tenantId, profileId, profileVersion, scopes);

  // Check Redis cache first
  if (deps.redis) {
    try {
      const cached = await deps.redis.get(cacheKey);
      if (cached) {
        const parsed = parseCachedClientCredentialsToken(cached);
        if (parsed) {
          return { accessToken: parsed.accessToken, expiresAt: parsed.expiresAt, cached: true };
        }

        log.warn('cc_cache_invalid', { profileId });
        try {
          await deps.redis.del(cacheKey);
        } catch (err) {
          log.warn('cc_cache_delete_failed', {
            profileId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.warn('cc_cache_read_failed', {
        profileId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Exchange credentials
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  if (scopes.length > 0) {
    body.set('scope', scopes.join(' '));
  }
  const audience = typeof deps.audience === 'string' ? deps.audience.trim() : '';
  if (audience.length > 0) {
    body.set('audience', audience);
  }

  const safeTokenUrl = validateClientCredentialsTokenUrl(tokenUrl);
  const response = await fetch(safeTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    // Capture the OAuth2 standard `error` / `error_description` fields from the
    // response body (RFC 6749 §5.2) so failed exchanges surface actionable
    // detail like "invalid_client: Wrong client_secret" instead of just
    // "exchange failed with status 401". The bodies of OAuth error responses
    // are public per spec and never contain access_tokens, so it is safe to
    // include them in the thrown message.
    const errorDetail = await readClientCredentialsErrorDetail(response, profileId);
    throw new AuthProfileError(
      'AUTH_PROFILE_CC_PROVIDER_ERROR',
      `Client credentials exchange failed with status ${response.status}${errorDetail ? `: ${errorDetail}` : ''}`,
      response.status,
    );
  }

  const tokens = parseClientCredentialsResponse(await response.json());
  const expiresAt = tokens.expiresIn
    ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
    : undefined;

  // Cache in Redis. When the provider omits expires_in, fall back to
  // DEFAULT_CACHE_TTL_SECS so we still amortize the exchange cost and don't
  // hammer the token endpoint on every call.
  if (deps.redis) {
    const ttlSecs = tokens.expiresIn
      ? Math.max(1, tokens.expiresIn - CACHE_BUFFER_SECS)
      : DEFAULT_CACHE_TTL_SECS;
    const cachedExpiresAt = expiresAt ?? new Date(Date.now() + ttlSecs * 1000).toISOString();
    try {
      await deps.redis.set(
        cacheKey,
        JSON.stringify({ accessToken: tokens.accessToken, expiresAt: cachedExpiresAt }),
        'EX',
        ttlSecs,
      );
    } catch (err) {
      log.warn('cc_cache_write_failed', {
        profileId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { accessToken: tokens.accessToken, expiresAt, cached: false };
}

/**
 * Read the failed-exchange response body and extract a user-facing detail
 * string. Prefers the OAuth2 `error: error_description` form; falls back to a
 * length-capped raw text snippet for non-spec providers (or HTML 5xx pages).
 * Never throws — body-read failures yield an empty detail string.
 */
async function readClientCredentialsErrorDetail(
  response: Response,
  profileId: string,
): Promise<string> {
  let rawBody = '';
  try {
    rawBody = await response.text();
  } catch (err) {
    log.warn('cc_error_body_read_failed', {
      profileId,
      status: response.status,
      error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }

  if (rawBody.length === 0) return '';

  try {
    const parsed = JSON.parse(rawBody) as {
      error?: unknown;
      error_description?: unknown;
    };
    const code = typeof parsed.error === 'string' ? parsed.error.trim() : '';
    const desc =
      typeof parsed.error_description === 'string' ? parsed.error_description.trim() : '';
    const detail = [code, desc].filter((part) => part.length > 0).join(': ');
    if (detail.length > 0) return detail;
  } catch {
    // Body is not JSON — fall through to the raw snippet path below.
  }

  return rawBody.slice(0, MAX_RAW_ERROR_BODY_CHARS).trim();
}
