/**
 * Authentication helpers for k6 benchmarks.
 *
 * Provides token acquisition and automatic refresh for long-running tests.
 * The refresh token is used to obtain new access tokens before expiry,
 * enabling test runs longer than the 15-min JWT TTL.
 */
import http from 'k6/http';
import { sleep } from 'k6';
import encoding from 'k6/encoding';
import { config } from './config.ts';

/** Auth requests (refresh, dev-login) should not pollute the global http_req_failed metric. */
const authResponseCallback = http.expectedStatuses(200, 201, 400, 401, 403, 429, 500);

interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

/** Base refresh buffer: 2 minutes before expiry */
const REFRESH_BUFFER_BASE_SEC = 120;
/**
 * Per-VU jitter: each VU adds 0-300 seconds of random buffer to desynchronize
 * refresh attempts. With 50 VUs and a 30 req/min rate limit on /api/auth/refresh,
 * a 60s jitter window causes a stampede. 300s (5 min) spreads attempts enough
 * that at most ~10 VUs refresh per minute.
 */
const REFRESH_JITTER_SEC = Math.floor(Math.random() * 300);
const REFRESH_BUFFER_SEC = REFRESH_BUFFER_BASE_SEC + REFRESH_JITTER_SEC;

// ---------------------------------------------------------------------------
// Module-level token state (shared across VU iterations within a single VU)
// ---------------------------------------------------------------------------

let _accessToken = '';
let _refreshToken = '';
let _expiresAt = 0; // unix seconds

/**
 * Decode the `exp` claim from a JWT without crypto.
 * JWTs are base64url-encoded JSON; we only need the payload.
 */
function getJwtExpiry(jwt: string): number {
  const parts = jwt.split('.');
  if (parts.length !== 3) return 0;

  // base64url → base64 → decode
  let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  // Pad to multiple of 4
  while (payload.length % 4 !== 0) payload += '=';

  try {
    // k6 does not have atob — use k6/encoding.b64decode instead.
    const decoded = JSON.parse(encoding.b64decode(payload, 'std', 's')) as { exp?: number };
    return decoded.exp || 0;
  } catch {
    return 0;
  }
}

/**
 * Extract the refresh_token value from Set-Cookie response headers.
 * The server returns: refresh_token=<value>; Path=/; Expires=...; HttpOnly; ...
 * k6 exposes response.headers as Record<string, string> (last value wins)
 * or via response.cookies which is a jar-based API.
 */
function extractRefreshTokenFromHeaders(headers: Record<string, string>): string {
  // k6 response.headers keys are case-insensitive but typically capitalized
  const setCookie = headers['Set-Cookie'] || headers['set-cookie'] || '';
  if (!setCookie) return '';

  // Match refresh_token=<value> (stops at first ; or end of string)
  const match = setCookie.match(/refresh_token=([^;]+)/);
  return match ? match[1] : '';
}

/**
 * Extract refresh token from k6 response cookies jar.
 * k6 response.cookies is Record<string, Array<{value: string, ...}>>.
 */
function extractRefreshTokenFromCookies(cookies: Record<string, Array<{ value: string }>>): string {
  const entries = cookies['refresh_token'];
  if (entries && entries.length > 0) {
    return entries[0].value;
  }
  return '';
}

/**
 * Check if the current access token needs refresh.
 */
function needsRefresh(): boolean {
  if (!_refreshToken) return false;
  if (!_expiresAt) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec >= _expiresAt - REFRESH_BUFFER_SEC;
}

/**
 * Call POST /api/auth/refresh to get a new access token.
 * Sends the refresh token as a Cookie header (the server reads it from the
 * `refresh_token` cookie, not from the JSON body).
 * Updates module-level state with the new tokens.
 */
