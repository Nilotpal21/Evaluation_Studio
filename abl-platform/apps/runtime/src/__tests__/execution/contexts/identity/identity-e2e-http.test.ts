/**
 * Identity Verification E2E HTTP Tests
 *
 * Exercises the full identity verification HTTP API with real Express servers,
 * real verifier implementations, and a real RedisVerificationTokenStore backed
 * by an in-memory RedisLike implementation. No vi.mock() — only external
 * third-party services (OAuthProviderAdapter) are replaced with test doubles
 * that implement the interface directly.
 *
 * Test scenarios cover: HMAC, OTP, OAuth, webhook flows, input validation,
 * rate limiting, and cross-tenant isolation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';

import { createIdentityVerificationRouter } from '../../../../routes/identity-verification.js';
import type { IdentityVerificationRouterDeps } from '../../../../routes/identity-verification.js';
import { VerifyIdentity } from '../../../../contexts/identity/use-cases/verify-identity.js';
import { RedisVerificationTokenStore } from '../../../../contexts/identity/infrastructure/redis-verification-token-store.js';
import type { RedisLike } from '../../../../contexts/identity/infrastructure/redis-verification-token-store.js';
import { HmacVerifier } from '../../../../contexts/identity/infrastructure/verifiers/hmac-verifier.js';
import { OtpVerifier } from '../../../../contexts/identity/infrastructure/verifiers/otp-verifier.js';
import { OAuthVerifier } from '../../../../contexts/identity/infrastructure/verifiers/oauth-verifier.js';
import type { OAuthProviderAdapter } from '../../../../contexts/identity/infrastructure/verifiers/oauth-verifier.js';
import { WebhookVerifier } from '../../../../contexts/identity/infrastructure/verifiers/webhook-verifier.js';
import type { SendChallengeFn } from '../../../../contexts/identity/infrastructure/verifiers/webhook-verifier.js';
import type {
  IdentityVerifier,
  VerificationProof,
  VerificationResult,
} from '../../../../contexts/identity/domain/identity-verifier.js';
import type { VerificationMethod } from '@agent-platform/shared-auth';

// =============================================================================
// CONSTANTS
// =============================================================================

const HMAC_SECRET_KEY = 'e2e-test-hmac-secret-key-for-identity';
const OTP_HMAC_SECRET = 'e2e-test-otp-hmac-secret';
const WEBHOOK_HMAC_KEY = 'e2e-test-webhook-hmac-key';

// =============================================================================
// IN-MEMORY REDIS IMPLEMENTATION (implements RedisLike from redis-verification-token-store)
// =============================================================================

/**
 * In-memory implementation of the RedisLike interface used by RedisVerificationTokenStore.
 * Uses a Map for storage with TTL tracking. Implements the `eval` method required for
 * Lua script operations (incrementAttempts, markVerified).
 */
class InMemoryRedis implements RedisLike {
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<string | null> {
    let expiresAt: number | null = null;
    // Parse EX (seconds) argument: set(key, value, 'EX', ttlSeconds)
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'EX' && typeof args[i + 1] === 'number') {
        expiresAt = Date.now() + (args[i + 1] as number) * 1000;
        break;
      }
    }
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  /**
   * Simulates Redis EVAL for the two Lua scripts used by RedisVerificationTokenStore:
   * - INCREMENT_ATTEMPTS_LUA: increments the `attempts` field
   * - MARK_VERIFIED_LUA: sets `status` to 'verified'
   *
   * Detects the script intent by inspecting the script text.
   */
  async eval(script: string, _numkeys: number, ...args: (string | number)[]): Promise<unknown> {
    const key = args[0] as string;
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    const obj = JSON.parse(entry.value);

    if (script.includes("obj['attempts']")) {
      // INCREMENT_ATTEMPTS_LUA
      obj.attempts = (obj.attempts ?? 0) + 1;
      entry.value = JSON.stringify(obj);
      return obj.attempts;
    }

    if (script.includes("obj['status'] = 'verified'")) {
      // MARK_VERIFIED_LUA
      obj.status = 'verified';
      entry.value = JSON.stringify(obj);
      return 1;
    }

    return null;
  }

  /**
   * Force-expire a key by setting its expiresAt to the past.
   * Simulates Redis TTL expiry without waiting real wall-clock time.
   */
  forceExpire(key: string): void {
    const entry = this.store.get(key);
    if (entry) {
      entry.expiresAt = Date.now() - 1;
    }
  }

  /**
   * Returns all stored keys (for testing/debugging).
   */
  keys(): string[] {
    return Array.from(this.store.keys());
  }
}

