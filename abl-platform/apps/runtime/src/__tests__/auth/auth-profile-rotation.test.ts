import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthProfileRotationJob } from '../../services/auth-profile/auth-profile-rotation-job.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Mock the AuthProfile model returned by dynamic import
const mockProfiles: any[] = [];
const mockSort = vi.fn().mockReturnValue({
  limit: vi.fn().mockImplementation(() => Promise.resolve(mockProfiles)),
});
const mockAuthProfile = {
  find: vi.fn().mockImplementation(() => ({
    sort: mockSort,
  })),
};

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'find') return mockAuthProfile.find;
        return undefined;
      },
    },
  ),
}));

describe('AuthProfileRotationJob', () => {
  const mockRedis = {
    set: vi.fn().mockResolvedValue('OK'),
    eval: vi.fn().mockResolvedValue(1),
  };

  function makeProfile(overrides: Record<string, unknown> = {}) {
    const profile = {
      _id: 'p1',
      tenantId: 't1',
      encryptedSecrets: '{"apiKey":"decrypted-secret"}',
      previousEncryptedSecrets: undefined as string | undefined,
      encryptionKeyVersion: 1,
      rotationGracePeriodMs: undefined as number | undefined,
      markModified: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    return profile;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.eval.mockResolvedValue(1);
    mockProfiles.length = 0;
    mockSort.mockClear();
  });

  it('processes profiles with outdated encryptionKeyVersion via Mongoose save', async () => {
    const p1 = makeProfile({ _id: 'p1' });
    const p2 = makeProfile({ _id: 'p2' });
    mockProfiles.push(p1, p2);
    // After first batch returns 2 items (< batchSize 5), loop ends
    const job = new AuthProfileRotationJob({
      redis: mockRedis as never,
      currentKeyVersion: 2,
      batchSize: 5,
    });

    const result = await job.run();

    expect(result.processed).toBe(2);
    expect(p1.markModified).toHaveBeenCalledWith('encryptedSecrets');
    expect(p1.save).toHaveBeenCalled();
    expect(p2.markModified).toHaveBeenCalledWith('encryptedSecrets');
    expect(p2.save).toHaveBeenCalled();
  });

  it('stores previousEncryptedSecrets and rotationGracePeriodMs for grace period', async () => {
    const p1 = makeProfile({
      encryptedSecrets: '{"apiKey":"my-secret"}',
    });
    mockProfiles.push(p1);

    const job = new AuthProfileRotationJob({
      redis: mockRedis as never,
      currentKeyVersion: 2,
      gracePeriodMs: 60_000,
    });

    await job.run();

    expect(p1.previousEncryptedSecrets).toBe('{"apiKey":"my-secret"}');
    expect(p1.rotationGracePeriodMs).toBe(60_000);
    expect(p1.encryptionKeyVersion).toBe(2);
  });

  it('acquires distributed lock with auth-profile:op-lock namespace', async () => {
    mockProfiles.push(makeProfile({ _id: 'p1', tenantId: 't1' }));

    const job = new AuthProfileRotationJob({
      redis: mockRedis as never,
      currentKeyVersion: 2,
    });

    await job.run();

    expect(mockRedis.set).toHaveBeenCalledWith(
      'auth-profile:op-lock:t1:p1',
      expect.any(String),
      'PX',
      30_000,
      'NX',
    );
  });

  it('skips profiles where lock is already held', async () => {
    const p1 = makeProfile();
    mockProfiles.push(p1);
    mockRedis.set.mockResolvedValue(null); // Lock held

    const job = new AuthProfileRotationJob({
      redis: mockRedis as never,
      currentKeyVersion: 2,
    });

    const result = await job.run();

    expect(result.skipped).toBe(1);
    expect(p1.save).not.toHaveBeenCalled();
  });

  it('releases lock after processing', async () => {
    mockProfiles.push(makeProfile({ _id: 'p1', tenantId: 't1' }));

    const job = new AuthProfileRotationJob({
      redis: mockRedis as never,
      currentKeyVersion: 2,
    });

    await job.run();

    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("GET", KEYS[1])'),
      1,
      'auth-profile:op-lock:t1:p1',
      expect.any(String),
    );
  });

  it('releases lock even on save failure', async () => {
    const p1 = makeProfile({
      _id: 'p1',
      tenantId: 't1',
      save: vi.fn().mockRejectedValue(new Error('save failed')),
    });
    mockProfiles.push(p1);

    const job = new AuthProfileRotationJob({
      redis: mockRedis as never,
      currentKeyVersion: 2,
    });

    const result = await job.run();

    expect(result.failed).toBe(1);
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("GET", KEYS[1])'),
      1,
      'auth-profile:op-lock:t1:p1',
      expect.any(String),
    );
  });

  it('stops when no profiles to process', async () => {
    // mockProfiles is empty
    const job = new AuthProfileRotationJob({
      redis: mockRedis as never,
      currentKeyVersion: 2,
    });

    const result = await job.run();

    expect(result.processed).toBe(0);
    expect(mockAuthProfile.find).toHaveBeenCalledTimes(1);
  });

  it('skips profiles with missing tenantId', async () => {
    mockProfiles.push(makeProfile({ _id: 'p1', tenantId: undefined }));

    const job = new AuthProfileRotationJob({
      redis: mockRedis as never,
      currentKeyVersion: 2,
    });

    const result = await job.run();

    expect(result.skipped).toBe(1);
  });

  it('queries for profiles with encryptionKeyVersion < currentKeyVersion', async () => {
    const job = new AuthProfileRotationJob({
      redis: mockRedis as never,
      currentKeyVersion: 3,
      batchSize: 50,
    });

    await job.run();

    expect(mockAuthProfile.find).toHaveBeenCalledWith(
      expect.objectContaining({
        encryptionKeyVersion: { $lt: 3 },
      }),
    );
    expect(mockSort).toHaveBeenCalledWith({ _id: 1 });
  });
});
