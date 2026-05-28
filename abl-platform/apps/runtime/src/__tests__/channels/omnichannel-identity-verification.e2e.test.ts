/**
 * Identity Verification E2E Tests (GAP-019)
 *
 * Exercises the identity verification routes through the real HTTP stack:
 * real Express server, real MongoDB (MongoMemoryServer), real unifiedAuth
 * middleware, real verifiers (OTP, HMAC), in-memory token store.
 *
 * Routes under test:
 *   POST /api/identity/verify/initiate
 *   POST /api/identity/verify/complete
 *   GET  /api/identity/verify/:attemptId
 *
 * E2E rules:
 * - NO vi.mock() / jest.mock()
 * - NO direct database queries in assertions
 * - Real HTTP requests via the harness
 * - Real servers on random ports with full middleware chain
 */

import crypto from 'node:crypto';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { VerificationMethod } from '@agent-platform/shared-auth';
import authRouter from '../../routes/auth.js';
import platformAdminTenantsRouter from '../../routes/platform-admin-tenants.js';
import { unifiedAuth } from '../../middleware/auth.js';
import { createIdentityVerificationRouter } from '../../routes/identity-verification.js';
import { OtpVerifier } from '../../contexts/identity/infrastructure/verifiers/otp-verifier.js';
import { HmacVerifier } from '../../contexts/identity/infrastructure/verifiers/hmac-verifier.js';
import { VerifyIdentity } from '../../contexts/identity/use-cases/verify-identity.js';
import type {
  VerificationTokenStore,
  StoredVerificationAttempt,
} from '../../contexts/identity/infrastructure/verification-token-store.js';
import type {
  IdentityVerifier,
  VerificationProof,
} from '../../contexts/identity/domain/identity-verifier.js';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import {
  startRuntimeApiHarness,
  mintSdkSessionToken,
  type RuntimeApiHarness,
} from '../helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from '../helpers/channel-e2e-bootstrap.js';

// =============================================================================
// IN-MEMORY TOKEN STORE
// =============================================================================

/**
 * In-memory VerificationTokenStore for E2E testing.
 * Since REDIS_ENABLED=false in the harness, the server.ts wiring creates a
 * no-op stub store. We wire our own in-memory store so OTP flows complete.
 */
class InMemoryVerificationTokenStore implements VerificationTokenStore {
  private readonly store = new Map<string, StoredVerificationAttempt>();

  async create(attempt: StoredVerificationAttempt): Promise<void> {
    const key = `${attempt.tenantId}:${attempt.id}`;
    this.store.set(key, { ...attempt });
  }

  async get(tenantId: string, attemptId: string): Promise<StoredVerificationAttempt | null> {
    const key = `${tenantId}:${attemptId}`;
    const attempt = this.store.get(key);
    return attempt ? { ...attempt } : null;
  }

  async incrementAttempts(tenantId: string, attemptId: string): Promise<void> {
    const key = `${tenantId}:${attemptId}`;
    const attempt = this.store.get(key);
    if (attempt) {
      attempt.attempts += 1;
    }
  }

  async markVerified(tenantId: string, attemptId: string): Promise<void> {
    const key = `${tenantId}:${attemptId}`;
    const attempt = this.store.get(key);
    if (attempt) {
      attempt.status = 'verified';
    }
  }