// =============================================================================
// MOCK OAUTH PROVIDER (external third-party service — OK to mock)
// =============================================================================

class TestOAuthProvider implements OAuthProviderAdapter {
  /** The email that will be returned by fetchUserEmail. */
  public verifiedEmail = 'oauth-user@example.com';

  /** The state value from the last createAuthorizationURL call. */
  public lastState = '';

  /** The code verifier from the last createAuthorizationURL call. */
  public lastCodeVerifier = '';

  createAuthorizationURL(state: string, codeVerifier: string): URL {
    this.lastState = state;
    this.lastCodeVerifier = codeVerifier;
    return new URL(`https://oauth.example.com/authorize?state=${state}`);
  }

  async validateAuthorizationCode(
    _code: string,
    _codeVerifier: string,
  ): Promise<{ accessToken: string }> {
    return { accessToken: 'test-access-token-123' };
  }

  async fetchUserEmail(_accessToken: string): Promise<string> {
    return this.verifiedEmail;
  }
}

// =============================================================================
// HELPER: Build an Express app with identity verification routes
// =============================================================================

interface TestAppContext {
  app: express.Application;
  redis: InMemoryRedis;
  tokenStore: RedisVerificationTokenStore;
  oauthProvider: TestOAuthProvider;
  verifiers: Map<VerificationMethod, IdentityVerifier>;
  sendChallengeFn: SendChallengeFn;
}

