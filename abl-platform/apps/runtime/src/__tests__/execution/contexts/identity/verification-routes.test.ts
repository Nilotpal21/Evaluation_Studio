/**
 * Identity Verification Routes Tests
 *
 * Tests the Express routes for identity verification flows.
 * Uses the real Express router with mocked dependencies injected via the factory function.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { Router } from 'express';

import { createIdentityVerificationRouter } from '../../../../routes/identity-verification.js';
import type { VerifyIdentity } from '../../../../contexts/identity/use-cases/verify-identity.js';
import type {
  VerificationTokenStore,
  StoredVerificationAttempt,
} from '../../../../contexts/identity/infrastructure/verification-token-store.js';
import type {
  VerificationProof,
  VerificationResult,
} from '../../../../contexts/identity/domain/identity-verifier.js';

// =============================================================================
// MOCKS
// =============================================================================

const mockVerifyExecute = vi.fn();
const mockCompleteVerification = vi.fn();
const mockTokenStoreGet = vi.fn();

function createMockDeps() {
  return {
    verifyIdentity: { execute: mockVerifyExecute } as unknown as VerifyIdentity,
    tokenStore: { get: mockTokenStoreGet } as unknown as VerificationTokenStore,
    completeVerification: mockCompleteVerification as (
      attemptId: string,
      proof: VerificationProof,
    ) => Promise<VerificationResult>,
  };
}

// =============================================================================
// ROUTER SETUP
// =============================================================================

function createTenantContext() {
  return {
    tenantId: 'tenant-001',
    projectId: 'project-001',
    sessionId: 'sess-abc',
    sessionPrincipal: 'principal-abc',
  };
}

const router = createIdentityVerificationRouter(createMockDeps());
const noAuthRouter = createIdentityVerificationRouter(createMockDeps());

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// HELPERS
// =============================================================================

function stripMountedPath(path: string): string {
  return path.replace(/^\/api\/identity\/verify/, '') || '/';
}

async function invokeRouter(
  targetRouter: Router,
  method: string,
  path: string,
  opts?: { body?: unknown; withAuth?: boolean },
) {
  return new Promise<{ status: number; body: unknown; text: string | undefined }>(
    (resolve, reject) => {
      let statusCode = 200;
      let responseBody: unknown;
      let responseText: string | undefined;
      let resolved = false;

      const finish = () => {
        if (resolved) {
          return;
        }
        resolved = true;
        resolve({ status: statusCode, body: responseBody, text: responseText });
      };

      const req = {
        body: opts?.body,
        headers: { 'content-type': 'application/json' },
        method,
        originalUrl: path,
        tenantContext: opts?.withAuth === false ? undefined : createTenantContext(),
        url: stripMountedPath(path),
      };
      const res = {
        getHeader: () => undefined,
        headersSent: false,
        json(body: unknown) {
          responseBody = body;
          responseText = JSON.stringify(body);
          this.headersSent = true;
          finish();
          return this;
        },
        send(body: unknown) {
          responseBody = body;
          responseText = typeof body === 'string' ? body : JSON.stringify(body);
          this.headersSent = true;
          finish();
          return this;
        },
        setHeader: () => undefined,
        status(code: number) {
          statusCode = code;
          return this;
        },
      };

      targetRouter.handle(req as never, res as never, (error?: unknown) => {
        if (error) {
          reject(error);
          return;
        }
        if (!resolved) {
          statusCode = 404;
          responseBody = { success: false, error: { code: 'NOT_FOUND' } };
          finish();
        }
      });
    },
  );
}

async function request(method: string, path: string, opts?: { body?: unknown }) {
  return invokeRouter(router, method, path, opts);
}

// =============================================================================
// POST /api/identity/verify/initiate
// =============================================================================

describe('POST /api/identity/verify/initiate', () => {
  test('returns 200 with attemptId on success', async () => {
    mockVerifyExecute.mockResolvedValue({
      success: true,
      attemptId: 'attempt-001',
      challengeData: { delivery: 'sms' },
    });

    const { status, body } = await request('POST', '/api/identity/verify/initiate', {
      body: {
        method: 'otp',
        identityValue: '+15551234567',
        identityType: 'phone',
      },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.attemptId).toBe('attempt-001');
    expect(body.challengeData).toEqual({ delivery: 'sms' });
  });

  test('passes tenantId and sessionId from auth context to use case', async () => {
    mockVerifyExecute.mockResolvedValue({ success: true, attemptId: 'attempt-002' });

    await request('POST', '/api/identity/verify/initiate', {
      body: {
        method: 'otp',
        identityValue: 'user@example.com',
        identityType: 'email_thread',
      },
    });

    expect(mockVerifyExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-001',
        sessionId: 'sess-abc',
        identityValue: 'user@example.com',
        identityType: 'email_thread',
      }),
    );
  });

  test('returns 400 when method is missing', async () => {
    const { status, body } = await request('POST', '/api/identity/verify/initiate', {
      body: { identityValue: '+15551234567', identityType: 'phone' },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_INPUT');
  });

  test('returns 400 when identityValue is missing', async () => {
    const { status, body } = await request('POST', '/api/identity/verify/initiate', {
      body: { method: 'otp', identityType: 'phone' },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_INPUT');
  });

  test('returns 400 when identityType is missing', async () => {
    const { status, body } = await request('POST', '/api/identity/verify/initiate', {
      body: { method: 'otp', identityValue: '+15551234567' },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_INPUT');
  });

  test('returns error when use case fails', async () => {
    mockVerifyExecute.mockResolvedValue({
      success: false,
      error: { code: 'NO_VERIFIER', message: 'No registered verifier supports the given input' },
    });

    const { status, body } = await request('POST', '/api/identity/verify/initiate', {
      body: { method: 'otp', identityValue: '+15551234567', identityType: 'phone' },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NO_VERIFIER');
  });

  test('returns 500 on unexpected error', async () => {
    mockVerifyExecute.mockRejectedValue(new Error('Unexpected failure'));

    const { status, body } = await request('POST', '/api/identity/verify/initiate', {
      body: { method: 'otp', identityValue: '+15551234567', identityType: 'phone' },
    });

    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});

// =============================================================================
// POST /api/identity/verify/complete
// =============================================================================

describe('POST /api/identity/verify/complete', () => {
  test('returns 200 with verified result on success', async () => {
    mockCompleteVerification.mockResolvedValue({
      success: true,
      identityTier: 2,
      verifiedIdentity: '+15551234567',
    });

    const { status, body } = await request('POST', '/api/identity/verify/complete', {
      body: {
        attemptId: 'attempt-001',
        proof: { type: 'otp_code', value: '123456' },
      },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.identityTier).toBe(2);
    expect(body.verifiedIdentity).toBe('+15551234567');
  });

  test('returns 400 when attemptId is missing', async () => {
    const { status, body } = await request('POST', '/api/identity/verify/complete', {
      body: { proof: { type: 'otp_code', value: '123456' } },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_INPUT');
  });

  test('returns 400 when proof is missing', async () => {
    const { status, body } = await request('POST', '/api/identity/verify/complete', {
      body: { attemptId: 'attempt-001' },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_INPUT');
  });

  test('returns error when verification fails', async () => {
    mockCompleteVerification.mockResolvedValue({
      success: false,
      error: { code: 'INVALID_CODE', message: 'OTP code does not match' },
    });

    const { status, body } = await request('POST', '/api/identity/verify/complete', {
      body: {
        attemptId: 'attempt-001',
        proof: { type: 'otp_code', value: 'wrong-code' },
      },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_CODE');
  });

  test('returns 500 on unexpected error', async () => {
    mockCompleteVerification.mockRejectedValue(new Error('Store unavailable'));

    const { status, body } = await request('POST', '/api/identity/verify/complete', {
      body: {
        attemptId: 'attempt-001',
        proof: { type: 'otp_code', value: '123456' },
      },
    });

    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});

// =============================================================================
// GET /api/identity/verify/:attemptId
// =============================================================================

describe('GET /api/identity/verify/:attemptId', () => {
  test('returns 200 with attempt status', async () => {
    const expiresAt = new Date(Date.now() + 300_000);
    mockTokenStoreGet.mockResolvedValue({
      id: 'attempt-001',
      tenantId: 'tenant-001',
      projectId: 'project-001',
      sessionId: 'sess-abc',
      sessionPrincipalId: 'principal-abc',
      method: 'otp',
      identityValue: '+15551234567',
      identityType: 'phone',
      policySource: 'identity_verification_route',
      grantScope: 'session',
      traceId: 'trace-001',
      status: 'pending',
      attempts: 1,
      maxAttempts: 5,
      createdAt: new Date(),
      expiresAt,
      codeHash: 'hash-abc',
    } satisfies StoredVerificationAttempt);

    const { status, body } = await request('GET', '/api/identity/verify/attempt-001');

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.attemptId).toBe('attempt-001');
    expect(body.data.status).toBe('pending');
    expect(body.data.method).toBe('otp');
    expect(body.data.expiresAt).toBe(expiresAt.toISOString());
  });

  test('passes tenantId from auth context to token store', async () => {
    mockTokenStoreGet.mockResolvedValue(null);

    await request('GET', '/api/identity/verify/attempt-999');

    expect(mockTokenStoreGet).toHaveBeenCalledWith('tenant-001', 'attempt-999');
  });

  test('returns 404 when attempt not found', async () => {
    mockTokenStoreGet.mockResolvedValue(null);

    const { status, body } = await request('GET', '/api/identity/verify/attempt-999');

    expect(status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  test('returns 500 on unexpected error', async () => {
    mockTokenStoreGet.mockRejectedValue(new Error('Redis timeout'));

    const { status, body } = await request('GET', '/api/identity/verify/attempt-001');

    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});

// =============================================================================
// AUTH REQUIRED (401 without auth context)
// =============================================================================

describe('Auth required (401 without auth)', () => {
  async function noAuthRequest(method: string, path: string, opts?: { body?: unknown }) {
    return invokeRouter(noAuthRouter, method, path, { ...opts, withAuth: false });
  }

  test('POST /initiate returns 401 without auth', async () => {
    const { status, body } = await noAuthRequest('POST', '/api/identity/verify/initiate', {
      body: { method: 'otp', identityValue: '+15551234567', identityType: 'phone' },
    });

    expect(status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  test('POST /complete returns 401 without auth', async () => {
    const { status, body } = await noAuthRequest('POST', '/api/identity/verify/complete', {
      body: { attemptId: 'attempt-001', proof: { type: 'otp_code', value: '123456' } },
    });

    expect(status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  test('GET /:attemptId returns 401 without auth', async () => {
    const { status, body } = await noAuthRequest('GET', '/api/identity/verify/attempt-001');

    expect(status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });
});
