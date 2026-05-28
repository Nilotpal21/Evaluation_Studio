import { afterEach, describe, expect, it, vi } from 'vitest';

const lockMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  extend: vi.fn(),
  release: vi.fn(),
}));

vi.mock('@/lib/redis-client', () => ({
  getRedisClient: () => ({}),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    warn: vi.fn(),
  })),
}));

vi.mock('@agent-platform/shared-observability', () => ({
  DistributedLockManager: vi.fn().mockImplementation(function DistributedLockManager() {
    return {
      acquire: lockMocks.acquire,
      extend: lockMocks.extend,
      release: lockMocks.release,
    };
  }),
}));

describe('git operation lock', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('renews the Redis lock while the git operation is still running', async () => {
    vi.useFakeTimers();
    lockMocks.acquire.mockResolvedValue({
      key: 'studio:git-operation:tenant-1:project-1',
      value: 'owner-1',
      expiresAt: new Date(Date.now() + 300_000),
    });
    lockMocks.extend.mockResolvedValue(true);
    lockMocks.release.mockResolvedValue(true);

    const { acquireGitOperationLock } = await import('@/lib/git-operation-lock');
    const lock = await acquireGitOperationLock({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      operation: 'pull',
    });

    expect(lock.acquired).toBe(true);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(lockMocks.extend).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'studio:git-operation:tenant-1:project-1',
        value: 'owner-1',
      }),
      300_000,
    );

    if (lock.acquired) {
      await lock.release();
    }
    const renewCountAfterRelease = lockMocks.extend.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100_000);
    expect(lockMocks.extend).toHaveBeenCalledTimes(renewCountAfterRelease);
    expect(lockMocks.release).toHaveBeenCalledTimes(1);
  });
});