function buildTestApp(opts?: {
  customSendChallenge?: SendChallengeFn;
  /**
   * Which verification methods to register. Defaults to all.
   * The VerifyIdentity use case iterates verifiers in insertion order and picks
   * the first whose supports() returns true. Since OTP and OAuth both return
   * true for any input, tests that need a specific verifier should include only
   * the methods they exercise.
   */
  methods?: VerificationMethod[];
}): TestAppContext {
  const redis = new InMemoryRedis();
  const tokenStore = new RedisVerificationTokenStore(() => redis);
  const oauthProvider = new TestOAuthProvider();

  const sendChallengeFn: SendChallengeFn =
    opts?.customSendChallenge ?? (async () => ({ success: true }));

  // Build all verifiers
  const allVerifiers: Record<string, IdentityVerifier> = {
    hmac: new HmacVerifier(HMAC_SECRET_KEY),
    otp: new OtpVerifier(tokenStore, OTP_HMAC_SECRET),
    oauth: new OAuthVerifier(tokenStore, oauthProvider),
    webhook: new WebhookVerifier(tokenStore, sendChallengeFn, WEBHOOK_HMAC_KEY, {
      allowPrivateUrls: true,
    }),
  };

  // Register only requested methods (default: all, with metadata-specific first)
  const methodsToInclude = opts?.methods ?? ['hmac', 'webhook', 'otp', 'oauth'];
  const verifiers = new Map<VerificationMethod, IdentityVerifier>();
  for (const method of methodsToInclude) {
    if (allVerifiers[method]) {
      verifiers.set(method as VerificationMethod, allVerifiers[method]);
    }
  }

  const verifyIdentity = new VerifyIdentity(verifiers);

  // completeVerification: reads stored attempt, dispatches to the correct verifier
  const completeVerification = async (
    attemptId: string,
    proof: VerificationProof,
  ): Promise<VerificationResult> => {
    const tenantId = (proof.metadata?.tenantId as string) ?? '';
    const stored = await tokenStore.get(tenantId, attemptId);
    if (!stored) {
      return {
        success: false,
        error: { code: 'ATTEMPT_NOT_FOUND', message: 'Verification attempt not found' },
      };
    }
    const verifier = verifiers.get(stored.method as VerificationMethod);
    if (!verifier) {
      return {
        success: false,
        error: { code: 'NO_VERIFIER', message: 'No verifier for method' },
      };
    }
    return verifier.complete(attemptId, proof);
  };

  const deps: IdentityVerificationRouterDeps = {
    verifyIdentity,
    tokenStore,
    completeVerification,
  };

  const app = express();
  app.use(express.json());

  // Auth middleware: reads tenant context from headers (test helper, not a mock)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const tenantId = req.headers['x-tenant-id'] as string | undefined;
    const sessionId = req.headers['x-session-id'] as string | undefined;
    const projectId = req.headers['x-project-id'] as string | undefined;
    const sessionPrincipal = req.headers['x-session-principal'] as string | undefined;
    if (tenantId) {
      (req as any).tenantContext = {
        tenantId,
        projectId: projectId ?? 'project-test',
        sessionId: sessionId ?? '',
        sessionPrincipal: sessionPrincipal ?? sessionId ?? '',
        authType: 'sdk_session',
        authScope: 'session',
        userId: sessionPrincipal ?? sessionId ?? 'sdk-session-test',
        role: 'sdk_session',
        permissions: ['session:send_message'],
        isSuperAdmin: false,
      };
    }
    next();
  });

  const router = createIdentityVerificationRouter(deps);
  app.use('/api/identity/verify', router);

  return { app, redis, tokenStore, oauthProvider, verifiers, sendChallengeFn };
}

// =============================================================================
// HELPER: Start server on random port
// =============================================================================

async function startServer(app: express.Application): Promise<{
  server: http.Server;
  baseUrl: string;
}> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({ server, baseUrl });
    });
  });
}

// =============================================================================
// HELPER: HTTP request utility
// =============================================================================

