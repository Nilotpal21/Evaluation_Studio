/**
 * ABLP-1123 — lazy expiry transition in the auth-profile resolver factory.
 *
 * Active-but-past-expiresAt profiles are flipped to `expired` at point-of-use
 * via a compare-and-swap update, replacing a background sweep with implicit
 * coverage every time the platform reads a profile.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthProfileError } from '@agent-platform/shared/services/auth-profile';
import {
  createAuthProfileResolver,
  type AuthProfileDocument,
  type AuthProfileModelLike,
} from '../services/auth-profile-resolver-factory.js';

const NOW = 1_700_000_000_000;
const GRACE_MS = 60_000;

function makeProfile(overrides: Partial<AuthProfileDocument> = {}): AuthProfileDocument {
  return {
    _id: 'ap-1',
    tenantId: 'tenant-1',
    projectId: null,
    status: 'active',
    name: 'Production OAuth',
    enabled: true,
    config: { headerName: 'X-Api-Key' },
    encryptedSecrets: '{"apiKey":"k"}',
    ...overrides,
  };
}

function makeModel(
  profile: AuthProfileDocument | null,
  withFindOneAndUpdate = true,
): AuthProfileModelLike & { findOneAndUpdate: ReturnType<typeof vi.fn> } {
  const findOneAndUpdate = vi.fn().mockResolvedValue(undefined);
  const model: AuthProfileModelLike & { findOneAndUpdate: ReturnType<typeof vi.fn> } = {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(profile) }),
    findOneAndUpdate,
  };
  if (!withFindOneAndUpdate) {
    delete (model as Partial<typeof model>).findOneAndUpdate;
  }
  return model;
}

describe('createAuthProfileResolver — lazy expiry transition', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flips active → expired and throws AUTH_PROFILE_EXPIRED when expiresAt is past the grace window', async () => {
    const expiresAt = new Date(NOW - GRACE_MS - 1_000);
    const model = makeModel(makeProfile({ expiresAt }));
    const resolver = createAuthProfileResolver({ authProfileModel: model });

    await expect(
      resolver.resolve({ authProfileId: 'ap-1', tenantId: 'tenant-1' }),
    ).rejects.toBeInstanceOf(AuthProfileError);

    try {
      await resolver.resolve({ authProfileId: 'ap-1', tenantId: 'tenant-1' });
      expect.fail('expected throw');
    } catch (err) {
      expect((err as AuthProfileError).code).toBe('AUTH_PROFILE_EXPIRED');
      expect((err as AuthProfileError).statusCode).toBe(403);
      // Message surfaces the expiry instant and the recovery hint.
      expect((err as AuthProfileError).message).toContain('expired at');
      expect((err as AuthProfileError).message).toContain('Re-authorize');
      expect((err as AuthProfileError).message).toContain('Production OAuth');
    }

    // Persists the flip via compare-and-swap (status: 'active' in the filter).
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'ap-1', tenantId: 'tenant-1', status: 'active' },
      { $set: { status: 'expired' }, $inc: { profileVersion: 1 } },
    );
  });

  it('resolves successfully when expiresAt is within the grace window (token mid-refresh)', async () => {
    // 30s in the past but still inside the 60s grace.
    const expiresAt = new Date(NOW - 30_000);
    const model = makeModel(makeProfile({ expiresAt }));
    const resolver = createAuthProfileResolver({ authProfileModel: model });

    const result = await resolver.resolve({ authProfileId: 'ap-1', tenantId: 'tenant-1' });
    expect(result).toEqual({ headerName: 'X-Api-Key', apiKey: 'k' });
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('resolves successfully when expiresAt is in the future', async () => {
    const expiresAt = new Date(NOW + 3_600_000);
    const model = makeModel(makeProfile({ expiresAt }));
    const resolver = createAuthProfileResolver({ authProfileModel: model });

    const result = await resolver.resolve({ authProfileId: 'ap-1', tenantId: 'tenant-1' });
    expect(result).toEqual({ headerName: 'X-Api-Key', apiKey: 'k' });
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('skips the expiry check entirely when expiresAt is absent (e.g. api_key, basic, aws_iam)', async () => {
    const model = makeModel(makeProfile({ expiresAt: null }));
    const resolver = createAuthProfileResolver({ authProfileModel: model });

    const result = await resolver.resolve({ authProfileId: 'ap-1', tenantId: 'tenant-1' });
    expect(result).toEqual({ headerName: 'X-Api-Key', apiKey: 'k' });
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('still rejects the request when findOneAndUpdate persistence fails (write is best-effort)', async () => {
    const expiresAt = new Date(NOW - GRACE_MS - 1_000);
    const model = makeModel(makeProfile({ expiresAt }));
    model.findOneAndUpdate.mockRejectedValueOnce(new Error('db down'));
    const resolver = createAuthProfileResolver({ authProfileModel: model });

    await expect(
      resolver.resolve({ authProfileId: 'ap-1', tenantId: 'tenant-1' }),
    ).rejects.toMatchObject({
      code: 'AUTH_PROFILE_EXPIRED',
    });
  });

  it('still rejects when the model does not expose findOneAndUpdate (older callers)', async () => {
    const expiresAt = new Date(NOW - GRACE_MS - 1_000);
    const model = makeModel(makeProfile({ expiresAt }), false);
    const resolver = createAuthProfileResolver({ authProfileModel: model });

    await expect(
      resolver.resolve({ authProfileId: 'ap-1', tenantId: 'tenant-1' }),
    ).rejects.toMatchObject({ code: 'AUTH_PROFILE_EXPIRED' });
  });

  it('accepts expiresAt as a string (Mongoose lean may surface it as ISO)', async () => {
    const expiresAt = new Date(NOW - GRACE_MS - 1_000).toISOString();
    const model = makeModel(makeProfile({ expiresAt }));
    const resolver = createAuthProfileResolver({ authProfileModel: model });

    await expect(
      resolver.resolve({ authProfileId: 'ap-1', tenantId: 'tenant-1' }),
    ).rejects.toMatchObject({ code: 'AUTH_PROFILE_EXPIRED' });
  });

  it('ignores an unparseable expiresAt string instead of false-positive expiring', async () => {
    const model = makeModel(makeProfile({ expiresAt: 'not-a-date' }));
    const resolver = createAuthProfileResolver({ authProfileModel: model });

    const result = await resolver.resolve({ authProfileId: 'ap-1', tenantId: 'tenant-1' });
    expect(result).toEqual({ headerName: 'X-Api-Key', apiKey: 'k' });
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
