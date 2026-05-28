import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — hoisted above imports
// ---------------------------------------------------------------------------

const mockIsDatabaseAvailable = vi.fn();
vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: (...args: any[]) => mockIsDatabaseAvailable(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockLimit = vi.fn();
const mockSort = vi.fn();
const mockFind = vi.fn();
const mockFindOneAndUpdate = vi.fn();
vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    find: (...args: any[]) => mockFind(...args),
    findOneAndUpdate: (...args: any[]) => mockFindOneAndUpdate(...args),
  },
}));

const mockGetRedisClient = vi.fn();
vi.mock('../../services/redis/redis-client.js', () => ({
  getRedisClient: () => mockGetRedisClient(),
  getRedisHandle: () => ({
    client: mockGetRedisClient(),
    isReady: () => true,
    duplicate: () =>
      mockGetRedisClient().duplicate ? mockGetRedisClient().duplicate() : mockGetRedisClient(),
    disconnect: async () => {},
  }),
}));

// Mock the rotation job class so runOnce() doesn't trigger transitive dynamic
// imports (DistributedLockManager, auth-profile-resolver) that stall under
// fake timers.  The job's run() directly calls the AuthProfile.find mock.
const mockJobRun = vi.fn();
vi.mock('../../services/auth-profile/auth-profile-rotation-job.js', () => ({
  AuthProfileRotationJob: class {
    constructor(_config: any) {}
    async run() {
      // Call through to AuthProfile.find mock so existing assertions still work
      const { AuthProfile } = await import('@agent-platform/database/models');
      const batch = await (AuthProfile as any).find({}).sort({ _id: 1 }).limit(100);
      mockJobRun();
      return { processed: 0, skipped: 0, failed: batch.length };
    }
  },
}));

vi.mock('../../services/auth-profile/auth-profile-key-version.js', () => ({
  getCurrentAuthProfileKeyVersion: () => 1,
}));

// ---------------------------------------------------------------------------
// SUT
// ---------------------------------------------------------------------------

import {
  startAuthProfileRotationJob,
  stopAuthProfileRotationJob,
} from '../../services/auth-profile/auth-profile-rotation-scheduler.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Auth Profile Rotation Scheduler', () => {
  const mockRedis = {
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  };

  const mockEncryptionService = {
    decrypt: vi.fn().mockResolvedValue('{"key":"val"}'),
    encrypt: vi.fn().mockResolvedValue('encrypted'),
    getCurrentKeyVersion: vi.fn().mockReturnValue(2),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockIsDatabaseAvailable.mockReturnValue(true);
    mockGetRedisClient.mockReturnValue(mockRedis);
    mockLimit.mockResolvedValue([]);
    mockSort.mockReturnValue({
      limit: mockLimit,
    });
    // AuthProfile.find returns empty batch by default (rotation has nothing to do)
    mockFind.mockReturnValue({
      sort: mockSort,
    });
  });

  afterEach(async () => {
    stopAuthProfileRotationJob();
    // Flush any pending microtasks
    for (let i = 0; i < 500; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('startAuthProfileRotationJob() returns without error', async () => {
    expect(() => startAuthProfileRotationJob(mockEncryptionService)).not.toThrow();
    // Flush the fire-and-forget runOnce so afterEach has a clean state
    for (let i = 0; i < 500; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it('stopAuthProfileRotationJob() stops the interval', async () => {
    startAuthProfileRotationJob(mockEncryptionService);
    // Flush initial run — runOnce() contains nested dynamic imports that
    // require many microtask ticks to resolve under fake timers.
    for (let i = 0; i < 500; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }

    const callsAfterStart = mockFind.mock.calls.length;
    expect(callsAfterStart).toBeGreaterThan(0); // initial run completed
    stopAuthProfileRotationJob();

    // Advance well past the interval — should not trigger new calls
    await vi.advanceTimersByTimeAsync(600_000);
    for (let i = 0; i < 500; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(mockFind.mock.calls.length).toBe(callsAfterStart);
  });

  it('skips when database is unavailable', () => {
    mockIsDatabaseAvailable.mockReturnValue(false);
    startAuthProfileRotationJob(mockEncryptionService);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('no-ops if already running', () => {
    startAuthProfileRotationJob(mockEncryptionService);
    // Second call should not throw or start a second interval
    expect(() => startAuthProfileRotationJob(mockEncryptionService)).not.toThrow();
  });

  it('skips when Redis is unavailable', async () => {
    mockGetRedisClient.mockReturnValue(null);
    startAuthProfileRotationJob(mockEncryptionService);
    // Flush microtasks
    for (let i = 0; i < 500; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    // find should not be called because we bail out before creating the job
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('runs rotation job on startup (immediate first run)', async () => {
    startAuthProfileRotationJob(mockEncryptionService);
    // Flush initial run — the rotation job calls AuthProfile.find
    for (let i = 0; i < 500; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    // The rotation job should have called find at least once
    expect(mockFind).toHaveBeenCalled();
  });

  it('runs rotation on interval', async () => {
    startAuthProfileRotationJob(mockEncryptionService);
    // Flush initial run
    for (let i = 0; i < 500; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    const callsAfterInit = mockFind.mock.calls.length;

    // Advance past the default interval (300s)
    await vi.advanceTimersByTimeAsync(300_000);
    for (let i = 0; i < 500; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(mockFind.mock.calls.length).toBeGreaterThan(callsAfterInit);
  });

  it('uses AUTH_ROTATION_INTERVAL_MS from env', async () => {
    const originalEnv = process.env.AUTH_ROTATION_INTERVAL_MS;
    process.env.AUTH_ROTATION_INTERVAL_MS = '60000';

    startAuthProfileRotationJob(mockEncryptionService);
    // Flush initial run
    for (let i = 0; i < 500; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    const callsAfterInit = mockFind.mock.calls.length;

    // Advance 60s — should trigger a new run
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 500; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(mockFind.mock.calls.length).toBeGreaterThan(callsAfterInit);

    process.env.AUTH_ROTATION_INTERVAL_MS = originalEnv;
  });

  it('defaults to passthrough encryption when no service provided', async () => {
    // Calling without encryption service should use passthrough (no-op)
    startAuthProfileRotationJob();
    // Flush initial run
    for (let i = 0; i < 500; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    // Should still call find (passthrough encryption is used)
    expect(mockFind).toHaveBeenCalled();
  });

  it('falls back to default interval on NaN env var', async () => {
    const originalEnv = process.env.AUTH_ROTATION_INTERVAL_MS;
    process.env.AUTH_ROTATION_INTERVAL_MS = 'not-a-number';

    startAuthProfileRotationJob(mockEncryptionService);
    // Flush initial run
    for (let i = 0; i < 500; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    const callsAfterInit = mockFind.mock.calls.length;

    // Advance 60s — should NOT trigger (default is 300s)
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 500; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(mockFind.mock.calls.length).toBe(callsAfterInit);

    // Advance to 300s — should trigger
    await vi.advanceTimersByTimeAsync(240_000);
    for (let i = 0; i < 500; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(mockFind.mock.calls.length).toBeGreaterThan(callsAfterInit);

    process.env.AUTH_ROTATION_INTERVAL_MS = originalEnv;
  });
});
