/**
 * Promote Tier Use Case Tests
 *
 * Validates tier promotion logic: valid promotions, no-ops, and rejections.
 * Pure domain logic -- no infrastructure dependencies.
 */

import { describe, it, expect } from 'vitest';
import { PromoteTier } from '../../../../contexts/identity/use-cases/promote-tier.js';
import type { IdentityTier, VerificationMethod } from '@agent-platform/shared/types';

// =============================================================================
// TESTS
// =============================================================================

describe('PromoteTier', () => {
  const useCase = new PromoteTier();

  describe('execute()', () => {
    it('promotes from tier 0 to tier 1 with cookie verification', () => {
      const result = useCase.execute({
        currentTier: 0,
        verificationMethod: 'cookie',
      });

      expect(result.success).toBe(true);
      expect(result.newTier).toBe(1);
      expect(result.verificationMethod).toBe('cookie');
    });

    it('promotes from tier 0 to tier 2 with hmac verification', () => {
      const result = useCase.execute({
        currentTier: 0,
        verificationMethod: 'hmac',
      });

      expect(result.success).toBe(true);
      expect(result.newTier).toBe(2);
      expect(result.verificationMethod).toBe('hmac');
    });

    it('promotes from tier 1 to tier 2 with otp verification', () => {
      const result = useCase.execute({
        currentTier: 1,
        verificationMethod: 'otp',
      });

      expect(result.success).toBe(true);
      expect(result.newTier).toBe(2);
      expect(result.verificationMethod).toBe('otp');
    });

    it('promotes from tier 1 to tier 2 with oauth verification', () => {
      const result = useCase.execute({
        currentTier: 1,
        verificationMethod: 'oauth',
      });

      expect(result.success).toBe(true);
      expect(result.newTier).toBe(2);
      expect(result.verificationMethod).toBe('oauth');
    });

    it('rejects same-tier promotion (tier 1 -> cookie yields tier 1, no-op)', () => {
      const result = useCase.execute({
        currentTier: 1,
        verificationMethod: 'cookie',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TIER_NOT_PROMOTED');
    });

    it('rejects same-tier no-op (tier 2 -> hmac yields tier 2)', () => {
      const result = useCase.execute({
        currentTier: 2,
        verificationMethod: 'hmac',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TIER_NOT_PROMOTED');
    });

    it('rejects downgrade from tier 2 to tier 1 (caller_id yields tier 1)', () => {
      const result = useCase.execute({
        currentTier: 2,
        verificationMethod: 'caller_id',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TIER_NOT_PROMOTED');
    });

    it('rejects downgrade from tier 1 to tier 0 (none yields tier 0)', () => {
      const result = useCase.execute({
        currentTier: 1,
        verificationMethod: 'none',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TIER_NOT_PROMOTED');
    });

    it('promotes from tier 0 to tier 1 with provider verification', () => {
      const result = useCase.execute({
        currentTier: 0,
        verificationMethod: 'provider',
      });

      expect(result.success).toBe(true);
      expect(result.newTier).toBe(1);
      expect(result.verificationMethod).toBe('provider');
    });

    it('allows provider verification to promote to tier 2 when policy resolves a stronger tier', () => {
      const result = useCase.execute({
        currentTier: 0,
        verificationMethod: 'provider',
        resolvedTier: 2,
      });

      expect(result.success).toBe(true);
      expect(result.newTier).toBe(2);
      expect(result.verificationMethod).toBe('provider');
    });

    it('returns the verification method in successful promotions', () => {
      const result = useCase.execute({
        currentTier: 0,
        verificationMethod: 'otp',
      });

      expect(result.success).toBe(true);
      expect(result.verificationMethod).toBe('otp');
      expect(result.newTier).toBe(2);
    });
  });
});