async function httpRequest(
  baseUrl: string,
  method: string,
  path: string,
  opts?: { body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...opts?.headers,
  };

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// =============================================================================
// HELPER: Generate valid HMAC
// =============================================================================

function makeValidHmac(userId: string, timestamp: number): string {
  return createHmac('sha256', HMAC_SECRET_KEY).update(`${userId}:${timestamp}`).digest('hex');
}

function currentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

// =============================================================================
// E2E-1: HMAC Verification via HTTP API
// =============================================================================

describe('E2E-1: HMAC Verification via HTTP API', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const ctx = buildTestApp({ methods: ['hmac'] });
    const srv = await startServer(ctx.app);
    server = srv.server;
    baseUrl = srv.baseUrl;
  });

  afterAll(() => {
    server?.close();
  });

  const authHeaders = { 'x-tenant-id': 'tenant-hmac', 'x-session-id': 'sess-hmac-1' };

  it('succeeds with valid HMAC signature', async () => {
    const userId = 'hmac-user@example.com';
    const ts = currentTimestamp();
    const hmac = makeValidHmac(userId, ts);

    const { status, body } = await httpRequest(baseUrl, 'POST', '/api/identity/verify/initiate', {
      headers: authHeaders,
      body: {
        method: 'hmac',
        identityValue: userId,
        identityType: 'cookie',
        metadata: { hmac, timestamp: ts },
      },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('fails with invalid HMAC signature', async () => {
    const userId = 'hmac-user@example.com';
    const ts = currentTimestamp();
    // Generate HMAC with wrong key
    const wrongHmac = createHmac('sha256', 'wrong-secret').update(`${userId}:${ts}`).digest('hex');

    const { status, body } = await httpRequest(baseUrl, 'POST', '/api/identity/verify/initiate', {
      headers: authHeaders,
      body: {
        method: 'hmac',
        identityValue: userId,
        identityType: 'cookie',
        metadata: { hmac: wrongHmac, timestamp: ts },
      },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('HMAC_INVALID');
  });

  it('returns 401 without auth headers', async () => {
    const userId = 'hmac-user@example.com';
    const ts = currentTimestamp();
    const hmac = makeValidHmac(userId, ts);

    const { status, body } = await httpRequest(baseUrl, 'POST', '/api/identity/verify/initiate', {
      body: {
        method: 'hmac',
        identityValue: userId,
        identityType: 'cookie',
        metadata: { hmac, timestamp: ts },
      },
    });

    expect(status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });
});

// =============================================================================
// E2E-2: OTP Complete Flow
// =============================================================================

describe('E2E-2: OTP Complete Flow', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const ctx = buildTestApp({ methods: ['otp'] });
    const srv = await startServer(ctx.app);
    server = srv.server;
    baseUrl = srv.baseUrl;
  });

  afterAll(() => {
    server?.close();
  });

  const authHeaders = { 'x-tenant-id': 'tenant-otp', 'x-session-id': 'sess-otp-1' };

  it('full OTP flow: initiate -> check status -> complete -> verified', async () => {
    // Step 1: Initiate OTP
    const initRes = await httpRequest(baseUrl, 'POST', '/api/identity/verify/initiate', {
      headers: authHeaders,
      body: {
        method: 'otp',
        identityValue: 'otp-user@example.com',
        identityType: 'email_thread',
      },
    });

    expect(initRes.status).toBe(200);
    expect(initRes.body.success).toBe(true);
    expect(initRes.body.attemptId).toBeDefined();
    expect(initRes.body.challengeData).toBeDefined();
    expect(initRes.body.challengeData.userAction).toBe('enter_otp');
    expect(initRes.body.challengeData.code).toBeDefined();
    expect(typeof initRes.body.challengeData.code).toBe('string');

    const attemptId = initRes.body.attemptId;
    const otpCode = initRes.body.challengeData.code;

    // Step 2: Check status (should be pending)
    const statusRes = await httpRequest(baseUrl, 'GET', `/api/identity/verify/${attemptId}`, {
      headers: authHeaders,
    });

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.success).toBe(true);
    expect(statusRes.body.data.status).toBe('pending');
    expect(statusRes.body.data.attemptId).toBe(attemptId);
    expect(statusRes.body.data.method).toBe('otp');

    // Step 3: Complete with correct OTP code
    const completeRes = await httpRequest(baseUrl, 'POST', '/api/identity/verify/complete', {
      headers: authHeaders,
      body: {
        attemptId,
        proof: {
          type: 'otp_code',
          value: otpCode,
          metadata: { tenantId: 'tenant-otp' },
        },
      },
    });

    expect(completeRes.status).toBe(200);
    expect(completeRes.body.success).toBe(true);
    expect(completeRes.body.identityTier).toBe(2);
    expect(completeRes.body.verifiedIdentity).toBe('otp-user@example.com');

    // Step 4: Check status (should be verified)
    const verifiedStatusRes = await httpRequest(
      baseUrl,
      'GET',
      `/api/identity/verify/${attemptId}`,
      { headers: authHeaders },
    );

    expect(verifiedStatusRes.status).toBe(200);
    expect(verifiedStatusRes.body.data.status).toBe('verified');
  });
});

// =============================================================================
// E2E-3: OTP Rate Limiting
// =============================================================================

describe('E2E-3: OTP Rate Limiting & TTL Expiry', () => {
  let server: http.Server;
  let baseUrl: string;
  let redis: InMemoryRedis;

  beforeAll(async () => {
    const ctx = buildTestApp({ methods: ['otp'] });
    redis = ctx.redis;
    const srv = await startServer(ctx.app);
    server = srv.server;
    baseUrl = srv.baseUrl;
  });

  afterAll(() => {
    server?.close();
  });

  const authHeaders = { 'x-tenant-id': 'tenant-rate', 'x-session-id': 'sess-rate-1' };

  it('enforces max 5 attempts and blocks further submissions', async () => {
    // Step 1: Initiate OTP
    const initRes = await httpRequest(baseUrl, 'POST', '/api/identity/verify/initiate', {
      headers: authHeaders,
      body: {
        method: 'otp',
        identityValue: 'rate-limit@example.com',
        identityType: 'email_thread',
      },
    });

    expect(initRes.body.success).toBe(true);
    const attemptId = initRes.body.attemptId;

    // Step 2: Submit 5 wrong codes (max attempts = 5)
    for (let i = 0; i < 5; i++) {
      const wrongRes = await httpRequest(baseUrl, 'POST', '/api/identity/verify/complete', {
        headers: authHeaders,
        body: {
          attemptId,
          proof: {
            type: 'otp_code',
            value: '000000',
            metadata: { tenantId: 'tenant-rate' },
          },
        },
      });

      expect(wrongRes.body.success).toBe(false);
      expect(wrongRes.body.error.code).toBe('OTP_INVALID');
    }

    // Step 3: 6th attempt should be rate-limited
    const blockedRes = await httpRequest(baseUrl, 'POST', '/api/identity/verify/complete', {
      headers: authHeaders,
      body: {
        attemptId,
        proof: {
          type: 'otp_code',
          value: '999999',
          metadata: { tenantId: 'tenant-rate' },
        },
      },
    });

    expect(blockedRes.body.success).toBe(false);
    expect(blockedRes.body.error.code).toBe('OTP_MAX_ATTEMPTS');
  });

  it('returns 404 for expired attempts after TTL cleanup', async () => {
    // Step 1: Initiate a new OTP attempt
    const initRes = await httpRequest(baseUrl, 'POST', '/api/identity/verify/initiate', {
      headers: authHeaders,
      body: {
        method: 'otp',
        identityValue: 'ttl-test@example.com',
        identityType: 'email_thread',
      },
    });

    expect(initRes.body.success).toBe(true);
    const attemptId = initRes.body.attemptId;

    // Step 2: Verify the attempt is accessible before expiry
    const beforeExpiry = await httpRequest(baseUrl, 'GET', `/api/identity/verify/${attemptId}`, {
      headers: authHeaders,
    });
    expect(beforeExpiry.status).toBe(200);
    expect(beforeExpiry.body.data.status).toBe('pending');

    // Step 3: Force-expire the Redis key to simulate TTL cleanup
    const redisKeys = redis.keys().filter((k) => k.includes(attemptId));
    expect(redisKeys.length).toBeGreaterThan(0);
    for (const key of redisKeys) {
      redis.forceExpire(key);
    }

    // Step 4: GET should now return 404 — the store returns null for expired keys
    const afterExpiry = await httpRequest(baseUrl, 'GET', `/api/identity/verify/${attemptId}`, {
      headers: authHeaders,
    });
    expect(afterExpiry.status).toBe(404);
    expect(afterExpiry.body.success).toBe(false);
    expect(afterExpiry.body.error.code).toBe('NOT_FOUND');

    // Step 5: Attempting to complete an expired attempt should also fail
    const completeExpired = await httpRequest(baseUrl, 'POST', '/api/identity/verify/complete', {
      headers: authHeaders,
      body: {
        attemptId,
        proof: {
          type: 'otp_code',
          value: '123456',
          metadata: { tenantId: 'tenant-rate' },
        },
      },
    });
    expect(completeExpired.body.success).toBe(false);
    expect(completeExpired.body.error.code).toBe('ATTEMPT_NOT_FOUND');
  });
});

// =============================================================================
// E2E-4: Cross-Tenant Isolation
// =============================================================================

describe('E2E-4: Cross-Tenant Isolation', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const ctx = buildTestApp({ methods: ['otp'] });
    const srv = await startServer(ctx.app);
    server = srv.server;
    baseUrl = srv.baseUrl;
  });

  afterAll(() => {
    server?.close();
  });

  const tenantAHeaders = { 'x-tenant-id': 'tenant-A', 'x-session-id': 'sess-A-1' };
  const tenantBHeaders = { 'x-tenant-id': 'tenant-B', 'x-session-id': 'sess-B-1' };

  it('tenant-B cannot access or complete tenant-A OTP attempts', async () => {
    // Step 1: Tenant-A initiates OTP
    const initRes = await httpRequest(baseUrl, 'POST', '/api/identity/verify/initiate', {
      headers: tenantAHeaders,
      body: {
        method: 'otp',
        identityValue: 'cross-tenant@example.com',
        identityType: 'email_thread',
      },
    });

    expect(initRes.body.success).toBe(true);
    const attemptId = initRes.body.attemptId;
    const otpCode = initRes.body.challengeData.code;

    // Step 2: Tenant-A can see the attempt (200 pending)
    const tenantAStatus = await httpRequest(baseUrl, 'GET', `/api/identity/verify/${attemptId}`, {
      headers: tenantAHeaders,
    });

    expect(tenantAStatus.status).toBe(200);
    expect(tenantAStatus.body.data.status).toBe('pending');

    // Step 3: Tenant-B cannot see the attempt (404)
    const tenantBStatus = await httpRequest(baseUrl, 'GET', `/api/identity/verify/${attemptId}`, {
      headers: tenantBHeaders,
    });

    expect(tenantBStatus.status).toBe(404);
    expect(tenantBStatus.body.error.code).toBe('NOT_FOUND');

    const wrongProjectStatus = await httpRequest(
      baseUrl,
      'GET',
      `/api/identity/verify/${attemptId}`,
      {
        headers: {
          ...tenantAHeaders,
          'x-project-id': 'project-other',
        },
      },
    );

    expect(wrongProjectStatus.status).toBe(404);
    expect(wrongProjectStatus.body.error.code).toBe('NOT_FOUND');

    const wrongPrincipalStatus = await httpRequest(
      baseUrl,
      'GET',
      `/api/identity/verify/${attemptId}`,
      {
        headers: {
          ...tenantAHeaders,
          'x-session-principal': 'sdk-session-wrong',
        },
      },
    );

    expect(wrongPrincipalStatus.status).toBe(404);
    expect(wrongPrincipalStatus.body.error.code).toBe('NOT_FOUND');

    // Step 4: Tenant-B cannot complete the attempt
    const tenantBComplete = await httpRequest(baseUrl, 'POST', '/api/identity/verify/complete', {
      headers: tenantBHeaders,
      body: {
        attemptId,
        proof: {
          type: 'otp_code',
          value: otpCode,
          metadata: { tenantId: 'tenant-B' },
        },
      },
    });

    expect(tenantBComplete.body.success).toBe(false);

    // Step 5: Tenant-A can complete successfully
    const tenantAComplete = await httpRequest(baseUrl, 'POST', '/api/identity/verify/complete', {
      headers: tenantAHeaders,
      body: {
        attemptId,
        proof: {
          type: 'otp_code',
          value: otpCode,
          metadata: { tenantId: 'tenant-A' },
        },
      },
    });

    expect(tenantAComplete.body.success).toBe(true);
    expect(tenantAComplete.body.identityTier).toBe(2);
  });
});

