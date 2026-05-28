/**
 * Verify Identity Use Case Tests
 *
 * Validates that the verify-identity use case dispatches to the correct verifier
 * based on the verification input, and handles fallback when no verifier supports the input.
 */

import { describe, it, expect, vi } from 'vitest';
import { VerifyIdentity } from '../../../../contexts/identity/use-cases/verify-identity.js';
import type {
  IdentityVerifier,
  VerificationInput,
  VerificationInitResult,
  VerificationProof,
  VerificationResult,
} from '../../../../contexts/identity/domain/identity-verifier.js';
import type { VerificationMethod } from '@agent-platform/shared/types';

// =============================================================================
// HELPERS
// =============================================================================

function makeInput(overrides?: Partial<VerificationInput>): VerificationInput {
  return {
    tenantId: 'tenant-001',
    sessionId: 'sess-abc',
    channelType: 'web',
    identityValue: '+15551234567',
    identityType: 'phone',
    ...overrides,
  };
}

function createMockVerifier(
  method: VerificationMethod,
  supportsResult: boolean,
  initiateResult?: VerificationInitResult,
): IdentityVerifier {
  return {
    method,
    supports: vi.fn().mockReturnValue(supportsResult),
    initiate: vi
      .fn()
      .mockResolvedValue(initiateResult ?? { success: true, attemptId: 'attempt-123' }),
    complete: vi.fn().mockResolvedValue({ success: true, identityTier: 2 }),
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('VerifyIdentity', () => {
  describe('execute()', () => {
    it('dispatches to the verifier that supports the input', async () => {
      const otpVerifier = createMockVerifier('otp', true);
      const hmacVerifier = createMockVerifier('hmac', false);

      const verifiers = new Map<VerificationMethod, IdentityVerifier>([
        ['otp', otpVerifier],
        ['hmac', hmacVerifier],
      ]);

      const useCase = new VerifyIdentity(verifiers);
      const input = makeInput();
      const result = await useCase.execute(input);

      expect(result.success).toBe(true);
      expect(result.attemptId).toBe('attempt-123');
      expect(otpVerifier.supports).toHaveBeenCalledWith(input);
      expect(otpVerifier.initiate).toHaveBeenCalledWith(input);
    });

    it('skips verifiers that do not support the input', async () => {
      const hmacVerifier = createMockVerifier('hmac', false);
      const otpVerifier = createMockVerifier('otp', true, {
        success: true,
        attemptId: 'attempt-otp-001',
      });

      const verifiers = new Map<VerificationMethod, IdentityVerifier>([
        ['hmac', hmacVerifier],
        ['otp', otpVerifier],
      ]);

      const useCase = new VerifyIdentity(verifiers);
      const result = await useCase.execute(makeInput());

      expect(hmacVerifier.supports).toHaveBeenCalled();
      expect(hmacVerifier.initiate).not.toHaveBeenCalled();
      expect(otpVerifier.initiate).toHaveBeenCalled();
      expect(result.attemptId).toBe('attempt-otp-001');
    });

    it('returns error when no verifier supports the input', async () => {
      const hmacVerifier = createMockVerifier('hmac', false);
      const otpVerifier = createMockVerifier('otp', false);

      const verifiers = new Map<VerificationMethod, IdentityVerifier>([
        ['hmac', hmacVerifier],
        ['otp', otpVerifier],
      ]);

      const useCase = new VerifyIdentity(verifiers);
      const result = await useCase.execute(makeInput());

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('NO_VERIFIER');
    });

    it('returns error when verifier registry is empty', async () => {
      const verifiers = new Map<VerificationMethod, IdentityVerifier>();
      const useCase = new VerifyIdentity(verifiers);
      const result = await useCase.execute(makeInput());

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NO_VERIFIER');
    });

    it('propagates verifier initiation failure', async () => {
      const failingVerifier = createMockVerifier('otp', true, {
        success: false,
        error: { code: 'OTP_SEND_FAILED', message: 'SMS delivery failed' },
      });

      const verifiers = new Map<VerificationMethod, IdentityVerifier>([['otp', failingVerifier]]);

      const useCase = new VerifyIdentity(verifiers);
      const result = await useCase.execute(makeInput());

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('OTP_SEND_FAILED');
    });
  });
});
