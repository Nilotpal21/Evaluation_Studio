/**
 * Email Link Verifier Tests
 *
 * Validates the email link (magic link) verification flow:
 * - initiate() generates a token, stores hashed version in codeHash, returns raw token in challengeData
 * - complete() with valid token -> verified (success: true, identityTier: 2)
 * - complete() with already-used token -> rejected
 * - complete() with expired token -> expired
 * - supports() returns true for any input
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { EmailLinkVerifier } from '../../../../contexts/identity/infrastructure/verifiers/email-link-verifier.js';
import type { VerificationInput } from '../../../../contexts/identity/domain/identity-verifier.js';
import type {
  VerificationTokenStore,
  StoredVerificationAttempt,
} from '../../../../contexts/identity/infrastructure/verification-token-store.js';

// =============================================================================
// HELPERS
// =============================================================================

const SIGNING_KEY = 'test-signing-key-for-hmac-256';

function makeInput(overrides?: Partial<VerificationInput>): VerificationInput {
  return {
    tenantId: 'tenant-001',
    sessionId: 'sess-abc',
    channelType: 'web',
    identityValue: 'user@example.com',
    identityType: 'email',
    ...overrides,
  };
}

function hmacHash(value: string, key: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

function createMockStore(): VerificationTokenStore {
  const storage = new Map<string, StoredVerificationAttempt>();

  return {
    create: vi.fn(async (attempt: StoredVerificationAttempt) => {
      storage.set(`${attempt.tenantId}:${attempt.id}`, { ...attempt });
    }),
    get: vi.fn(async (tenantId: string, attemptId: string) => {
      const attempt = storage.get(`${tenantId}:${attemptId}`);
      return attempt ? { ...attempt } : null;
    }),
    incrementAttempts: vi.fn(async (tenantId: string, attemptId: string) => {
      const attempt = storage.get(`${tenantId}:${attemptId}`);
      if (attempt) {
        const updated = { ...attempt, attempts: attempt.attempts + 1 };
        storage.set(`${tenantId}:${attemptId}`, updated);
      }
    }),
    markVerified: vi.fn(async (tenantId: string, attemptId: string) => {
      const attempt = storage.get(`${tenantId}:${attemptId}`);
      if (attempt) {
        const updated = { ...attempt, status: 'verified' as const };
        storage.set(`${tenantId}:${attemptId}`, updated);
      }
    }),
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('EmailLinkVerifier', () => {
  let store: VerificationTokenStore;
  let verifier: EmailLinkVerifier;

  beforeEach(() => {
    store = createMockStore();
    verifier = new EmailLinkVerifier(SIGNING_KEY, store);
  });

  describe('supports()', () => {
    it('returns true for any input (email link is triggered by orchestration)', () => {
      expect(verifier.supports(makeInput())).toBe(true);
    });

    it('returns true regardless of channel type or identity type', () => {
      expect(verifier.supports(makeInput({ channelType: 'voice', identityType: 'phone' }))).toBe(
        true,
      );
      expect(verifier.supports(makeInput({ channelType: 'sms', identityType: 'cookie' }))).toBe(
        true,
      );
    });
  });

  describe('initiate()', () => {
    it('generates token, stores hashed version in codeHash, returns raw token in challengeData', async () => {
      const input = makeInput();
      const result = await verifier.initiate(input);

      expect(result.success).toBe(true);
      expect(result.attemptId).toBeDefined();
      expect(result.challengeData).toBeDefined();
      expect(result.challengeData?.userAction).toBe('check_email');
      expect(typeof result.challengeData?.token).toBe('string');
      expect((result.challengeData?.token as string).length).toBeGreaterThan(0);

      // Verify the store was called with a hashed token in codeHash (not the raw token)
      expect(store.create).toHaveBeenCalledTimes(1);
      const storedAttempt = (store.create as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as StoredVerificationAttempt;
      expect(storedAttempt.tenantId).toBe('tenant-001');
      expect(storedAttempt.sessionId).toBe('sess-abc');
      expect(storedAttempt.method).toBe('email_link');
      expect(storedAttempt.status).toBe('pending');
      expect(storedAttempt.identityValue).toBe('user@example.com');

      // The codeHash should be the HMAC of the raw token
      const rawToken = result.challengeData?.token as string;
      const expectedHash = hmacHash(rawToken, SIGNING_KEY);
      expect(storedAttempt.codeHash).toBe(expectedHash);
    });

    it('generates unique attempt IDs across calls', async () => {
      const result1 = await verifier.initiate(makeInput());
      const result2 = await verifier.initiate(makeInput());

      expect(result1.attemptId).not.toBe(result2.attemptId);
    });

    it('generates unique tokens across calls', async () => {
      const result1 = await verifier.initiate(makeInput());
      const result2 = await verifier.initiate(makeInput());

      expect(result1.challengeData?.token).not.toBe(result2.challengeData?.token);
    });
  });

  describe('complete()', () => {
    it('verifies successfully with a valid token', async () => {
      const input = makeInput();
      const initResult = await verifier.initiate(input);
      const rawToken = initResult.challengeData?.token as string;
      const attemptId = initResult.attemptId!;

      const result = await verifier.complete(attemptId, {
        type: 'otp_code',
        value: rawToken,
        metadata: { tenantId: 'tenant-001' },
      });

      expect(result.success).toBe(true);
      expect(result.identityTier).toBe(2);
      expect(result.verifiedIdentity).toBe('user@example.com');
      expect(store.markVerified).toHaveBeenCalledWith('tenant-001', attemptId);
    });

    it('rejects an already-used (verified) token', async () => {
      const input = makeInput();
      const initResult = await verifier.initiate(input);
      const rawToken = initResult.challengeData?.token as string;
      const attemptId = initResult.attemptId!;

      // First completion succeeds
      await verifier.complete(attemptId, {
        type: 'otp_code',
        value: rawToken,
        metadata: { tenantId: 'tenant-001' },
      });

      // Second completion with same token should be rejected
      const result = await verifier.complete(attemptId, {
        type: 'otp_code',
        value: rawToken,
        metadata: { tenantId: 'tenant-001' },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ALREADY_VERIFIED');
    });

    it('rejects an expired token', async () => {
      const input = makeInput();
      const initResult = await verifier.initiate(input);
      const rawToken = initResult.challengeData?.token as string;
      const attemptId = initResult.attemptId!;

      // Manipulate the stored attempt to be expired by mocking get to return expired attempt
      const storedAttempt = await store.get('tenant-001', attemptId);
      if (storedAttempt) {
        const expiredAttempt: StoredVerificationAttempt = {
          ...storedAttempt,
          expiresAt: new Date(Date.now() - 1000),
        };
        (store.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(expiredAttempt);
      }

      const result = await verifier.complete(attemptId, {
        type: 'otp_code',
        value: rawToken,
        metadata: { tenantId: 'tenant-001' },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TOKEN_EXPIRED');
    });

    it('rejects when attempt is not found', async () => {
      const result = await verifier.complete('nonexistent-attempt', {
        type: 'otp_code',
        value: 'some-token',
        metadata: { tenantId: 'tenant-001' },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ATTEMPT_NOT_FOUND');
    });

    it('rejects when token hash does not match', async () => {
      const input = makeInput();
      const initResult = await verifier.initiate(input);
      const attemptId = initResult.attemptId!;

      const result = await verifier.complete(attemptId, {
        type: 'otp_code',
        value: 'wrong-token-value',
        metadata: { tenantId: 'tenant-001' },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TOKEN_MISMATCH');
      expect(store.incrementAttempts).toHaveBeenCalledWith('tenant-001', attemptId);
    });
  });

  describe('method', () => {
    it('reports email_link as its verification method', () => {
      expect(verifier.method).toBe('email_link');
    });
  });
});