  clear(): void {
    this.store.clear();
  }
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** HMAC secret used by all verifiers in the test harness. */
const TEST_HMAC_SECRET = '9'.repeat(64);

// =============================================================================
// HELPERS
// =============================================================================

function sdkTokenHeaders(token: string): Record<string, string> {
  return { 'X-SDK-Token': token };
}

/**
 * Compute a valid HMAC-SHA256 signature for identity verification.
 * Mirrors the client-side HMAC computation: HMAC-SHA256(secret, userId + ":" + timestamp)
 */
function computeHmac(userId: string, timestamp: number, secret: string): string {
  return createHmac('sha256', secret).update(`${userId}:${timestamp}`).digest('hex');
}

// =============================================================================
// RESPONSE TYPES
// =============================================================================

interface InitiateResponse {
  success: boolean;
  attemptId?: string;
  challengeData?: Record<string, unknown>;
  error?: { code: string; message: string };
}

interface CompleteResponse {
  success: boolean;
  identityTier?: number;
  verifiedIdentity?: string;
  error?: { code: string; message: string };
}

interface AttemptStatusResponse {
  success?: boolean;
  data?: {
    attemptId?: string;
    status?: string;
    method?: string;
    expiresAt?: string;
  };
  attemptId?: string;
  status?: string;
  method?: string;
  expiresAt?: string;
  error?: { code: string; message: string };
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe('Identity Verification E2E', () => {
  let harness: RuntimeApiHarness;
  let tokenStore: InMemoryVerificationTokenStore;

  beforeAll(async () => {
    // Build verifier infrastructure with in-memory token store
    tokenStore = new InMemoryVerificationTokenStore();

    const otpVerifier = new OtpVerifier(tokenStore, TEST_HMAC_SECRET);
    const hmacVerifier = new HmacVerifier(TEST_HMAC_SECRET);

    // HMAC must be registered before OTP because OTP.supports() is a catch-all
    // (returns true for any input), while HMAC.supports() is selective (only
    // returns true when metadata contains hmac + timestamp). VerifyIdentity
    // iterates the map and delegates to the first verifier that supports the input.
    const verifierMap = new Map<VerificationMethod, IdentityVerifier>([
      ['hmac', hmacVerifier],
      ['otp', otpVerifier],
    ]);

    const verifyIdentity = new VerifyIdentity(verifierMap);

    // completeVerification: look up verifier by attempt method, delegate to complete()
    const completeVerification = async (attemptId: string, proof: VerificationProof) => {
      const tenantId = (proof.metadata?.tenantId as string) ?? '';
      const attempt = await tokenStore.get(tenantId, attemptId);
      if (!attempt) {
        return {
          success: false as const,
          error: {
            code: 'ATTEMPT_NOT_FOUND',
            message: 'Verification attempt not found',
          },
        };
      }
      const verifier = verifierMap.get(attempt.method as VerificationMethod);
      if (!verifier) {
        return {
          success: false as const,
          error: {
            code: 'UNSUPPORTED_METHOD',
            message: `No verifier registered for method: ${attempt.method}`,
          },
        };
      }
      return verifier.complete(attemptId, proof);
    };

    const identityVerificationRouter = createIdentityVerificationRouter({
      verifyIdentity,
      tokenStore,
      completeVerification,
    });

    harness = await startRuntimeApiHarness((app) => {
      // Auth routes for bootstrapProject (dev-login, tenant/project creation)
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);

      // Unified auth middleware to populate tenantContext from SDK tokens
      app.use('/api/identity', unifiedAuth);

      // Identity verification routes
      app.use('/api/identity/verify', identityVerificationRouter);
    });
  }, 60_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    tokenStore.clear();
  }, 30_000);

  afterAll(async () => {
    await harness.close();
  }, 30_000);

  // ─── E2E-1: Initiate OTP verification ─────────────────────────────────

  test('E2E-1: POST /initiate with OTP returns success with attemptId', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('idv-otp'),
      uniqueSlug('tenant-idv-otp'),
      uniqueSlug('proj-idv-otp'),
    );

