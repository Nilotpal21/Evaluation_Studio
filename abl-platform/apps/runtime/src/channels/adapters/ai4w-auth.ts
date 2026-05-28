/**
 * AI4W Channel Authentication
 *
 * Dual-layer auth: HMAC (authorization) + JWT (identity).
 * - HMAC proves payload integrity and connection authorization
 * - JWT proves end-user identity (email, accountId)
 *
 * Auth order: check block -> HMAC (cheap) -> JWT (JWKS network call)
 */

import crypto from 'node:crypto';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import { createLogger } from '@abl/compiler/platform';
import { safeFetch } from '@agent-platform/shared-kernel/security/safe-fetch';
import { getRedisClient, isRedisAvailable } from '../../services/redis/redis-client.js';
import type { AI4WJWTClaims } from './ai4w-types.js';

const log = createLogger('ai4w-auth');

// =============================================================================
// ENVIRONMENT CONFIGURATION
// =============================================================================

const AI4W_JWT_AUDIENCE = process.env.AI4W_JWT_AUDIENCE || 'urn:kore:agentic';
const AI4W_HMAC_TIMESTAMP_TOLERANCE_MS = parseInt(
  process.env.AI4W_HMAC_TIMESTAMP_TOLERANCE_MS || '30000',
  10,
);
const AI4W_AUTH_BLOCK_THRESHOLD = parseInt(process.env.AI4W_AUTH_BLOCK_THRESHOLD || '10', 10);
const AI4W_AUTH_BLOCK_DURATION_S = Math.ceil(
  parseInt(process.env.AI4W_AUTH_BLOCK_DURATION_MS || '300000', 10) / 1000,
);

const JOSE_JWT_EXPIRED_CODE = 'ERR_JWT_EXPIRED';
const JOSE_JWT_CLAIM_VALIDATION_CODE = 'ERR_JWT_CLAIM_VALIDATION_FAILED';

// =============================================================================
// TRUSTED ISSUER REGISTRY
// =============================================================================
//
// Multi-issuer JWT verification via OIDC discovery:
//   - Operators list trusted issuers in AI4W_TRUSTED_ISSUERS (comma-separated).
//   - `aud` is single and ABL-controlled (AI4W_JWT_AUDIENCE); AI4W must emit
//     this exact value across every environment.
//
// Registration strategy: LAZY per-issuer registration with single-flight +
// failure cooldown.
//
//   - initAI4WAuth() at startup is config-validation only. It parses the
//     allowlist + JWKS overrides and DOES NOT make network calls. The pod
//     always boots clean even when every upstream issuer is down.
//
//   - On the first JWT for a registered-allowlisted issuer, registerIssuer()
//     runs OIDC discovery (or applies a JWKS override), validates the doc's
//     self-reported `issuer`, and builds a jose createRemoteJWKSet. Concurrent
//     requests share one in-flight Promise (single-flight) so a recovery
//     event does not produce a thundering herd of discovery requests.
//
//   - If registration fails, the failure timestamp is recorded. Subsequent
//     attempts are deferred until AI4W_JWKS_COOLDOWN_MS elapses, then
//     automatically retried on the next request. No pod restart is required
//     for a previously-down issuer to recover. One unhealthy issuer cannot
//     affect verification for the others.

type TrustedIssuer = {
  iss: string;
  jwks: ReturnType<typeof createRemoteJWKSet>;
};

type IssuerConfig = {
  iss: string;
  jwksOverride?: string;
};

const allowedIssuers = new Map<string, IssuerConfig>();
const trustedIssuers = new Map<string, TrustedIssuer>();
const failedRegistrations = new Map<string, { lastAttemptMs: number; error: string }>();
const inflightRegistrations = new Map<string, Promise<TrustedIssuer>>();
let initialized = false;
let initConfig: {
  allowHttp: boolean;
  discoveryTimeoutMs: number;
  jwksCooldownMs: number;
  jwksTimeoutMs: number;
} = {
  allowHttp: false,
  discoveryTimeoutMs: 5000,
  jwksCooldownMs: 30000,
  jwksTimeoutMs: 5000,
};

type OidcDiscoveryDoc = { issuer?: unknown; jwks_uri?: unknown };