// =============================================================================
// E2E-5: OAuth Flow
// =============================================================================

describe('E2E-5: OAuth Flow', () => {
  let server: http.Server;
  let baseUrl: string;
  let oauthProvider: TestOAuthProvider;
  let tokenStore: RedisVerificationTokenStore;

  beforeAll(async () => {
    const ctx = buildTestApp({ methods: ['oauth'] });
    oauthProvider = ctx.oauthProvider;
    tokenStore = ctx.tokenStore;
    const srv = await startServer(ctx.app);
    server = srv.server;
    baseUrl = srv.baseUrl;
  });

  afterAll(() => {
    server?.close();
  });

  const authHeaders = { 'x-tenant-id': 'tenant-oauth', 'x-session-id': 'sess-oauth-1' };

  it('full OAuth flow: initiate -> redirect URL -> complete with token', async () => {
    // Step 1: Initiate OAuth — only OAuth verifier is registered for this test
    const initRes = await httpRequest(baseUrl, 'POST', '/api/identity/verify/initiate', {
      headers: authHeaders,
      body: {
        method: 'oauth',
        identityValue: 'oauth-user@example.com',
        identityType: 'email_thread',
        metadata: { provider: 'google' },
      },
    });

    expect(initRes.status).toBe(200);
    expect(initRes.body.success).toBe(true);
    expect(initRes.body.attemptId).toBeDefined();
    expect(initRes.body.challengeData).toBeDefined();
    expect(initRes.body.challengeData.userAction).toBe('redirect');
    expect(initRes.body.challengeData.redirectUrl).toContain('https://oauth.example.com/authorize');

    const attemptId = initRes.body.attemptId;

    // Step 2: Read the stored attempt to get the state parameter
    const stored = await tokenStore.get('tenant-oauth', attemptId);
    expect(stored).not.toBeNull();
    const { state } = JSON.parse(stored!.codeHash);

    // Step 3: Complete OAuth with the mock token and state
    const completeRes = await httpRequest(baseUrl, 'POST', '/api/identity/verify/complete', {
      headers: authHeaders,
      body: {
        attemptId,
        proof: {
          type: 'oauth_token',
          value: 'auth-code-from-provider',
          metadata: { tenantId: 'tenant-oauth', state },
        },
      },
    });

    expect(completeRes.status).toBe(200);
    expect(completeRes.body.success).toBe(true);
    expect(completeRes.body.identityTier).toBe(2);
    expect(completeRes.body.verifiedIdentity).toBe('oauth-user@example.com');
  });
});

