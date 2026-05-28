/**
 * OtpVerifier Tests
 *
 * Tests the OTP identity verifier adapter that uses otplib to generate 6-digit codes.
 * OTP verification is two-step: initiate() generates a code and stores a hashed attempt,
 * complete() verifies the submitted code against the stored attempt.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OtpVerifier } from '../../../../contexts/identity/infrastructure/verifiers/otp-verifier.js';
import type { VerificationInput } from '../../../../contexts/identity/domain/identity-verifier.js';
import type {
  VerificationTokenStore,
  StoredVerificationAttempt,
} from '../../../../contexts/identity/infrastructure/verification-token-store.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const HMAC_SECRET = 'test-hmac-secret-for-otp-hashing';

// =============================================================================
// IN-MEMORY TOKEN STORE (test double)
// =============================================================================

/**
 * In-memory implementation of VerificationTokenStore for testing.
 * Uses a Map keyed by `tenantId:attemptId` for tenant isolation.
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
}

// =============================================================================
// HELPERS
// =============================================================================

function makeInput(overrides?: Partial<VerificationInput>): VerificationInput {
  return {
    tenantId: 'tenant-001',
    sessionId: 'sess-abc',
    channelType: 'web',
    identityValue: 'user@example.com',
    identityType: 'email_thread',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('OtpVerifier', () => {
  let verifier: OtpVerifier;
  let tokenStore: InMemoryVerificationTokenStore;

  beforeEach(() => {
    tokenStore = new InMemoryVerificationTokenStore();
    verifier = new OtpVerifier(tokenStore, HMAC_SECRET);
  });

  // ---------------------------------------------------------------------------
  // method
  // ---------------------------------------------------------------------------

  describe('method', () => {
    it('is "otp"', () => {
      expect(verifier.method).toBe('otp');
    });
  });

  // ---------------------------------------------------------------------------
  // supports()
  // ---------------------------------------------------------------------------

  describe('supports()', () => {
    it('returns true for any input (OTP is a general-purpose verifier)', () => {
      const input = makeInput();
      expect(verifier.supports(input)).toBe(true);
    });

    it('returns true regardless of metadata presence', () => {
      expect(verifier.supports(makeInput({ metadata: undefined }))).toBe(true);
      expect(verifier.supports(makeInput({ metadata: { foo: 'bar' } }))).toBe(true);
    });

    it('returns true for different channel types', () => {
      expect(verifier.supports(makeInput({ channelType: 'web' }))).toBe(true);
      expect(verifier.supports(makeInput({ channelType: 'sms' }))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // initiate()
  // ---------------------------------------------------------------------------

  describe('initiate()', () => {
    it('returns success with attemptId and challengeData containing userAction and code', async () => {
      const input = makeInput();

      const result = await verifier.initiate(input);

      expect(result.success).toBe(true);
      expect(result.attemptId).toBeDefined();
      expect(typeof result.attemptId).toBe('string');
      expect(result.challengeData).toBeDefined();
      expect(result.challengeData?.userAction).toBe('enter_otp');
      // The OTP code is returned so orchestration layer can dispatch via channel adapter
      expect(result.challengeData?.code).toBeDefined();
      expect(typeof result.challengeData?.code).toBe('string');
      expect((result.challengeData?.code as string).length).toBe(6);
    });

    it('stores a verification attempt in the token store with hashed code', async () => {
      const input = makeInput();

      const result = await verifier.initiate(input);

      const stored = await tokenStore.get('tenant-001', result.attemptId!);
      expect(stored).not.toBeNull();
      expect(stored!.tenantId).toBe('tenant-001');
      expect(stored!.sessionId).toBe('sess-abc');
      expect(stored!.method).toBe('otp');
      expect(stored!.identityValue).toBe('user@example.com');
      expect(stored!.identityType).toBe('email_thread');
      expect(stored!.status).toBe('pending');
      expect(stored!.attempts).toBe(0);
      expect(stored!.maxAttempts).toBe(5);
      // Code should be hashed, not stored raw
      expect(stored!.codeHash).toBeDefined();
      expect(stored!.codeHash).not.toBe(result.challengeData?.code);
    });

    it('generates different codes for different initiations', async () => {
      const input = makeInput();

      const result1 = await verifier.initiate(input);
      const result2 = await verifier.initiate(input);

      // Different attempt IDs
      expect(result1.attemptId).not.toBe(result2.attemptId);
      // Codes may or may not differ (6-digit random), but attempts are distinct
      expect(result1.attemptId).toBeDefined();
      expect(result2.attemptId).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // complete()
  // ---------------------------------------------------------------------------

  describe('complete()', () => {
    it('returns success with identityTier 2 when code is correct', async () => {
      const input = makeInput();
      const initResult = await verifier.initiate(input);
      const code = initResult.challengeData?.code as string;

      const result = await verifier.complete(initResult.attemptId!, {
        type: 'otp_code',
        value: code,
        metadata: { tenantId: 'tenant-001' },
      });

      expect(result.success).toBe(true);
      expect(result.identityTier).toBe(2);
      expect(result.verifiedIdentity).toBe('user@example.com');
    });

    it('marks attempt as verified in token store on success', async () => {
      const input = makeInput();
      const initResult = await verifier.initiate(input);
      const code = initResult.challengeData?.code as string;

      await verifier.complete(initResult.attemptId!, {
        type: 'otp_code',
        value: code,
        metadata: { tenantId: 'tenant-001' },
      });

      const stored = await tokenStore.get('tenant-001', initResult.attemptId!);
      expect(stored!.status).toBe('verified');
    });

    it('returns failure when code is wrong', async () => {
      const input = makeInput();
      const initResult = await verifier.initiate(input);

      const result = await verifier.complete(initResult.attemptId!, {
        type: 'otp_code',
        value: '000000',
        metadata: { tenantId: 'tenant-001' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('OTP_INVALID');
    });

    it('increments attempt count on wrong code', async () => {
      const input = makeInput();
      const initResult = await verifier.initiate(input);

      await verifier.complete(initResult.attemptId!, {
        type: 'otp_code',
        value: '000000',
        metadata: { tenantId: 'tenant-001' },
      });

      const stored = await tokenStore.get('tenant-001', initResult.attemptId!);
      expect(stored!.attempts).toBe(1);
    });

    it('returns failure when attempt is expired', async () => {
      const input = makeInput();
      const initResult = await verifier.initiate(input);

      // Manually expire the attempt by updating the stored record
      const stored = await tokenStore.get('tenant-001', initResult.attemptId!);
      // Set expiresAt to the past
      (stored as any).expiresAt = new Date(Date.now() - 1000);
      await tokenStore.create(stored!); // overwrite with expired record

      const result = await verifier.complete(initResult.attemptId!, {
        type: 'otp_code',
        value: '123456',
        metadata: { tenantId: 'tenant-001' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('OTP_EXPIRED');
    });

    it('returns failure when rate limit exceeded (>5 attempts)', async () => {
      const input = makeInput();
      const initResult = await verifier.initiate(input);

      // Exhaust all attempts
      for (let i = 0; i < 5; i++) {
        await verifier.complete(initResult.attemptId!, {
          type: 'otp_code',
          value: '000000',
          metadata: { tenantId: 'tenant-001' },
        });
      }

      // 6th attempt should be rejected
      const result = await verifier.complete(initResult.attemptId!, {
        type: 'otp_code',
        value: '123456',
        metadata: { tenantId: 'tenant-001' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('OTP_MAX_ATTEMPTS');
    });

    it('returns failure when attempt is not found', async () => {
      const result = await verifier.complete('nonexistent-attempt', {
        type: 'otp_code',
        value: '123456',
        metadata: { tenantId: 'tenant-001' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('OTP_ATTEMPT_NOT_FOUND');
    });

    it('enforces tenant isolation — cannot complete attempt from different tenant', async () => {
      const input = makeInput({ tenantId: 'tenant-001' });
      const initResult = await verifier.initiate(input);
      const code = initResult.challengeData?.code as string;

      // Try to complete with a different tenantId
      const result = await verifier.complete(initResult.attemptId!, {
        type: 'otp_code',
        value: code,
        metadata: { tenantId: 'tenant-002' },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('OTP_ATTEMPT_NOT_FOUND');
    });
  });
});