function normalizeIssuer(iss: string): string {
  try {
    const url = new URL(iss);
    url.host = url.host.toLowerCase();
    if (url.pathname.endsWith('/') && url.pathname.length > 1) {
      url.pathname = url.pathname.slice(0, -1);
    }
    // new URL keeps a trailing slash when pathname is '/'; strip it for
    // equality with the plain host form the JWT typically carries.
    return url.toString().replace(/\/$/, '');
  } catch {
    return iss.trim();
  }
}

async function fetchOidcDiscovery(
  iss: string,
  timeoutMs: number,
  allowHttp: boolean,
): Promise<OidcDiscoveryDoc> {
  const url = `${iss}/.well-known/openid-configuration`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await safeFetch(
      url,
      {
        signal: controller.signal,
        redirect: 'error',
      },
      {
        maxRedirects: 0,
        allowLocalhost: allowHttp,
        allowPrivateRanges: allowHttp,
      },
    );
    if (!resp.ok) {
      throw new Error(`OIDC discovery ${resp.status} at ${url}`);
    }
    return (await resp.json()) as OidcDiscoveryDoc;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Startup config validation. Must be awaited by server.ts before traffic is
 * served. Pure config parsing — does NOT make any network calls — so it never
 * fails because of an upstream OIDC issuer being unreachable. Subsequent calls
 * are no-ops so tests and hot-reload code paths can invoke it idempotently.
 *
 * The actual OIDC discovery + JWKS resolver creation is deferred to
 * `registerIssuer()`, which runs lazily on the first JWT for that issuer.
 */
export async function initAI4WAuth(): Promise<void> {
  if (initialized) return;

  // Default points at the Kore SaaS OIDC base. Operators add QA/SIT/on-prem
  // issuers by setting AI4W_TRUSTED_ISSUERS to a comma-separated list.
  const issuersRaw = process.env.AI4W_TRUSTED_ISSUERS || 'https://work.kore.ai/oidc';

  const allowHttp = process.env.AI4W_ALLOW_HTTP_ISSUERS === 'true';
  const discoveryTimeoutMs = parseInt(process.env.AI4W_OIDC_DISCOVERY_TIMEOUT_MS || '10000', 10);
  const jwksCooldownMs = parseInt(process.env.AI4W_JWKS_COOLDOWN_MS || '30000', 10);
  const jwksTimeoutMs = parseInt(process.env.AI4W_JWKS_FETCH_TIMEOUT_MS || '10000', 10);

  initConfig = { allowHttp, discoveryTimeoutMs, jwksCooldownMs, jwksTimeoutMs };

  let overrides: Record<string, string> = {};
  const overridesRaw = process.env.AI4W_ISSUER_JWKS_OVERRIDES;
  if (overridesRaw && overridesRaw.trim() !== '') {
    try {
      const parsed = JSON.parse(overridesRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        overrides = parsed as Record<string, string>;
      } else {
        throw new Error('must be a JSON object mapping issuer → jwks_uri');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`AI4W_ISSUER_JWKS_OVERRIDES is malformed: ${message}`);
    }
  }

  const issuers = issuersRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (issuers.length === 0) {
    throw new Error('AI4W_TRUSTED_ISSUERS is empty after trimming.');
  }

  allowedIssuers.clear();
  for (const raw of issuers) {
    const iss = normalizeIssuer(raw);
    if (!iss.startsWith('https://') && !allowHttp) {
      throw new Error(
        `AI4W issuer must use https: ${iss} ` +
          `(set AI4W_ALLOW_HTTP_ISSUERS=true only for local dev).`,
      );
    }
    const jwksOverride = overrides[iss] ?? overrides[raw];
    allowedIssuers.set(iss, {
      iss,
      jwksOverride:
        typeof jwksOverride === 'string' && jwksOverride.length > 0 ? jwksOverride : undefined,
    });
  }

  initialized = true;
  log.info('ai4w-auth: config validated; per-issuer JWKS will register lazily on first use', {
    allowedIssuers: Array.from(allowedIssuers.keys()),
    audience: AI4W_JWT_AUDIENCE,
    cooldownMs: jwksCooldownMs,
  });

  // Best-effort background warmup. We DO NOT await this — the pod is
  // considered initialized once config is validated. If an issuer is
  // reachable now, the first inbound JWT pays no discovery RTT (avoiding
  // the timing-oracle on issuer existence). If unreachable, it falls
  // through to the lazy path with the standard failure cooldown — which
  // is exactly the behavior we'd get without warmup.
  if (process.env.AI4W_DISABLE_WARMUP !== 'true') {
    for (const iss of allowedIssuers.keys()) {
      // recordFailure=false: a transient boot-time outage MUST NOT pre-poison
      // the cooldown cache, otherwise a user request arriving after the
      // upstream has recovered would still be rejected with ISSUER_UNAVAILABLE
      // for the rest of the cooldown window.
      registerIssuer(iss, false).catch((err: unknown) => {
        log.debug('ai4w-auth: background warmup failed (will retry lazily)', {
          iss,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }
}

/**
 * Lazily register an issuer: OIDC discovery (or apply override) + build the
 * JWKS resolver. Successful registration caches the resolver indefinitely.
 * On failure, behavior depends on `recordFailure`:
 *
 *   - `recordFailure: true` (default, user-driven path): the failure is
 *     recorded with a timestamp so subsequent requests within
 *     AI4W_JWKS_COOLDOWN_MS short-circuit to ISSUER_UNAVAILABLE without
 *     hammering a known-bad endpoint.
 *   - `recordFailure: false` (background warmup path): failure is silent.
 *     We do NOT pre-poison the cooldown cache from a startup-time outage
 *     because the user's first request might arrive AFTER the upstream has
 *     recovered, and that request must trigger a fresh discovery rather
 *     than reject from a stale boot-time failure.
 *
 * Single-flight: concurrent calls for the same `iss` share one in-flight
 * Promise so a recovery event does not stampede discovery.
 */
async function registerIssuer(iss: string, recordFailure = true): Promise<TrustedIssuer> {
  const cached = trustedIssuers.get(iss);
  if (cached) return cached;

  const inflight = inflightRegistrations.get(iss);
  if (inflight) return inflight;

  const config = allowedIssuers.get(iss);
  if (!config) {
    throw new AI4WAuthError('WRONG_ISSUER', `JWT issuer not in allowlist: ${iss}`);
  }

  const promise = (async (): Promise<TrustedIssuer> => {
    let jwksUri: string;
    if (config.jwksOverride) {
      jwksUri = config.jwksOverride;
      log.info('ai4w-auth: registering issuer via JWKS override', { iss, jwksUri });
    } else {
      let doc: OidcDiscoveryDoc;
      try {
        doc = await fetchOidcDiscovery(iss, initConfig.discoveryTimeoutMs, initConfig.allowHttp);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`OIDC discovery failed: ${message}`);
      }
      const docIssuer = typeof doc.issuer === 'string' ? normalizeIssuer(doc.issuer) : '';
      if (docIssuer !== iss) {
        // Self-consistency check: a rogue endpoint cannot claim to be someone
        // else's issuer and have its JWKS silently accepted.
        throw new Error(`discovery doc issuer mismatch (doc says "${doc.issuer}")`);
      }
      if (typeof doc.jwks_uri !== 'string' || doc.jwks_uri.length === 0) {
        throw new Error('discovery doc is missing jwks_uri');
      }
      jwksUri = doc.jwks_uri;
    }

    const jwks = createRemoteJWKSet(new URL(jwksUri), {
      timeoutDuration: initConfig.jwksTimeoutMs,
      cooldownDuration: initConfig.jwksCooldownMs,
    });

    const entry: TrustedIssuer = { iss, jwks };
    trustedIssuers.set(iss, entry);
    failedRegistrations.delete(iss);
    log.info('ai4w-auth: trusted issuer registered (lazy)', { iss, jwksUri });
    return entry;
  })();

  inflightRegistrations.set(iss, promise);
  try {
    return await promise;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (recordFailure) {
      failedRegistrations.set(iss, { lastAttemptMs: Date.now(), error: message });
      log.warn('ai4w-auth: issuer registration failed; will retry after cooldown', {
        iss,
        error: message,
        cooldownMs: initConfig.jwksCooldownMs,
      });
    }
    throw err;
  } finally {
    inflightRegistrations.delete(iss);
  }
}

/**
 * Resolve an allowed issuer to a TrustedIssuer entry. Returns the cached
 * entry if registered, attempts lazy registration if not (or if the failure
 * cooldown has elapsed), or rejects with a cached failure if the cooldown
 * has not elapsed.
 */
async function resolveIssuer(iss: string): Promise<TrustedIssuer> {
  const cached = trustedIssuers.get(iss);
  if (cached) return cached;

  if (!allowedIssuers.has(iss)) {
    throw new AI4WAuthError('WRONG_ISSUER', `JWT issuer not in allowlist: ${iss}`);
  }

  const failure = failedRegistrations.get(iss);
  if (failure) {
    const elapsed = Date.now() - failure.lastAttemptMs;
    if (elapsed < initConfig.jwksCooldownMs) {
      throw new AI4WAuthError(
        'ISSUER_UNAVAILABLE',
        `Issuer ${iss} is temporarily unavailable (last error: ${failure.error}; retry in ${
          initConfig.jwksCooldownMs - elapsed
        }ms)`,
      );
    }
  }

  try {
    return await registerIssuer(iss);
  } catch (err: unknown) {
    if (err instanceof AI4WAuthError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AI4WAuthError('ISSUER_UNAVAILABLE', `Issuer ${iss} registration failed: ${message}`);
  }
}

/** Operational visibility: snapshot of issuer registration state. */
export function getAI4WAuthHealth(): {
  initialized: boolean;
  allowed: string[];
  registered: string[];
  failed: { iss: string; lastAttemptMs: number; error: string }[];
} {
  return {
    initialized,
    allowed: Array.from(allowedIssuers.keys()),
    registered: Array.from(trustedIssuers.keys()),
    failed: Array.from(failedRegistrations.entries()).map(([iss, info]) => ({
      iss,
      lastAttemptMs: info.lastAttemptMs,
      error: info.error,
    })),
  };
}

/** Test-only: reset module state between test suites. */
export function __resetAI4WAuthForTests(): void {
  allowedIssuers.clear();
  trustedIssuers.clear();
  failedRegistrations.clear();
  inflightRegistrations.clear();
  initialized = false;
}

/** Static key for dummy HMAC (timing side-channel mitigation) */
const DUMMY_HMAC_KEY = 'ai4w-dummy-hmac-constant-key';

// =============================================================================
// ERROR CLASS
// =============================================================================

export type AI4WAuthErrorCode =
  | 'HMAC_INVALID'
  | 'REPLAY_DETECTED'
  | 'TIMESTAMP_EXPIRED'
  | 'INVALID_TOKEN'
  | 'EXPIRED_TOKEN'
  | 'WRONG_AUDIENCE'
  | 'WRONG_ISSUER'
  | 'ISSUER_UNAVAILABLE'
  | 'ACCOUNT_MISMATCH'
  | 'AUTH_BLOCKED';

/**
 * True if the error represents an upstream-infrastructure failure (the OIDC
 * issuer or its JWKS is unreachable) rather than a client-credential failure.
 * Route handlers must NOT count these toward the auth-block rate limiter:
 * legitimate clients should not be blocked because work-dev's OIDC is down.
 */
export function isInfraAuthError(err: unknown): boolean {
  return err instanceof AI4WAuthError && err.code === 'ISSUER_UNAVAILABLE';
}

export class AI4WAuthError extends Error {
  readonly code: AI4WAuthErrorCode;

  constructor(code: AI4WAuthErrorCode, message: string) {
    super(message);
    this.name = 'AI4WAuthError';
    this.code = code;
  }
}

function getJoseErrorDetails(err: unknown): { code?: string; claim?: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);

  if (err === null || typeof err !== 'object') {
    return { message };
  }

  const maybeJoseError = err as { code?: unknown; claim?: unknown };

  return {
    code: typeof maybeJoseError.code === 'string' ? maybeJoseError.code : undefined,
    claim: typeof maybeJoseError.claim === 'string' ? maybeJoseError.claim : undefined,
    message,
  };
}

// =============================================================================
// HMAC VERIFICATION
// =============================================================================

export function verifyHmac(
  rawBody: Buffer,
  connectionSecret: string,
  requestId: string,
  timestamp: string,
  signature: string,
): boolean {
  try {
    const payload = `inbound:${requestId}.${timestamp}.${rawBody.toString('utf8')}`;
    const expected = crypto.createHmac('sha256', connectionSecret).update(payload).digest('hex');

    const received = signature.startsWith('sha256=') ? signature.slice(7) : signature;

    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
  } catch (err: unknown) {
    log.debug('HMAC verification error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// =============================================================================
// TIMESTAMP VALIDATION
// =============================================================================

export function validateTimestamp(timestamp: string): boolean {
  let ts: number;

  const parsed = Date.parse(timestamp);
  if (!Number.isNaN(parsed)) {
    ts = parsed;
  } else {
    const epoch = Number(timestamp);
    if (Number.isNaN(epoch)) return false;
    // Treat as Unix epoch seconds
    ts = epoch * 1000;
  }

  const drift = Math.abs(Date.now() - ts);
  return drift <= AI4W_HMAC_TIMESTAMP_TOLERANCE_MS;
}

// =============================================================================
// REPLAY PROTECTION
// =============================================================================

export async function checkReplay(connectionId: string, requestId: string): Promise<boolean> {
  if (!isRedisAvailable()) {
    log.warn('Redis unavailable — skipping replay check (fail open)', { connectionId });
    return true;
  }

  const redis = getRedisClient();
  if (!redis) return true;

  const key = `ai4w:nonce:${connectionId}:${requestId}`;
  const result = await redis.set(key, '1', 'EX', 60, 'NX');
  // SET NX returns 'OK' if the key was set (nonce is new), null if it already exists (replay)
  return result === 'OK';
}

// =============================================================================
// JWT VERIFICATION
// =============================================================================

export async function verifyAI4WJWT(token: string): Promise<AI4WJWTClaims> {
  if (!initialized) {
    throw new Error('ai4w-auth not initialized — call initAI4WAuth() at startup');
  }

  // Decode (without verifying) to route to the right issuer's JWKS.
  let rawIss: string;
  try {
    const decoded = decodeJwt(token);
    rawIss = String(decoded.iss ?? '');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AI4WAuthError('INVALID_TOKEN', `Malformed JWT: ${message}`);
  }

  // Resolve (or lazily register) this issuer's JWKS. Allowlist enforcement and
  // failure-cooldown are handled inside resolveIssuer.
  // - Not in allowlist  → AI4WAuthError(WRONG_ISSUER)         — client problem
  // - Cooldown active   → AI4WAuthError(ISSUER_UNAVAILABLE)   — our problem
  // - Registration fails → AI4WAuthError(ISSUER_UNAVAILABLE)  — our problem
  const trusted = await resolveIssuer(normalizeIssuer(rawIss));

  try {
    const { payload } = await jwtVerify(token, trusted.jwks, {
      audience: AI4W_JWT_AUDIENCE,
      issuer: trusted.iss,
    });

    // Identity claims must be non-empty. We rely on `email` for end-user identity
    // (session keys, tenant-membership lookup) and on `sub`/`accountId` for
    // connection binding. A token that omits any of these would collapse
    // multiple end-users onto the same identity downstream — reject at the
    // verification boundary so no caller can pass a credential-less token.
    const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    const email = typeof payload.email === 'string' ? payload.email.trim() : '';
    const accountId = typeof payload.accountId === 'string' ? payload.accountId.trim() : '';
    if (!sub || !email || !accountId) {
      throw new AI4WAuthError(
        'INVALID_TOKEN',
        'JWT missing required identity claim (sub, email, accountId)',
      );
    }

    return {
      sub,
      email,
      accountId,
      iss: String(payload.iss ?? ''),
      aud: String(payload.aud ?? ''),
      scope: payload.scope != null ? String(payload.scope) : undefined,
      product: payload.product != null ? String(payload.product) : undefined,
      iat: Number(payload.iat ?? 0),
      exp: Number(payload.exp ?? 0),
    };
  } catch (err: unknown) {
    const { code, claim, message } = getJoseErrorDetails(err);

    if (code === JOSE_JWT_EXPIRED_CODE || claim === 'exp' || message.includes('expired')) {
      throw new AI4WAuthError('EXPIRED_TOKEN', `JWT expired: ${message}`);
    }
    if (
      (code === JOSE_JWT_CLAIM_VALIDATION_CODE && claim === 'aud') ||
      message.includes('audience')
    ) {
      throw new AI4WAuthError('WRONG_AUDIENCE', `JWT audience mismatch: ${message}`);
    }
    throw new AI4WAuthError('INVALID_TOKEN', `JWT verification failed: ${message}`);
  }
}

// =============================================================================
// ACCOUNT ID BINDING
// =============================================================================

export async function enforceAccountIdBinding(
  connectionDbId: string,
  tenantId: string,
  currentAccountId: string | null,
  jwtAccountId: string,
): Promise<'bound' | 'matched' | 'mismatch'> {
  if (currentAccountId === jwtAccountId) return 'matched';

  if (currentAccountId === null) {
    const { ChannelConnection } = await import('@agent-platform/database/models');
    const updated = await ChannelConnection.findOneAndUpdate(
      { _id: connectionDbId, tenantId, 'config.ai4wAccountId': null },
      { $set: { 'config.ai4wAccountId': jwtAccountId } },
      { new: true },
    );
    if (!updated) {
      // Race: another request already bound a different accountId
      const current = await ChannelConnection.findOne(
        { _id: connectionDbId, tenantId },
        { 'config.ai4wAccountId': 1 },
      );
      return current?.config?.ai4wAccountId === jwtAccountId ? 'matched' : 'mismatch';
    }
    return 'bound';
  }

  return 'mismatch';
}

// =============================================================================
// AUTH BLOCK CHECK
// =============================================================================

export async function checkAuthBlock(sourceIp: string, connectionId: string): Promise<boolean> {
  if (!isRedisAvailable()) return false;

  const redis = getRedisClient();
  if (!redis) return false;

  const key = `ai4w:auth:block:${sourceIp}:${connectionId}`;
  const result = await redis.get(key);
  return result !== null;
}

// =============================================================================
// AUTH FAILURE RECORDING
// =============================================================================

export async function recordAuthFailure(sourceIp: string, connectionId: string): Promise<void> {
  if (!isRedisAvailable()) return;

  const redis = getRedisClient();
  if (!redis) return;

  const failKey = `ai4w:auth:fail:${sourceIp}:${connectionId}`;
  const count = await redis.incr(failKey);

  if (count === 1) {
    await redis.expire(failKey, 60);
  }

  if (count >= AI4W_AUTH_BLOCK_THRESHOLD) {
    const blockKey = `ai4w:auth:block:${sourceIp}:${connectionId}`;
    await redis.set(blockKey, '1', 'EX', AI4W_AUTH_BLOCK_DURATION_S);
    log.warn('Auth blocked due to repeated failures', {
      sourceIp,
      connectionId,
      failureCount: count,
      blockDurationSeconds: AI4W_AUTH_BLOCK_DURATION_S,
    });
  }
}

// =============================================================================
// TIMING SIDE-CHANNEL MITIGATION
// =============================================================================

export function timingSafeDummyHmac(): void {
  crypto.createHmac('sha256', DUMMY_HMAC_KEY).update('dummy-payload').digest('hex');
}

// =============================================================================
// OUTBOUND SIGNATURE
// =============================================================================

export function buildOutboundSignatureHeaders(
  connectionSecret: string,
  body: string | Buffer,
): Record<string, string> {
  // Dedicated HMAC nonce header. Tracing-namespace headers like X-Request-Id are
  // routinely rewritten by ingress-nginx (`proxy_set_header X-Request-Id $req_id`),
  // service meshes, and APIMs, which silently breaks any signature that includes
  // them. X-Signature-Nonce is application-namespaced and must be passed through
  // untouched.
  const nonce = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const bodyStr = typeof body === 'string' ? body : body.toString('utf8');

  const payload = `outbound:${nonce}.${timestamp}.${bodyStr}`;
  const signature = crypto.createHmac('sha256', connectionSecret).update(payload).digest('hex');

  return {
    'X-Signature-Nonce': nonce,
    'X-Timestamp': timestamp,
    'X-Signature': `sha256=${signature}`,
  };
}