function doRefresh(): boolean {
  const MAX_RETRIES = 5;
  // Exponential backoff: 1s, 3s, 7s, 15s, 30s — handles 429 rate limiting
  const BACKOFF_MS = [1000, 3000, 7000, 15000, 30000];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Add random jitter per attempt to avoid thundering herd across VUs
    if (attempt > 0) {
      const jitter = Math.random() * BACKOFF_MS[attempt - 1];
      sleep(jitter / 1000);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Cookie: `refresh_token=${_refreshToken}`,
    };

    const res = http.post(
      `${config.studioUrl}/api/auth/refresh`,
      JSON.stringify({ refreshToken: _refreshToken }),
      { headers, responseCallback: authResponseCallback, tags: { name: 'auth: refresh' } },
    );

    if (res.status === 200) {
      const data = res.json() as unknown as TokenResponse;
      _accessToken = data.accessToken;
      _expiresAt = getJwtExpiry(data.accessToken);

      // Server may rotate the refresh token — pick up the new one
      const newRefresh =
        extractRefreshTokenFromCookies(res.cookies) ||
        extractRefreshTokenFromHeaders(res.headers) ||
        data.refreshToken ||
        '';
      if (newRefresh) {
        _refreshToken = newRefresh;
      }

      console.log(
        `[auth] Token refreshed (attempt ${attempt + 1}), new expiry: ${new Date(_expiresAt * 1000).toISOString()}`,
      );
      return true;
    }

    if (attempt < MAX_RETRIES - 1) {
      console.warn(
        `[auth] Refresh attempt ${attempt + 1} failed: ${res.status}, retrying in ${BACKOFF_MS[attempt]}ms`,
      );
      sleep(BACKOFF_MS[attempt] / 1000);
    }
  }

  console.warn(`[auth] All ${MAX_RETRIES} refresh attempts failed, trying dev-login fallback`);
  try {
    _doDevLogin();
    return true;
  } catch (e) {
    console.warn(
      `[auth] Dev-login fallback also failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a JWT auth token for benchmark API calls.
 *
 * Priority: AUTH_TOKEN env var (if still valid) → refresh → dev-login.
 * Also captures the refresh token if REFRESH_TOKEN is set or dev-login returns one.
 *
 * Call this in setup() — it runs once per test.
 */
export function getAuthToken(): string {
  // Priority 1: explicit AUTH_TOKEN env var
  if (config.authToken) {
    _accessToken = config.authToken;
    _expiresAt = getJwtExpiry(_accessToken);
    _refreshToken = config.refreshToken;

    // Check if the static AUTH_TOKEN is already expired or about to expire.
    // This happens when the suite runs tests sequentially and later tests
    // start after the original token's TTL (typically 15 min).
    const nowSec = Math.floor(Date.now() / 1000);
    if (_expiresAt > 0 && nowSec >= _expiresAt - REFRESH_BUFFER_SEC) {
      console.warn(
        `[auth] Static AUTH_TOKEN expired or expiring (exp=${new Date(_expiresAt * 1000).toISOString()}), attempting refresh`,
      );

      // Try refresh first
      if (_refreshToken && doRefresh()) {
        return _accessToken;
      }

      // Refresh failed or unavailable — fall back to dev-login
      console.warn('[auth] Refresh failed, falling back to dev-login');
      return _doDevLogin();
    }

    return _accessToken;
  }

  // Priority 2: explicit REFRESH_TOKEN env var — skip dev-login entirely
  if (config.refreshToken) {
    _refreshToken = config.refreshToken;
    console.log('[auth] Using REFRESH_TOKEN from env, calling /api/auth/refresh');
    if (doRefresh()) {
      return _accessToken;
    }
    console.warn('[auth] Refresh with env REFRESH_TOKEN failed, falling back to dev-login');
  }

  // Priority 3: dev-login → refresh flow
  return _doDevLogin();
}

/**
 * Authenticate via the dev-login endpoint.
 *
 * Flow:
 *   1. POST /api/auth/dev-login → returns accessToken + refresh_token in Set-Cookie
 *   2. Extract refresh token for future auto-refresh
 *
 * Updates module-level state with the new tokens.
 */
function _doDevLogin(): string {
  const response = http.post(
    `${config.studioUrl}/api/auth/dev-login`,
    JSON.stringify({
      email: config.devLoginEmail,
      name: config.devLoginName,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
      responseCallback: authResponseCallback,
      tags: { name: 'auth: dev-login' },
    },
  );

  if (response.status !== 200) {
    throw new Error(`Auth failed: ${response.status} ${response.body}`);
  }

  const data = response.json() as unknown as TokenResponse;
  _accessToken = data.accessToken;
  _expiresAt = getJwtExpiry(_accessToken);

  // Refresh token comes from Set-Cookie header, not JSON body.
  // Try cookies jar first, then raw header, then JSON body as fallback.
  const newRefresh =
    extractRefreshTokenFromCookies(response.cookies) ||
    extractRefreshTokenFromHeaders(response.headers) ||
    data.refreshToken ||
    '';
  if (newRefresh) {
    _refreshToken = newRefresh;
  } else if (config.refreshToken) {
    _refreshToken = config.refreshToken;
  }

  if (_refreshToken) {
    console.log(
      `[auth] Refresh token available, auto-refresh enabled (expiry buffer: ${REFRESH_BUFFER_SEC}s)`,
    );
  } else {
    console.warn('[auth] No refresh token found in Set-Cookie header or response body');
  }

  console.log(
    `[auth] Authenticated via dev-login, expiry: ${new Date(_expiresAt * 1000).toISOString()}`,
  );
  return _accessToken;
}

/**
 * Return the current refresh token so it can be passed through setup data.
 * k6 serializes setup() return values to VUs — module-level state is lost.
 * Call this in setup() after getAuthToken() and include the result in SetupData.
 */
export function getRefreshToken(): string {
  return _refreshToken;
}

/**
 * Build authorization headers.
 * Automatically refreshes the access token if it's close to expiry.
 *
 * Call this in VU code before each request (or batch of requests).
 */
export function makeAuthHeaders(token: string, refreshToken?: string): Record<string, string> {
  // In VU context, module state may be uninitialized (setup data is serialized).
  // Hydrate from the passed token so refresh logic can work.
  if (!_accessToken && token) {
    _accessToken = token;
    _expiresAt = getJwtExpiry(token);
    // Prefer the refresh token passed from setup data (survives serialization),
    // fall back to the REFRESH_TOKEN env var.
    _refreshToken = refreshToken || config.refreshToken;
  }

  // Always check for refresh — don't gate on token === _accessToken,
  // because after a refresh _accessToken changes but the `token` param
  // from setup data stays the same, permanently skipping future refreshes.
  if (needsRefresh()) {
    doRefresh();
  }

  // Always use _accessToken (which may have been refreshed), not the
  // stale `token` param from setup data.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${_accessToken || token}`,
    Origin: config.studioUrl,
    'X-Tenant-Id': config.tenantId,
    'X-Load-Test': config.loadTestKey,
  };

  // Include benchmark profile header when configured.
  // The runtime uses this to selectively bypass layers (see BENCHMARK_PROFILE in config).
  if (config.benchmarkProfile) {
    headers['X-Benchmark-Profile'] = config.benchmarkProfile;
  }

  return headers;
}

