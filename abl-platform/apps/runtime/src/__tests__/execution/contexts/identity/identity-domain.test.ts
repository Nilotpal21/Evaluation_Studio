/**
 * Identity Domain Types Tests
 *
 * Validates identity artifact hashing, tier promotion logic,
 * verification attempt lifecycle, and session resolution key format.
 */

import { describe, it, expect } from 'vitest';
import { hash, create } from '../../../../contexts/identity/domain/identity-artifact.js';
import {
  canPromoteTo,
  tierFromVerification,
} from '../../../../contexts/identity/domain/identity-tier.js';
import {
  createVerificationAttempt,
  isExpired,
  canAttempt,
} from '../../../../contexts/identity/domain/verification-attempt.js';
import { buildResolutionKeyId } from '../../../../contexts/identity/domain/session-resolution-key.js';
import type { IdentityTier } from '../../../../contexts/identity/domain/identity-tier.js';
import type { VerificationAttempt } from '../../../../contexts/identity/domain/verification-attempt.js';

// =============================================================================
// IdentityArtifact
// =============================================================================

describe('IdentityArtifact', () => {
  describe('hash()', () => {
    it('produces a consistent SHA-256 hex string (64 chars)', () => {
      const result = hash('test-artifact-value');
      expect(result).toHaveLength(64);
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('same input produces same output', () => {
      const a = hash('identical-input');
      const b = hash('identical-input');
      expect(a).toBe(b);
    });

    it('different input produces different output', () => {
      const a = hash('input-alpha');
      const b = hash('input-beta');
      expect(a).not.toBe(b);
    });
  });

  describe('create()', () => {
    it('sets rawValue, artifactType, and hashedValue', () => {
      const artifact = create('+15551234567', 'phone');
      expect(artifact.rawValue).toBe('+15551234567');
      expect(artifact.artifactType).toBe('phone');
      expect(artifact.hashedValue).toHaveLength(64);
      expect(artifact.hashedValue).toBe(hash('+15551234567'));
    });
  });
});

// =============================================================================
// Identity Tier
// =============================================================================

describe('Identity Tier', () => {
  describe('canPromoteTo()', () => {
    it('allows promotion from tier 0 to tier 1', () => {
      expect(canPromoteTo(0, 1)).toBe(true);
    });

    it('allows promotion from tier 0 to tier 2', () => {
      expect(canPromoteTo(0, 2)).toBe(true);
    });

    it('allows promotion from tier 1 to tier 2', () => {
      expect(canPromoteTo(1, 2)).toBe(true);
    });

    it('rejects downgrade from tier 2 to tier 1', () => {
      expect(canPromoteTo(2, 1)).toBe(false);
    });

    it('rejects same-tier promotion (1 -> 1)', () => {
      expect(canPromoteTo(1, 1)).toBe(false);
    });

    it('rejects downgrade from tier 2 to tier 0', () => {
      expect(canPromoteTo(2, 0)).toBe(false);
    });
  });

  describe('tierFromVerification()', () => {
    it('maps hmac to tier 2', () => {
      expect(tierFromVerification('hmac')).toBe(2 as IdentityTier);
    });

    it('maps otp to tier 2', () => {
      expect(tierFromVerification('otp')).toBe(2 as IdentityTier);
    });

    it('maps oauth to tier 2', () => {
      expect(tierFromVerification('oauth')).toBe(2 as IdentityTier);
    });

    it('maps none to tier 0', () => {
      expect(tierFromVerification('none')).toBe(0 as IdentityTier);
    });

    it('maps cookie to tier 1', () => {
      expect(tierFromVerification('cookie')).toBe(1 as IdentityTier);
    });

    it('maps caller_id to tier 1', () => {
      expect(tierFromVerification('caller_id')).toBe(1 as IdentityTier);
    });

    it('maps provider to tier 1', () => {
      expect(tierFromVerification('provider')).toBe(1 as IdentityTier);
    });

    it('maps email_link to tier 2', () => {
      expect(tierFromVerification('email_link')).toBe(2 as IdentityTier);
    });

    it('maps webhook to tier 1', () => {
      expect(tierFromVerification('webhook')).toBe(1 as IdentityTier);
    });
  });
});

// =============================================================================
// Verification Attempt
// =============================================================================

describe('VerificationAttempt', () => {
  const FIVE_MINUTES_MS = 5 * 60 * 1000;

  function makeFreshAttempt(overrides?: Partial<Parameters<typeof createVerificationAttempt>[0]>) {
    return createVerificationAttempt({
      tenantId: 'tenant-001',
      sessionId: 'sess-abc',
      method: 'otp',
      identityValue: '+15551234567',
      identityType: 'phone',
      expiresAt: new Date(Date.now() + FIVE_MINUTES_MS),
      ...overrides,
    });
  }

  describe('createVerificationAttempt()', () => {
    it('sets id, status=pending, and attempts=0', () => {
      const attempt = makeFreshAttempt();
      expect(attempt.id).toBeDefined();
      expect(attempt.id).toHaveLength(36); // UUID format
      expect(attempt.status).toBe('pending');
      expect(attempt.attempts).toBe(0);
    });

    it('uses default maxAttempts of 5', () => {
      const attempt = makeFreshAttempt();
      expect(attempt.maxAttempts).toBe(5);
    });

    it('allows custom maxAttempts', () => {
      const attempt = makeFreshAttempt({ maxAttempts: 3 });
      expect(attempt.maxAttempts).toBe(3);
    });
  });

  describe('isExpired()', () => {
    it('returns true when past expiresAt', () => {
      const attempt = makeFreshAttempt();
      // Mutate expiresAt to the past via a cast for testing
      const expired: VerificationAttempt = {
        ...attempt,
        expiresAt: new Date(Date.now() - 1000),
      };
      expect(isExpired(expired)).toBe(true);
    });

    it('returns false when before expiresAt', () => {
      const attempt = makeFreshAttempt();
      expect(isExpired(attempt)).toBe(false);
    });
  });

  describe('canAttempt()', () => {
    it('returns true for a fresh attempt', () => {
      const attempt = makeFreshAttempt();
      expect(canAttempt(attempt)).toBe(true);
    });

    it('returns false when maxAttempts reached', () => {
      const attempt = makeFreshAttempt();
      attempt.attempts = attempt.maxAttempts;
      expect(canAttempt(attempt)).toBe(false);
    });

    it('returns false when expired', () => {
      const expired: VerificationAttempt = {
        ...makeFreshAttempt(),
        expiresAt: new Date(Date.now() - 1000),
      };
      expect(canAttempt(expired)).toBe(false);
    });

    it('returns false when status is not pending', () => {
      const attempt = makeFreshAttempt();
      attempt.status = 'verified';
      expect(canAttempt(attempt)).toBe(false);
    });

    it('returns false when status is failed', () => {
      const attempt = makeFreshAttempt();
      attempt.status = 'failed';
      expect(canAttempt(attempt)).toBe(false);
    });
  });
});

// =============================================================================
// Session Resolution Key
// =============================================================================

describe('SessionResolutionKey', () => {
  describe('buildResolutionKeyId()', () => {
    it('produces the correct tenant-scoped format', () => {
      const key = buildResolutionKeyId('tenant-001', 'ch-web-main', 'abc123hash');
      expect(key).toBe('session_resolution:tenant-001:ch-web-main:abc123hash');
    });

    it('includes all three components in the key', () => {
      const key = buildResolutionKeyId('t1', 'c2', 'h3');
      const parts = key.split(':');
      expect(parts[0]).toBe('session_resolution');
      expect(parts[1]).toBe('t1');
      expect(parts[2]).toBe('c2');
      expect(parts[3]).toBe('h3');
    });
  });
});
