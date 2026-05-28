/**
 * HmacVerifier Tests
 *
 * Tests the HMAC identity verifier adapter that wraps the existing verifyHMAC
 * function from artifact-hasher.ts. HMAC verification is synchronous — initiate()
 * performs the verification immediately; complete() is a no-op.
 */

import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HmacVerifier } from '../../../../contexts/identity/infrastructure/verifiers/hmac-verifier.js';
import type { VerificationInput } from '../../../../contexts/identity/domain/identity-verifier.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const SECRET_KEY = 'test-secret-key-for-hmac-verification';
const USER_ID = 'user-abc-123';

// =============================================================================
// HELPERS
// =============================================================================

function makeValidHmac(userId: string, timestamp: number, secretKey: string): string {
  return createHmac('sha256', secretKey).update(`${userId}:${timestamp}`).digest('hex');
}

function makeInput(overrides?: Partial<VerificationInput>): VerificationInput {
  return {
    tenantId: 'tenant-001',
    sessionId: 'sess-abc',
    channelType: 'web',
    identityValue: USER_ID,
    identityType: 'cookie',
    ...overrides,
  };
}

function currentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

// =============================================================================
// TESTS
// =============================================================================

describe('HmacVerifier', () => {
  let verifier: HmacVerifier;

  beforeEach(() => {
    verifier = new HmacVerifier(SECRET_KEY);
  });

  // ---------------------------------------------------------------------------
  // supports()
  // ---------------------------------------------------------------------------

  describe('supports()', () => {
    it('returns true when metadata contains hmac and timestamp', () => {
      const ts = currentTimestamp();
      const hmac = makeValidHmac(USER_ID, ts, SECRET_KEY);
      const input = makeInput({
        metadata: { hmac, timestamp: ts },
      });

      expect(verifier.supports(input)).toBe(true);
    });

    it('returns false when metadata is missing', () => {
      const input = makeInput({ metadata: undefined });
      expect(verifier.supports(input)).toBe(false);
    });

    it('returns false when metadata lacks hmac field', () => {
      const input = makeInput({
        metadata: { timestamp: currentTimestamp() },
      });
      expect(verifier.supports(input)).toBe(false);
    });

    it('returns false when metadata lacks timestamp field', () => {
      const input = makeInput({
        metadata: { hmac: 'a'.repeat(64) },
      });
      expect(verifier.supports(input)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // method
  // ---------------------------------------------------------------------------

  describe('method', () => {
    it('is "hmac"', () => {
      expect(verifier.method).toBe('hmac');
    });
  });

  // ---------------------------------------------------------------------------
  // initiate()
  // ---------------------------------------------------------------------------

  describe('initiate()', () => {
    it('returns immediate success for a valid HMAC signature', async () => {
      const ts = currentTimestamp();
      const hmac = makeValidHmac(USER_ID, ts, SECRET_KEY);
      const input = makeInput({
        metadata: { hmac, timestamp: ts },
      });

      const result = await verifier.initiate(input);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('returns failure for an invalid HMAC signature', async () => {
      const ts = currentTimestamp();
      // Wrong HMAC — use a different key
      const wrongHmac = makeValidHmac(USER_ID, ts, 'wrong-secret-key');
      const input = makeInput({
        metadata: { hmac: wrongHmac, timestamp: ts },
      });

      const result = await verifier.initiate(input);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('HMAC_INVALID');
    });

    it('returns failure for an expired timestamp', async () => {
      const expiredTs = currentTimestamp() - 600; // 10 minutes ago, well past 5-minute window
      const hmac = makeValidHmac(USER_ID, expiredTs, SECRET_KEY);
      const input = makeInput({
        metadata: { hmac, timestamp: expiredTs },
      });

      const result = await verifier.initiate(input);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('HMAC_EXPIRED');
    });

    it('returns failure for malformed HMAC format', async () => {
      const ts = currentTimestamp();
      const input = makeInput({
        metadata: { hmac: 'not-a-valid-hex-string', timestamp: ts },
      });

      const result = await verifier.initiate(input);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('HMAC_INVALID');
    });

    it('returns failure when metadata is missing', async () => {
      const input = makeInput({ metadata: undefined });

      const result = await verifier.initiate(input);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('HMAC_MISSING_METADATA');
    });
  });

  // ---------------------------------------------------------------------------
  // complete()
  // ---------------------------------------------------------------------------

  describe('complete()', () => {
    it('returns success as a no-op (HMAC is single-step)', async () => {
      const result = await verifier.complete('any-attempt-id', {
        type: 'hmac_signature',
        value: 'unused',
      });

      expect(result.success).toBe(true);
      expect(result.identityTier).toBe(2);
    });
  });
});