// =============================================================================
// E2E-6: Input Validation
// =============================================================================

describe('E2E-6: Input Validation', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const ctx = buildTestApp();
    const srv = await startServer(ctx.app);
    server = srv.server;
    baseUrl = srv.baseUrl;
  });

  afterAll(() => {
    server?.close();
  });

  const authHeaders = { 'x-tenant-id': 'tenant-val', 'x-session-id': 'sess-val-1' };

  it('POST /initiate with empty body returns 400 INVALID_INPUT', async () => {
    const { status, body } = await httpRequest(baseUrl, 'POST', '/api/identity/verify/initiate', {
      headers: authHeaders,
      body: {},
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_INPUT');
  });

  it('POST /complete with empty body returns 400 INVALID_INPUT', async () => {
    const { status, body } = await httpRequest(baseUrl, 'POST', '/api/identity/verify/complete', {
      headers: authHeaders,
      body: {},
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_INPUT');
  });

  it('POST /complete with nonexistent attemptId returns error', async () => {
    const { status, body } = await httpRequest(baseUrl, 'POST', '/api/identity/verify/complete', {
      headers: authHeaders,
      body: {
        attemptId: 'nonexistent-attempt-id',
        proof: {
          type: 'otp_code',
          value: '123456',
          metadata: { tenantId: 'tenant-val' },
        },
      },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('ATTEMPT_NOT_FOUND');
  });

  it('GET /nonexistent-uuid returns 404', async () => {
    const { status, body } = await httpRequest(
      baseUrl,
      'GET',
      '/api/identity/verify/00000000-0000-0000-0000-000000000000',
      { headers: authHeaders },
    );

    expect(status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

// =============================================================================
// E2E-7: Webhook Flow
// =============================================================================

describe('E2E-7: Webhook Flow', () => {
  let mainServer: http.Server;
  let mainBaseUrl: string;
  let webhookServer: http.Server;
  let webhookBaseUrl: string;
  let capturedChallenges: Array<{
    identityValue: string;
    challenge: string;
    tenantId: string;
    sessionId: string;
  }>;

  beforeAll(async () => {
    capturedChallenges = [];

    // Start a test webhook capture server on a random port
    const webhookApp = express();
    webhookApp.use(express.json());
    webhookApp.post('/webhook/verify', (req: Request, res: Response) => {
      capturedChallenges.push(req.body);
      res.json({ success: true });
    });

    const webhookSrv = await startServer(webhookApp);
    webhookServer = webhookSrv.server;
    webhookBaseUrl = webhookSrv.baseUrl;

    // Build the sendChallenge function that POSTs to the webhook server
    const sendChallenge: SendChallengeFn = async (payload) => {
      const res = await fetch(payload.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: payload.tenantId,
          sessionId: payload.sessionId,
          identityValue: payload.identityValue,
          challenge: payload.challenge,
        }),
      });
      const data = (await res.json()) as { success: boolean };
      return { success: data.success };
    };

    // Build main app with the real sendChallenge and only webhook verifier
    const ctx = buildTestApp({ customSendChallenge: sendChallenge, methods: ['webhook'] });
    const srv = await startServer(ctx.app);
    mainServer = srv.server;
    mainBaseUrl = srv.baseUrl;
  });

  afterAll(() => {
    mainServer?.close();
    webhookServer?.close();
  });

  beforeEach(() => {
    capturedChallenges = [];
  });

  const authHeaders = { 'x-tenant-id': 'tenant-wh', 'x-session-id': 'sess-wh-1' };

  it('full webhook flow: initiate -> capture challenge -> complete', async () => {
    // Step 1: Initiate webhook verification with the capture server URL
    const initRes = await httpRequest(mainBaseUrl, 'POST', '/api/identity/verify/initiate', {
      headers: authHeaders,
      body: {
        method: 'webhook',
        identityValue: 'webhook-user@example.com',
        identityType: 'email_thread',
        metadata: { webhookUrl: `${webhookBaseUrl}/webhook/verify` },
      },
    });

    expect(initRes.status).toBe(200);
    expect(initRes.body.success).toBe(true);
    expect(initRes.body.attemptId).toBeDefined();
    expect(initRes.body.challengeData).toBeDefined();
    expect(initRes.body.challengeData.userAction).toBe('await_webhook');

    const attemptId = initRes.body.attemptId;

    // Step 2: Verify the challenge was captured by the webhook server
    expect(capturedChallenges).toHaveLength(1);
    expect(capturedChallenges[0].identityValue).toBe('webhook-user@example.com');
    expect(capturedChallenges[0].tenantId).toBe('tenant-wh');
    expect(capturedChallenges[0].challenge).toBeDefined();
    expect(typeof capturedChallenges[0].challenge).toBe('string');

    const challenge = capturedChallenges[0].challenge;

    // Step 3: Complete with the captured challenge
    const completeRes = await httpRequest(mainBaseUrl, 'POST', '/api/identity/verify/complete', {
      headers: authHeaders,
      body: {
        attemptId,
        proof: {
          type: 'provider_assertion',
          value: challenge,
          metadata: { tenantId: 'tenant-wh' },
        },
      },
    });

    expect(completeRes.status).toBe(200);
    expect(completeRes.body.success).toBe(true);
    expect(completeRes.body.identityTier).toBe(1);
    expect(completeRes.body.verifiedIdentity).toBe('webhook-user@example.com');
  });
});
