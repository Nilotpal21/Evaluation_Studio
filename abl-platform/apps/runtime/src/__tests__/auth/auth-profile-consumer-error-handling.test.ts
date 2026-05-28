/**
 * Auth Profile Consumer Error Handling Tests
 *
 * Verifies that consumers properly throw when authProfileId is set
 * but the profile is not found (rather than silently falling back).
 *
 * Tests both:
 * 1. The resolver itself (returns null on missing profile)
 * 2. The dualReadCredentials helper (propagates resolve() errors, no silent fallback)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn().mockReturnValue({
  catch: vi.fn(),
});

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    findOne: (...args: any[]) => mockFindOne(...args),
    updateOne: (...args: any[]) => mockUpdateOne(...args),
  },
}));

// ---------------------------------------------------------------------------
// SUT
// ---------------------------------------------------------------------------

import { resolveAuthProfileCredentials } from '../../services/auth-profile-resolver.js';
import { dualReadCredentials } from '@agent-platform/shared/services/auth-profile';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Auth profile consumer error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolveAuthProfileCredentials returns null when profile not found', async () => {
    mockFindOne.mockResolvedValue(null);

    const result = await resolveAuthProfileCredentials('nonexistent-id', 'tenant-1');
    expect(result).toBeNull();
  });

  it('resolveAuthProfileCredentials returns credentials when profile found', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'profile-1',
      tenantId: 'tenant-1',
      authType: 'api_key',
      config: { headerName: 'X-Api-Key' },
      encryptedSecrets: '{"apiKey":"secret-key"}',
      lastUsedAt: new Date(),
      status: 'active',
    });

    const result = await resolveAuthProfileCredentials('profile-1', 'tenant-1');
    expect(result).not.toBeNull();
    expect(result!.authType).toBe('api_key');
    expect(result!.secrets).toEqual({ apiKey: 'secret-key' });
  });

  it('dualReadCredentials propagates resolve() errors when authProfileId is set', async () => {
    // This tests the actual dualReadCredentials function from the shared package.
    // When authProfileId is set, errors from resolve() must propagate — not
    // silently fall back to legacy.
    mockFindOne.mockResolvedValue(null);

    const resolveError = new Error('Auth profile missing-id not found or expired');

    await expect(
      dualReadCredentials({
        authProfileId: 'missing-id',
        tenantId: 'tenant-1',
        consumer: 'TestConsumer',
        resolve: async () => {
          // This simulates the VoiceServiceFactory pattern:
          // resolve the profile, throw if not found
          const profile = await resolveAuthProfileCredentials('missing-id', 'tenant-1');
          if (!profile) {
            throw resolveError;
          }
          return profile;
        },
        legacyFallback: async () => {
          // Legacy fallback should NOT be called when authProfileId is set
          return { profileId: 'legacy', authType: 'api_key', config: {}, secrets: {} };
        },
      }),
    ).rejects.toThrow('Auth profile missing-id not found or expired');
  });

  it('dualReadCredentials uses legacy fallback when authProfileId is absent', async () => {
    const result = await dualReadCredentials({
      authProfileId: null,
      tenantId: 'tenant-1',
      consumer: 'TestConsumer',
      resolve: async () => {
        throw new Error('Should not be called');
      },
      legacyFallback: async () => {
        return { apiKey: 'legacy-key' };
      },
    });

    expect(result.source).toBe('legacy');
    expect(result.credentials).toEqual({ apiKey: 'legacy-key' });
  });
});
