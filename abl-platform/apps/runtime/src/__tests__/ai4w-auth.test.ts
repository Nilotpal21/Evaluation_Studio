/**
 * AI4W Auth Integration Tests
 *
 * Tests the auth module with real `jose` and `crypto` libraries.
 * Uses an in-process JWKS server to serve test signing keys.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from 'jose';

// ---------------------------------------------------------------------------
// Module-under-test functions — loaded via dynamic import AFTER env setup
// ---------------------------------------------------------------------------

let verifyHmac: typeof import('../channels/adapters/ai4w-auth.js').verifyHmac;
let validateTimestamp: typeof import('../channels/adapters/ai4w-auth.js').validateTimestamp;
let verifyAI4WJWT: typeof import('../channels/adapters/ai4w-auth.js').verifyAI4WJWT;
let buildOutboundSignatureHeaders: typeof import('../channels/adapters/ai4w-auth.js').buildOutboundSignatureHeaders;
let AI4WAuthError: typeof import('../channels/adapters/ai4w-auth.js').AI4WAuthError;
let initAI4WAuth: typeof import('../channels/adapters/ai4w-auth.js').initAI4WAuth;
let __resetAI4WAuthForTests: typeof import('../channels/adapters/ai4w-auth.js').__resetAI4WAuthForTests;
let getAI4WAuthHealth: typeof import('../channels/adapters/ai4w-auth.js').getAI4WAuthHealth;
let isInfraAuthError: typeof import('../channels/adapters/ai4w-auth.js').isInfraAuthError;

// ---------------------------------------------------------------------------
// Test key material
// ---------------------------------------------------------------------------

let privateKey: KeyLike;
let jwksServer: http.Server;
let jwksPort: number;
let TEST_ISSUER: string;

const TEST_AUDIENCE = 'urn:kore:agentic';

// ---------------------------------------------------------------------------
// HMAC helper — mirrors auth module's inbound signing convention
// ---------------------------------------------------------------------------

function signHmac(secret: string, requestId: string, timestamp: string, body: string): string {
  const input = `inbound:${requestId}.${timestamp}.${body}`;
  return 'sha256=' + crypto.createHmac('sha256', secret).update(input).digest('hex');
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Generate an RS256 key pair for JWT signing
  const keyPair = await generateKeyPair('RS256');
  privateKey = keyPair.privateKey;
  const jwk = await exportJWK(keyPair.publicKey);
  jwk.kid = 'test-key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  // 2. Start an in-process server that serves BOTH the JWKS and the OIDC
  //    discovery document — the auth module resolves jwks_uri via discovery.
  jwksServer = http.createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    } else if (req.url === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: TEST_ISSUER,
          jwks_uri: `${TEST_ISSUER}/.well-known/jwks.json`,
        }),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => {
    jwksServer.listen(0, '127.0.0.1', () => resolve());
  });

  jwksPort = (jwksServer.address() as AddressInfo).port;
  TEST_ISSUER = `http://127.0.0.1:${jwksPort}`;

  // 3. Env is read by initAI4WAuth(), not at module load — so the order is
  //    (a) set env, (b) dynamic-import the module, (c) call init.
  process.env.AI4W_TRUSTED_ISSUERS = TEST_ISSUER;
  process.env.AI4W_JWT_AUDIENCE = TEST_AUDIENCE;
  process.env.AI4W_ALLOW_HTTP_ISSUERS = 'true';
  process.env.AI4W_HMAC_TIMESTAMP_TOLERANCE_MS = '30000';

  const authModule = await import('../channels/adapters/ai4w-auth.js');
  verifyHmac = authModule.verifyHmac;
  validateTimestamp = authModule.validateTimestamp;
  verifyAI4WJWT = authModule.verifyAI4WJWT;
  buildOutboundSignatureHeaders = authModule.buildOutboundSignatureHeaders;
  AI4WAuthError = authModule.AI4WAuthError;
  initAI4WAuth = authModule.initAI4WAuth;
  __resetAI4WAuthForTests = authModule.__resetAI4WAuthForTests;
  getAI4WAuthHealth = authModule.getAI4WAuthHealth;
  isInfraAuthError = authModule.isInfraAuthError;

  __resetAI4WAuthForTests();
  await initAI4WAuth();
}, 30_000);

afterAll(async () => {
  if (jwksServer) {
    await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  }
  if (__resetAI4WAuthForTests) __resetAI4WAuthForTests();
  delete process.env.AI4W_TRUSTED_ISSUERS;
  delete process.env.AI4W_JWT_AUDIENCE;
  delete process.env.AI4W_ALLOW_HTTP_ISSUERS;
  delete process.env.AI4W_HMAC_TIMESTAMP_TOLERANCE_MS;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mintJwt(overrides: {
  subject?: string;
  issuer?: string;
  audience?: string;
  email?: string;
  accountId?: string;
  expiresIn?: string;
  kid?: string;
  signingKey?: KeyLike;
}): Promise<string> {
  const builder = new SignJWT({
    email: overrides.email ?? 'user@test.com',
    accountId: overrides.accountId ?? 'acc_123',
    scope: 'agentic',
    product: 'AgenticApp',
  })
    .setProtectedHeader({
      alg: 'RS256',
      kid: overrides.kid ?? 'test-key-1',
    })
    .setSubject(overrides.subject ?? 'user_456')
    .setIssuer(overrides.issuer ?? TEST_ISSUER)
    .setAudience(overrides.audience ?? TEST_AUDIENCE)
    .setIssuedAt();

  if (overrides.expiresIn) {
    builder.setExpirationTime(overrides.expiresIn);
  } else {
    builder.setExpirationTime('1h');
  }

  return builder.sign(overrides.signingKey ?? privateKey);
}

// =============================================================================
// HMAC VERIFICATION
// =============================================================================

describe('verifyHmac', () => {
  const secret = 'abl_cs_test-connection-secret';
  const requestId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const bodyStr = '{"text":"hello","agentContextId":"ctx_1"}';

  test('valid HMAC signature returns true', () => {
    const sig = signHmac(secret, requestId, timestamp, bodyStr);
    const result = verifyHmac(Buffer.from(bodyStr), secret, requestId, timestamp, sig);
    expect(result).toBe(true);
  });

  test('wrong secret returns false', () => {
    const sig = signHmac('wrong-secret', requestId, timestamp, bodyStr);
    const result = verifyHmac(Buffer.from(bodyStr), secret, requestId, timestamp, sig);
    expect(result).toBe(false);
  });

  test('tampered body returns false', () => {
    const sig = signHmac(secret, requestId, timestamp, bodyStr);
    const tamperedBody = '{"text":"tampered","agentContextId":"ctx_1"}';
    const result = verifyHmac(Buffer.from(tamperedBody), secret, requestId, timestamp, sig);
    expect(result).toBe(false);
  });
});

// =============================================================================
// TIMESTAMP VALIDATION
// =============================================================================

describe('validateTimestamp', () => {
  test('current ISO timestamp returns true', () => {
    const result = validateTimestamp(new Date().toISOString());
    expect(result).toBe(true);
  });

  test('timestamp 60s in the past returns false (outside 30s tolerance)', () => {
    const pastDate = new Date(Date.now() - 60_000);
    const result = validateTimestamp(pastDate.toISOString());
    expect(result).toBe(false);
  });

  test('epoch seconds within tolerance returns true', () => {
    const epochSeconds = String(Math.floor(Date.now() / 1000));
    const result = validateTimestamp(epochSeconds);
    expect(result).toBe(true);
  });

  test('garbage string returns false', () => {
    const result = validateTimestamp('not-a-date');
    expect(result).toBe(false);
  });
});

// =============================================================================
// JWT VERIFICATION
// =============================================================================

describe('verifyAI4WJWT', () => {
  test('valid JWT returns claims', async () => {
    const token = await mintJwt({});
    const claims = await verifyAI4WJWT(token);

    expect(claims.sub).toBe('user_456');
    expect(claims.email).toBe('user@test.com');
    expect(claims.accountId).toBe('acc_123');
    expect(claims.iss).toBe(TEST_ISSUER);
    expect(claims.aud).toBe(TEST_AUDIENCE);
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
  });

  test('expired JWT throws EXPIRED_TOKEN', async () => {
    const token = await mintJwt({ expiresIn: '-1s' });

    await expect(verifyAI4WJWT(token)).rejects.toThrow(
      expect.objectContaining({
        name: 'AI4WAuthError',
        code: 'EXPIRED_TOKEN',
      }),
    );
  });

  test('wrong audience throws WRONG_AUDIENCE', async () => {
    const token = await mintJwt({ audience: 'urn:wrong:audience' });

    await expect(verifyAI4WJWT(token)).rejects.toThrow(
      expect.objectContaining({
        name: 'AI4WAuthError',
        code: 'WRONG_AUDIENCE',
      }),
    );
  });

  test('wrong issuer throws WRONG_ISSUER', async () => {
    const token = await mintJwt({ issuer: 'https://wrong.issuer.com' });

    await expect(verifyAI4WJWT(token)).rejects.toThrow(
      expect.objectContaining({
        name: 'AI4WAuthError',
        code: 'WRONG_ISSUER',
      }),
    );
  });

  test('wrong signing key throws INVALID_TOKEN', async () => {
    const wrongKeyPair = await generateKeyPair('RS256');
    const token = await mintJwt({ signingKey: wrongKeyPair.privateKey });

    await expect(verifyAI4WJWT(token)).rejects.toThrow(
      expect.objectContaining({
        name: 'AI4WAuthError',
        code: 'INVALID_TOKEN',
      }),
    );
  });

  test('AI4WAuthError is instance of Error', () => {
    const err = new AI4WAuthError('HMAC_INVALID', 'test');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AI4WAuthError');
    expect(err.code).toBe('HMAC_INVALID');
    expect(err.message).toBe('test');
  });

  // Identity claims must be non-empty — the verifier is the trust boundary
  // for end-user identity. An empty email/sub/accountId would collapse
  // multiple end-users onto a shared session key downstream.
  test('JWT with empty email throws INVALID_TOKEN', async () => {
    const token = await mintJwt({ email: '' });

    await expect(verifyAI4WJWT(token)).rejects.toThrow(
      expect.objectContaining({
        name: 'AI4WAuthError',
        code: 'INVALID_TOKEN',
        message: expect.stringContaining('identity claim'),
      }),
    );
  });

  test('JWT with whitespace-only email throws INVALID_TOKEN', async () => {
    const token = await mintJwt({ email: '   ' });

    await expect(verifyAI4WJWT(token)).rejects.toThrow(
      expect.objectContaining({
        name: 'AI4WAuthError',
        code: 'INVALID_TOKEN',
      }),
    );
  });

  test('JWT with empty accountId throws INVALID_TOKEN', async () => {
    const token = await mintJwt({ accountId: '' });

    await expect(verifyAI4WJWT(token)).rejects.toThrow(
      expect.objectContaining({
        name: 'AI4WAuthError',
        code: 'INVALID_TOKEN',
      }),
    );
  });

  test('JWT with empty sub throws INVALID_TOKEN', async () => {
    const token = await mintJwt({ subject: '' });

    await expect(verifyAI4WJWT(token)).rejects.toThrow(
      expect.objectContaining({
        name: 'AI4WAuthError',
        code: 'INVALID_TOKEN',
      }),
    );
  });
});

// =============================================================================
// OUTBOUND SIGNATURE
// =============================================================================

describe('buildOutboundSignatureHeaders', () => {
  test('produces valid headers with outbound prefix', () => {
    const secret = 'abl_cs_outbound-secret';
    const body = '{"response":"hello"}';

    const headers = buildOutboundSignatureHeaders(secret, body);

    expect(headers['X-Signature-Nonce']).toBeTruthy();
    expect(headers['X-Timestamp']).toBeTruthy();
    expect(headers['X-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);

    // Verify the signature is reproducible with the outbound prefix
    const payload = `outbound:${headers['X-Signature-Nonce']}.${headers['X-Timestamp']}.${body}`;
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
    expect(headers['X-Signature']).toBe(expected);
  });

  test('produces headers from a Buffer body', () => {
    const secret = 'abl_cs_outbound-secret';
    const body = Buffer.from('{"response":"hello"}');

    const headers = buildOutboundSignatureHeaders(secret, body);

    expect(headers['X-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

// =============================================================================
// LAZY ISSUER REGISTRATION + RECOVERY
// =============================================================================
//
// Regression: a transiently-down issuer must self-heal on the next request
// after it comes back online — no pod restart required, and an unhealthy
// issuer must not poison verification for healthy ones in the same allowlist.

describe('lazy issuer registration', () => {
  test('init with all issuers unreachable still succeeds (no network at startup)', async () => {
    const previousIssuers = process.env.AI4W_TRUSTED_ISSUERS;
    const previousAllowHttp = process.env.AI4W_ALLOW_HTTP_ISSUERS;
    process.env.AI4W_TRUSTED_ISSUERS = 'http://127.0.0.1:1'; // guaranteed unreachable port
    process.env.AI4W_ALLOW_HTTP_ISSUERS = 'true';

    __resetAI4WAuthForTests();
    await expect(initAI4WAuth()).resolves.toBeUndefined();

    // Restore env + re-init for subsequent tests
    if (previousIssuers === undefined) delete process.env.AI4W_TRUSTED_ISSUERS;
    else process.env.AI4W_TRUSTED_ISSUERS = previousIssuers;
    if (previousAllowHttp === undefined) delete process.env.AI4W_ALLOW_HTTP_ISSUERS;
    else process.env.AI4W_ALLOW_HTTP_ISSUERS = previousAllowHttp;

    process.env.AI4W_TRUSTED_ISSUERS = TEST_ISSUER;
    process.env.AI4W_ALLOW_HTTP_ISSUERS = 'true';
    __resetAI4WAuthForTests();
    await initAI4WAuth();
  });

  test('first JWT after issuer comes online registers and verifies', async () => {
    // Spin up a NEW JWKS server on a different port to simulate an issuer
    // that wasn't reachable when the pod started.
    const lateKeyPair = await generateKeyPair('RS256');
    const lateJwk = await exportJWK(lateKeyPair.publicKey);
    lateJwk.kid = 'late-key-1';
    lateJwk.alg = 'RS256';
    lateJwk.use = 'sig';

    let lateIssuer = '';
    const lateServer = http.createServer((req, res) => {
      if (req.url === '/.well-known/jwks.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: [lateJwk] }));
      } else if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: lateIssuer,
            jwks_uri: `${lateIssuer}/.well-known/jwks.json`,
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => lateServer.listen(0, '127.0.0.1', () => resolve()));
    const latePort = (lateServer.address() as AddressInfo).port;
    lateIssuer = `http://127.0.0.1:${latePort}`;

    try {
      // Configure the allowlist with both the original issuer AND the late one,
      // mimicking a multi-issuer deployment.
      process.env.AI4W_TRUSTED_ISSUERS = `${TEST_ISSUER},${lateIssuer}`;
      __resetAI4WAuthForTests();
      await initAI4WAuth();

      // Mint a JWT signed by the late issuer's key
      const token = await new SignJWT({
        email: 'late@test.com',
        accountId: 'acc_late',
        scope: 'agentic',
        product: 'AgenticApp',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'late-key-1' })
        .setSubject('user_late')
        .setIssuer(lateIssuer)
        .setAudience(TEST_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(lateKeyPair.privateKey);

      // First verify triggers lazy registration of the late issuer
      const claims = await verifyAI4WJWT(token);
      expect(claims.iss).toBe(lateIssuer);
      expect(claims.email).toBe('late@test.com');
    } finally {
      await new Promise<void>((resolve) => lateServer.close(() => resolve()));
      process.env.AI4W_TRUSTED_ISSUERS = TEST_ISSUER;
      __resetAI4WAuthForTests();
      await initAI4WAuth();
    }
  });

  test('one unhealthy issuer does not poison a healthy issuer in the same allowlist', async () => {
    const unreachable = 'http://127.0.0.1:1';
    process.env.AI4W_TRUSTED_ISSUERS = `${unreachable},${TEST_ISSUER}`;
    __resetAI4WAuthForTests();
    await initAI4WAuth();

    // JWT signed by the healthy issuer should still verify normally.
    const token = await new SignJWT({
      email: 'user@test.com',
      accountId: 'acc_123',
      scope: 'agentic',
      product: 'AgenticApp',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setSubject('user_456')
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const claims = await verifyAI4WJWT(token);
    expect(claims.iss).toBe(TEST_ISSUER);

    // Restore for subsequent tests
    process.env.AI4W_TRUSTED_ISSUERS = TEST_ISSUER;
    __resetAI4WAuthForTests();
    await initAI4WAuth();
  });
});

// =============================================================================
// COOLDOWN, SINGLE-FLIGHT, RECOVERY
// =============================================================================
//
// These tests verify the load-bearing properties of the lazy-registration
// design: failed registrations are cached for the cooldown window (no
// thundering herd of discovery), concurrent first-requests share one
// in-flight discovery promise (no thundering herd at recovery), and a
// previously-down issuer is automatically retried after the cooldown.

describe('lazy registration: cooldown + single-flight + recovery', () => {
  let flakyServer: http.Server;
  let flakyPort: number;
  let flakyIssuer: string;
  let mode: 'broken' | 'healthy' = 'broken';
  let discoveryCallCount = 0;
  let flakyKeyPair: { privateKey: KeyLike; publicKey: KeyLike };
  let flakyJwk: Record<string, unknown>;

  const ORIGINAL_COOLDOWN = process.env.AI4W_JWKS_COOLDOWN_MS;
  const TEST_COOLDOWN_MS = 250;

  beforeAll(async () => {
    flakyKeyPair = (await generateKeyPair('RS256')) as {
      privateKey: KeyLike;
      publicKey: KeyLike;
    };
    flakyJwk = (await exportJWK(flakyKeyPair.publicKey)) as Record<string, unknown>;
    flakyJwk.kid = 'flaky-key-1';
    flakyJwk.alg = 'RS256';
    flakyJwk.use = 'sig';

    flakyServer = http.createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        discoveryCallCount += 1;
        if (mode === 'broken') {
          res.writeHead(503);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: flakyIssuer,
            jwks_uri: `${flakyIssuer}/.well-known/jwks.json`,
          }),
        );
      } else if (req.url === '/.well-known/jwks.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: [flakyJwk] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => flakyServer.listen(0, '127.0.0.1', () => resolve()));
    flakyPort = (flakyServer.address() as AddressInfo).port;
    flakyIssuer = `http://127.0.0.1:${flakyPort}`;

    process.env.AI4W_JWKS_COOLDOWN_MS = String(TEST_COOLDOWN_MS);
    process.env.AI4W_TRUSTED_ISSUERS = flakyIssuer;
    process.env.AI4W_DISABLE_WARMUP = 'true';
  });

  afterAll(async () => {
    if (flakyServer) {
      await new Promise<void>((resolve) => flakyServer.close(() => resolve()));
    }
    if (ORIGINAL_COOLDOWN === undefined) delete process.env.AI4W_JWKS_COOLDOWN_MS;
    else process.env.AI4W_JWKS_COOLDOWN_MS = ORIGINAL_COOLDOWN;
    delete process.env.AI4W_DISABLE_WARMUP;

    process.env.AI4W_TRUSTED_ISSUERS = TEST_ISSUER;
    __resetAI4WAuthForTests();
    await initAI4WAuth();
  });

  async function mintFlakyJwt(): Promise<string> {
    return new SignJWT({
      email: 'flaky@test.com',
      accountId: 'acc_flaky',
      scope: 'agentic',
      product: 'AgenticApp',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'flaky-key-1' })
      .setSubject('user_flaky')
      .setIssuer(flakyIssuer)
      .setAudience(TEST_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(flakyKeyPair.privateKey);
  }

  test('failure caches for cooldown window — second request inside window does NOT re-fetch', async () => {
    mode = 'broken';
    discoveryCallCount = 0;
    __resetAI4WAuthForTests();
    await initAI4WAuth();

    const token = await mintFlakyJwt();

    // First verify triggers discovery — fails with ISSUER_UNAVAILABLE (infra).
    await expect(verifyAI4WJWT(token)).rejects.toThrow(
      expect.objectContaining({ name: 'AI4WAuthError', code: 'ISSUER_UNAVAILABLE' }),
    );
    expect(discoveryCallCount).toBe(1);

    // Second verify, immediately — should hit cached failure without a network call.
    await expect(verifyAI4WJWT(token)).rejects.toThrow(
      expect.objectContaining({ name: 'AI4WAuthError', code: 'ISSUER_UNAVAILABLE' }),
    );
    expect(discoveryCallCount).toBe(1);

    // Third verify after cooldown elapses — should re-attempt discovery.
    await new Promise((resolve) => setTimeout(resolve, TEST_COOLDOWN_MS + 50));
    await expect(verifyAI4WJWT(token)).rejects.toThrow(
      expect.objectContaining({ name: 'AI4WAuthError', code: 'ISSUER_UNAVAILABLE' }),
    );
    expect(discoveryCallCount).toBe(2);
  });

  test('isInfraAuthError correctly distinguishes ISSUER_UNAVAILABLE from credential failures', () => {
    expect(isInfraAuthError(new AI4WAuthError('ISSUER_UNAVAILABLE', 'down'))).toBe(true);
    expect(isInfraAuthError(new AI4WAuthError('WRONG_ISSUER', 'unknown'))).toBe(false);
    expect(isInfraAuthError(new AI4WAuthError('EXPIRED_TOKEN', 'old'))).toBe(false);
    expect(isInfraAuthError(new Error('unrelated'))).toBe(false);
  });

  test('single-flight: N concurrent first-requests trigger exactly 1 discovery call', async () => {
    mode = 'healthy';
    discoveryCallCount = 0;
    __resetAI4WAuthForTests();
    await initAI4WAuth();

    const token = await mintFlakyJwt();

    // 25 concurrent verifies before any of them complete.
    const N = 25;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        verifyAI4WJWT(token).then(
          () => 'ok',
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        ),
      ),
    );

    // All 25 should resolve identically.
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe('ok');
    // Only one discovery call should have happened (single-flight).
    expect(discoveryCallCount).toBe(1);
  });

  test('recovery after cooldown: server flips healthy → next request after cooldown succeeds', async () => {
    mode = 'broken';
    discoveryCallCount = 0;
    __resetAI4WAuthForTests();
    await initAI4WAuth();

    const token = await mintFlakyJwt();

    // First request: fails (cached for cooldown window)
    await expect(verifyAI4WJWT(token)).rejects.toThrow(
      expect.objectContaining({ code: 'ISSUER_UNAVAILABLE' }),
    );
    expect(discoveryCallCount).toBe(1);

    // Server comes back online during the cooldown window — but the cached
    // failure should still apply until the window elapses.
    mode = 'healthy';
    await expect(verifyAI4WJWT(token)).rejects.toThrow(
      expect.objectContaining({ code: 'ISSUER_UNAVAILABLE' }),
    );
    expect(discoveryCallCount).toBe(1); // no re-fetch during cooldown

    // After cooldown elapses, the next request triggers a fresh registration
    // attempt and SUCCEEDS — this is the production scenario the design fixes.
    await new Promise((resolve) => setTimeout(resolve, TEST_COOLDOWN_MS + 50));
    const claims = await verifyAI4WJWT(token);
    expect(claims.iss).toBe(flakyIssuer);
    expect(claims.email).toBe('flaky@test.com');
    expect(discoveryCallCount).toBe(2);
  });

  test('warmup failure must NOT poison cooldown — first user request after recovery succeeds', async () => {
    // Production scenario: pod boots while work-dev OIDC is briefly down. By
    // the time the first inbound JWT arrives, the issuer is back. Warmup's
    // failure must NOT pre-poison the cooldown cache; otherwise the first
    // user request would still see ISSUER_UNAVAILABLE for AI4W_JWKS_COOLDOWN_MS.
    mode = 'broken';
    discoveryCallCount = 0;
    delete process.env.AI4W_DISABLE_WARMUP; // warmup ENABLED for this test
    __resetAI4WAuthForTests();
    await initAI4WAuth();

    // Let warmup fire and fail.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(discoveryCallCount).toBeGreaterThanOrEqual(1);

    // Issuer recovers BEFORE the first user request arrives.
    mode = 'healthy';

    // First user request must succeed — warmup's failure did not pre-poison
    // the cooldown cache. This is the regression guard.
    const token = await mintFlakyJwt();
    const claims = await verifyAI4WJWT(token);
    expect(claims.iss).toBe(flakyIssuer);

    process.env.AI4W_DISABLE_WARMUP = 'true'; // restore for sibling tests
  });

  test('getAI4WAuthHealth reports allowed / registered / failed correctly', async () => {
    mode = 'healthy';
    __resetAI4WAuthForTests();
    await initAI4WAuth();

    let health = getAI4WAuthHealth();
    expect(health.initialized).toBe(true);
    expect(health.allowed).toEqual([flakyIssuer]);
    expect(health.registered).toEqual([]);

    const token = await mintFlakyJwt();
    await verifyAI4WJWT(token);

    health = getAI4WAuthHealth();
    expect(health.registered).toEqual([flakyIssuer]);
    expect(health.failed).toEqual([]);
  });
});
