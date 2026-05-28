/**
 * Master Key Rotation E2E Tests
 *
 * Validates the grace period mechanism using resolveWithGracePeriod.
 *
 * No mocks. No DB.
 */

import { describe, it, expect } from 'vitest';
import { resolveWithGracePeriod } from '../../services/auth-profile/index.js';

// ─── Tests ─────────────────────────────────────────────────────────────

describe('Master Key Rotation E2E', () => {
  describe('Gap 4: Grace period mechanism', () => {
    it('resolveWithGracePeriod returns primary secrets when valid', async () => {
      const secrets = JSON.stringify({ apiKey: 'primary-key' });

      const result = await resolveWithGracePeriod(
        {
          encryptedSecrets: secrets,
          previousEncryptedSecrets: JSON.stringify({ apiKey: 'old-key' }),
          rotationGracePeriodMs: 300_000,
          updatedAt: new Date(),
        },
        async (value) => value, // Identity — plugin already decrypted
      );

      expect(result).toEqual({ apiKey: 'primary-key' });
    });

    it('resolveWithGracePeriod falls back to previous within grace window', async () => {
      const result = await resolveWithGracePeriod(
        {
          encryptedSecrets: 'not-valid-json', // Primary fails
          previousEncryptedSecrets: JSON.stringify({ apiKey: 'fallback-key' }),
          rotationGracePeriodMs: 300_000,
          updatedAt: new Date(), // Within grace window
        },
        async (value) => value,
      );

      expect(result).toEqual({ apiKey: 'fallback-key' });
    });

    it('resolveWithGracePeriod throws when grace window expired', async () => {
      const longAgo = new Date(Date.now() - 600_000); // 10 min ago

      await expect(
        resolveWithGracePeriod(
          {
            encryptedSecrets: 'not-valid-json',
            previousEncryptedSecrets: JSON.stringify({ apiKey: 'old' }),
            rotationGracePeriodMs: 300_000, // 5 min window
            updatedAt: longAgo,
          },
          async (value) => value,
        ),
      ).rejects.toThrow();
    });

    it('resolveWithGracePeriod throws when no previous secrets exist', async () => {
      await expect(
        resolveWithGracePeriod(
          {
            encryptedSecrets: 'not-valid-json',
            previousEncryptedSecrets: undefined,
            rotationGracePeriodMs: 300_000,
            updatedAt: new Date(),
          },
          async (value) => value,
        ),
      ).rejects.toThrow();
    });
  });
});
