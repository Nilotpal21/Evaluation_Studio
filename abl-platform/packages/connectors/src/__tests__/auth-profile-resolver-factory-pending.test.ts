/**
 * ABLP-619 — connector resolver factory must throw AUTH_PROFILE_NOT_AUTHORIZED
 * (HTTP 403) for profiles in 'pending_authorization' state, distinct from the
 * generic "reactivate it" message used for revoked/expired/invalid statuses.
 *
 * The resolver factory is fully DI: its `authProfileModel` parameter is the
 * only injection point, so this test passes a stub document directly — no
 * `vi.mock` of platform packages.
 */
import { describe, it, expect, vi } from 'vitest';
import { AuthProfileError } from '@agent-platform/shared/services/auth-profile';
import {
  createAuthProfileResolver,
  type AuthProfileDocument,
  type AuthProfileModelLike,
} from '../services/auth-profile-resolver-factory.js';

function makeStubModel(profile: AuthProfileDocument | null): AuthProfileModelLike {
  return {
    findOne: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(profile),
    }),
  };
}

function makeProfile(overrides: Partial<AuthProfileDocument> = {}): AuthProfileDocument {
  return {
    _id: 'ap-1',
    tenantId: 'tenant-1',
    projectId: null,
    status: 'active',
    config: { headerName: 'X-Api-Key' },
    encryptedSecrets: '{"apiKey":"k"}',
    ...overrides,
  };
}

describe('createAuthProfileResolver — pending_authorization handling', () => {
  it('throws AuthProfileError(AUTH_PROFILE_NOT_AUTHORIZED, 403) when profile is pending_authorization', async () => {
    const resolver = createAuthProfileResolver({
      authProfileModel: makeStubModel(makeProfile({ status: 'pending_authorization' })),
    });

    await expect(
      resolver.resolve({ authProfileId: 'ap-1', tenantId: 'tenant-1' }),
    ).rejects.toBeInstanceOf(AuthProfileError);

    try {
      await resolver.resolve({ authProfileId: 'ap-1', tenantId: 'tenant-1' });
      expect.fail('expected resolver.resolve to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthProfileError);
      const apErr = err as AuthProfileError;
      expect(apErr.code).toBe('AUTH_PROFILE_NOT_AUTHORIZED');
      expect(apErr.statusCode).toBe(403);
      // The user-facing message must instruct the user how to recover and must
      // not contain the misleading "reactivate" verb used for revoked/expired.
      expect(apErr.message).toContain('Authorize');
      expect(apErr.message).not.toContain('reactivate');
    }
  });

  it('still throws the legacy generic Error for revoked/expired/invalid statuses', async () => {
    for (const status of ['revoked', 'expired', 'invalid'] as const) {
      const resolver = createAuthProfileResolver({
        authProfileModel: makeStubModel(makeProfile({ status })),
      });

      await expect(
        resolver.resolve({ authProfileId: 'ap-1', tenantId: 'tenant-1' }),
      ).rejects.toThrow(/reactivate it before testing/);

      try {
        await resolver.resolve({ authProfileId: 'ap-1', tenantId: 'tenant-1' });
        expect.fail('expected resolver.resolve to throw');
      } catch (err) {
        // Generic non-active rejection is intentionally NOT an AuthProfileError —
        // those callers fall through the legacy code path until later refactors.
        expect(err).not.toBeInstanceOf(AuthProfileError);
      }
    }
  });

  it('resolves successfully when status is active (regression — no behavior change for happy path)', async () => {
    const resolver = createAuthProfileResolver({
      authProfileModel: makeStubModel(makeProfile({ status: 'active' })),
    });

    const result = await resolver.resolve({ authProfileId: 'ap-1', tenantId: 'tenant-1' });
    expect(result).toEqual({ headerName: 'X-Api-Key', apiKey: 'k' });
  });

  it('throws "Auth profile not found" when the model returns null (unrelated to the new branch)', async () => {
    const resolver = createAuthProfileResolver({
      authProfileModel: makeStubModel(null),
    });

    await expect(
      resolver.resolve({ authProfileId: 'ap-missing', tenantId: 'tenant-1' }),
    ).rejects.toThrow(/Auth profile not found: ap-missing/);
  });
});