/**
 * Get the current (possibly refreshed) access token.
 * Use this when you need the raw token value (e.g. for WebSocket URLs).
 *
 * Pass setup data to hydrate VU-local state and trigger refresh if needed.
 */
export function getCurrentToken(data?: { token: string; refreshToken?: string }): string {
  if (data) {
    return ensureFreshAuth(data);
  }

  if (needsRefresh()) {
    doRefresh();
  }
  return _accessToken;
}

/**
 * Ensure VU-local auth state is hydrated and the token is valid.
 *
 * Call this at the **top of every scenario function** — especially late-starting
 * scenarios (startTime >= 5m) where the original setup() token will have expired.
 *
 * On first call within a VU it hydrates module state from setup data.
 * On every call it checks expiry and refreshes proactively.
 *
 * Returns the current valid access token (useful for WebSocket URLs).
 */
export function ensureFreshAuth(data: { token: string; refreshToken?: string }): string {
  // Hydrate VU-local state from setup data if this is the first call
  if (!_accessToken) {
    _accessToken = data.token;
    _expiresAt = getJwtExpiry(data.token);
    _refreshToken = data.refreshToken || config.refreshToken;
  }

  // Proactively refresh if near expiry
  if (needsRefresh()) {
    doRefresh();
  }

  // If token has actually expired (refresh didn't fire or failed),
  // fall back to a full re-auth via dev-login.
  // Call _doDevLogin() directly — getAuthToken() would re-read the stale
  // AUTH_TOKEN env var and loop back to the same expired token.
  if (_expiresAt > 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec >= _expiresAt) {
      console.warn('[auth] Token expired after refresh attempt, re-authenticating via dev-login');
      _accessToken = '';
      _refreshToken = '';
      _expiresAt = 0;
      _doDevLogin();
    }
  }

  return _accessToken;
}

/**
 * Get fresh auth headers, refreshing the token if needed.
 *
 * Use this in VU code instead of `data.headers` for long-running tests.
 * Accepts the setup data object (must have `token` field).
 */
export function freshHeaders(data: {
  token: string;
  refreshToken?: string;
}): Record<string, string> {
  // Ensure token is fresh before building headers
  ensureFreshAuth(data);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${_accessToken}`,
    Origin: config.studioUrl,
    'X-Tenant-Id': config.tenantId,
    'X-Load-Test': config.loadTestKey,
  };

  if (config.benchmarkProfile) {
    headers['X-Benchmark-Profile'] = config.benchmarkProfile;
  }

  return headers;
}