    const sessionId = crypto.randomUUID();
    const channelId = crypto.randomUUID();

    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId,
      channelId,
    });

    const res = await requestJson<InitiateResponse>(harness, '/api/identity/verify/initiate', {
      method: 'POST',
      headers: sdkTokenHeaders(sdkToken),
      body: {
        method: 'otp',
        identityValue: 'test@example.com',
        identityType: 'email_thread',
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.attemptId).toBeTruthy();
    expect(typeof res.body.attemptId).toBe('string');
    // OTP verifier returns challengeData with the code for dispatch
    expect(res.body.challengeData).toBeTruthy();
    expect(res.body.challengeData?.userAction).toBe('enter_otp');
    expect(typeof res.body.challengeData?.code).toBe('string');
  }, 30_000);

  // ─── E2E-2: Initiate with invalid input ───────────────────────────────

  test('E2E-2: POST /initiate with missing required fields returns 400', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('idv-invalid'),
      uniqueSlug('tenant-idv-invalid'),
      uniqueSlug('proj-idv-invalid'),
    );

    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: crypto.randomUUID(),
      channelId: crypto.randomUUID(),
    });

    // Missing identityValue and identityType
    const res = await requestJson<InitiateResponse>(harness, '/api/identity/verify/initiate', {
      method: 'POST',
      headers: sdkTokenHeaders(sdkToken),
      body: { method: 'otp' },
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('INVALID_INPUT');
  }, 30_000);

  // ─── E2E-3: Requires authentication ───────────────────────────────────

  test('E2E-3: POST /initiate without X-SDK-Token returns 401', async () => {
    const res = await requestJson<InitiateResponse>(harness, '/api/identity/verify/initiate', {
      method: 'POST',
      // No auth headers
      body: {
        method: 'otp',
        identityValue: 'test@example.com',
        identityType: 'email_thread',
      },
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('UNAUTHORIZED');
  }, 30_000);

  // ─── E2E-4: Complete with wrong OTP ───────────────────────────────────

  test('E2E-4: POST /complete with wrong OTP code returns error', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('idv-wrongotp'),
      uniqueSlug('tenant-idv-wrongotp'),
      uniqueSlug('proj-idv-wrongotp'),
    );

    const sessionId = crypto.randomUUID();
    const channelId = crypto.randomUUID();

    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId,
      channelId,
    });

    // First, initiate an OTP flow
    const initRes = await requestJson<InitiateResponse>(harness, '/api/identity/verify/initiate', {
      method: 'POST',
      headers: sdkTokenHeaders(sdkToken),
      body: {
        method: 'otp',
        identityValue: 'wrong-otp@example.com',
        identityType: 'email_thread',
      },
    });

    expect(initRes.status).toBe(200);
    expect(initRes.body.success).toBe(true);
    const attemptId = initRes.body.attemptId;
    expect(attemptId).toBeTruthy();

    // Now complete with a wrong code
    const completeRes = await requestJson<CompleteResponse>(
      harness,
      '/api/identity/verify/complete',
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkToken),
        body: {
          attemptId,
          proof: {
            type: 'otp_code',
            value: '000000',
            metadata: { tenantId: admin.tenantId },
          },
        },
      },
    );

    expect(completeRes.status).toBe(200);
    expect(completeRes.body.success).toBe(false);
    expect(completeRes.body.error?.code).toBe('OTP_INVALID');
  }, 30_000);

  // ─── E2E-5: Complete with correct OTP ─────────────────────────────────

  test('E2E-5: POST /complete with correct OTP code returns verified result', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('idv-correctotp'),
      uniqueSlug('tenant-idv-correctotp'),
      uniqueSlug('proj-idv-correctotp'),
    );

    const sessionId = crypto.randomUUID();
    const channelId = crypto.randomUUID();

    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId,
      channelId,
    });

    // Initiate OTP
    const initRes = await requestJson<InitiateResponse>(harness, '/api/identity/verify/initiate', {
      method: 'POST',
      headers: sdkTokenHeaders(sdkToken),
      body: {
        method: 'otp',
        identityValue: 'correct-otp@example.com',
        identityType: 'email_thread',
      },
    });

    expect(initRes.status).toBe(200);
    expect(initRes.body.success).toBe(true);
    const attemptId = initRes.body.attemptId;
    const correctCode = initRes.body.challengeData?.code as string;
    expect(attemptId).toBeTruthy();
    expect(correctCode).toBeTruthy();

    // Complete with the correct code
    const completeRes = await requestJson<CompleteResponse>(
      harness,
      '/api/identity/verify/complete',
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkToken),
        body: {
          attemptId,
          proof: {
            type: 'otp_code',
            value: correctCode,
            metadata: { tenantId: admin.tenantId },
          },
        },
      },
    );

    expect(completeRes.status).toBe(200);
    expect(completeRes.body.success).toBe(true);
    expect(completeRes.body.identityTier).toBe(2);
    expect(completeRes.body.verifiedIdentity).toBe('correct-otp@example.com');
  }, 30_000);

  // ─── E2E-6: Get attempt status ────────────────────────────────────────

  test('E2E-6: GET /:attemptId returns attempt status after initiation', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('idv-status'),
      uniqueSlug('tenant-idv-status'),
      uniqueSlug('proj-idv-status'),
    );

    const sessionId = crypto.randomUUID();
    const channelId = crypto.randomUUID();

    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId,
      channelId,
    });

    // Initiate OTP
    const initRes = await requestJson<InitiateResponse>(harness, '/api/identity/verify/initiate', {
      method: 'POST',
      headers: sdkTokenHeaders(sdkToken),
      body: {
        method: 'otp',
        identityValue: 'status@example.com',
        identityType: 'email_thread',
      },
    });

    expect(initRes.status).toBe(200);
    const attemptId = initRes.body.attemptId;
    expect(attemptId).toBeTruthy();

    // Get attempt status
    const statusRes = await requestJson<AttemptStatusResponse>(
      harness,
      `/api/identity/verify/${attemptId}`,
      {
        method: 'GET',
        headers: sdkTokenHeaders(sdkToken),
      },
    );

    expect(statusRes.status).toBe(200);
    // The route returns { success, data: { attemptId, status, method, expiresAt } }
    const statusData = statusRes.body.data ?? statusRes.body;
    expect(statusData.attemptId).toBe(attemptId);
    expect(statusData.status).toBe('pending');
    expect(statusData.method).toBe('otp');
    expect(statusData.expiresAt).toBeTruthy();
    // expiresAt should be a valid ISO date string
    expect(new Date(statusData.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  }, 30_000);

  // ─── E2E-7: Get attempt status — not found ────────────────────────────

  test('E2E-7: GET /:attemptId returns 404 for nonexistent attempt', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('idv-notfound'),
      uniqueSlug('tenant-idv-notfound'),
      uniqueSlug('proj-idv-notfound'),
    );

    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: crypto.randomUUID(),
      channelId: crypto.randomUUID(),
    });

    const res = await requestJson<AttemptStatusResponse>(
      harness,
      `/api/identity/verify/${crypto.randomUUID()}`,
      {
        method: 'GET',
        headers: sdkTokenHeaders(sdkToken),
      },
    );

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  }, 30_000);

  // ─── E2E-8: HMAC single-step verification ─────────────────────────────

  test('E2E-8: POST /initiate with HMAC method and valid signature returns success', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('idv-hmac'),
      uniqueSlug('tenant-idv-hmac'),
      uniqueSlug('proj-idv-hmac'),
    );

    const sessionId = crypto.randomUUID();
    const channelId = crypto.randomUUID();

    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId,
      channelId,
    });

    const userId = 'user-hmac-test@example.com';
    const timestamp = Math.floor(Date.now() / 1000);
    const hmac = computeHmac(userId, timestamp, TEST_HMAC_SECRET);

    const res = await requestJson<InitiateResponse>(harness, '/api/identity/verify/initiate', {
      method: 'POST',
      headers: sdkTokenHeaders(sdkToken),
      body: {
        method: 'hmac',
        identityValue: userId,
        identityType: 'email_thread',
        metadata: { hmac, timestamp },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // HMAC is single-step, no attemptId needed for challenge flow
    expect(res.body.error).toBeUndefined();
  }, 30_000);

  // ─── E2E-9: HMAC verification with invalid signature ──────────────────

  test('E2E-9: POST /initiate with HMAC method and invalid signature returns error', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('idv-hmac-invalid'),
      uniqueSlug('tenant-idv-hmac-invalid'),
      uniqueSlug('proj-idv-hmac-invalid'),
    );

    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: crypto.randomUUID(),
      channelId: crypto.randomUUID(),
    });

    const userId = 'user-hmac-bad@example.com';
    const timestamp = Math.floor(Date.now() / 1000);
    // Use a wrong secret to generate an invalid HMAC
    const wrongHmac = computeHmac(userId, timestamp, 'wrong-secret'.padEnd(64, '0'));

    const res = await requestJson<InitiateResponse>(harness, '/api/identity/verify/initiate', {
      method: 'POST',
      headers: sdkTokenHeaders(sdkToken),
      body: {
        method: 'hmac',
        identityValue: userId,
        identityType: 'email_thread',
        metadata: { hmac: wrongHmac, timestamp },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('HMAC_INVALID');
  }, 30_000);

  // ─── E2E-10: Complete with missing fields ─────────────────────────────

  test('E2E-10: POST /complete with missing fields returns 400', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('idv-complete-invalid'),
      uniqueSlug('tenant-idv-compl-inv'),
      uniqueSlug('proj-idv-compl-inv'),
    );

    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: crypto.randomUUID(),
      channelId: crypto.randomUUID(),
    });

    // Missing proof
    const res1 = await requestJson<CompleteResponse>(harness, '/api/identity/verify/complete', {
      method: 'POST',
      headers: sdkTokenHeaders(sdkToken),
      body: { attemptId: 'some-attempt' },
    });
    expect(res1.status).toBe(400);
    expect(res1.body.success).toBe(false);
    expect(res1.body.error?.code).toBe('INVALID_INPUT');

    // Missing attemptId
    const res2 = await requestJson<CompleteResponse>(harness, '/api/identity/verify/complete', {
      method: 'POST',
      headers: sdkTokenHeaders(sdkToken),
      body: { proof: { type: 'otp_code', value: '123456' } },
    });
    expect(res2.status).toBe(400);
    expect(res2.body.success).toBe(false);
    expect(res2.body.error?.code).toBe('INVALID_INPUT');
  }, 30_000);

  // ─── E2E-11: Auth required on all routes ──────────────────────────────

  test('E2E-11: GET /:attemptId without auth returns 401', async () => {
    const res = await requestJson<AttemptStatusResponse>(
      harness,
      `/api/identity/verify/${crypto.randomUUID()}`,
      {
        method: 'GET',
        // No auth headers
      },
    );

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('UNAUTHORIZED');
  }, 30_000);

  test('E2E-11b: POST /complete without auth returns 401', async () => {
    const res = await requestJson<CompleteResponse>(harness, '/api/identity/verify/complete', {
      method: 'POST',
      body: {
        attemptId: 'any',
        proof: { type: 'otp_code', value: '123456' },
      },
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('UNAUTHORIZED');
  }, 30_000);
});
