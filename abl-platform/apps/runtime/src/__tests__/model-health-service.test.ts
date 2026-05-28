/**
 * Unit tests for Model Health Service
 *
 * Tests health status persistence, job lifecycle, distributed locking,
 * and health status classification.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { DistributedLockManager } from '@agent-platform/shared';

const { mockUpdateOne, mockWarn, mockError, mockInfo, mockDebug } = vi.hoisted(() => ({
  mockUpdateOne: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockInfo: vi.fn(),
  mockDebug: vi.fn(),
}));

const mockResolveTenantPlaintextValue = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  TenantModel: {
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}));

vi.mock('@agent-platform/database', () => ({
  resolveTenantPlaintextValue: (...args: unknown[]) => mockResolveTenantPlaintextValue(...args),
}));

vi.mock('@agent-platform/shared-observability', () => ({
  createLogger: () => ({
    warn: mockWarn,
    error: mockError,
    info: mockInfo,
    debug: mockDebug,
  }),
}));

vi.mock('@agent-platform/shared', () => ({
  DistributedLockManager: class DistributedLockManager {
    constructor(private redis: HealthCheckRedisClient) {}

    async acquire(
      scope: string,
      opts: { keyPrefix: string; ttlMs: number; retryAttempts: number },
    ): Promise<{ key: string; value: string } | null> {
      const key = `${opts.keyPrefix}:${scope}`;
      const value = `lock:${scope}`;
      const result = await this.redis.set(key, value, 'PX', opts.ttlMs, 'NX');
      return result === 'OK' ? { key, value } : null;
    }

    async release(lock: { key: string; value: string }): Promise<void> {
      await this.redis.eval('', 1, lock.key, lock.value);
    }
  },
}));

import {
  startModelHealthJob,
  stopModelHealthJob,
  executeWithDistributedLock,
  resolveConnectionHealthInputFromCredential,
  updateConnectionHealthStatus,
  type HealthCheckRedisClient,
} from '../services/llm/model-health-service.js';

function createFakeLockRedis(): HealthCheckRedisClient & {
  locks: Map<string, string>;
} {
  const locks = new Map<string, string>();

  return {
    locks,
    async set(
      key: string,
      value: string,
      _px: 'PX',
      _ttl: number,
      _nx: 'NX',
    ): Promise<string | null> {
      if (locks.has(key)) {
        return null;
      }
      locks.set(key, value);
      return 'OK';
    },
    async get(key: string): Promise<string | null> {
      return locks.get(key) ?? null;
    },
    async eval(_script: string, _numkeys: number, ...args: (string | number)[]): Promise<unknown> {
      const key = args[0] as string;
      const value = args[1] as string;
      if (locks.get(key) === value) {
        locks.delete(key);
        return 1;
      }
      return 0;
    },
    async pttl(key: string): Promise<number> {
      return locks.has(key) ? 3_600_000 : -2;
    },
  };
}

describe('Model Health Service', () => {
  afterEach(() => {
    stopModelHealthJob();
    vi.restoreAllMocks();
    mockUpdateOne.mockReset();
    mockWarn.mockReset();
    mockError.mockReset();
    mockInfo.mockReset();
    mockDebug.mockReset();
    mockResolveTenantPlaintextValue.mockReset();
  });

  describe('updateConnectionHealthStatus', () => {
    it('persists health status via connections.id when the normalized id matches', async () => {
      mockUpdateOne.mockResolvedValueOnce({ matchedCount: 1 });

      await updateConnectionHealthStatus('model-1', 'conn-1', 'tenant-1', {
        valid: true,
        message: 'ok',
        status: 'healthy',
      });

      expect(mockUpdateOne).toHaveBeenCalledTimes(1);
      expect(mockUpdateOne).toHaveBeenCalledWith(
        { _id: 'model-1', tenantId: 'tenant-1', 'connections.id': 'conn-1' },
        expect.objectContaining({
          $set: expect.objectContaining({
            'connections.$.healthStatus': 'healthy',
            'connections.$.healthMessage': 'ok',
          }),
        }),
      );
    });

    it('falls back to legacy connections._id when normalized id does not match', async () => {
      mockUpdateOne.mockResolvedValueOnce({ matchedCount: 0 });
      mockUpdateOne.mockResolvedValueOnce({ matchedCount: 1 });

      await updateConnectionHealthStatus('model-1', 'legacy-conn-id', 'tenant-1', {
        valid: false,
        message: 'missing api key',
        status: 'unhealthy',
      });

      expect(mockUpdateOne).toHaveBeenCalledTimes(2);
      expect(mockUpdateOne).toHaveBeenNthCalledWith(
        2,
        { _id: 'model-1', tenantId: 'tenant-1', 'connections._id': 'legacy-conn-id' },
        expect.objectContaining({
          $set: expect.objectContaining({
            'connections.$.healthStatus': 'unhealthy',
            'connections.$.healthMessage': 'missing api key',
          }),
        }),
      );
    });

    it('warns when neither normalized nor legacy connection ids match', async () => {
      mockUpdateOne.mockResolvedValueOnce({ matchedCount: 0 });
      mockUpdateOne.mockResolvedValueOnce({ matchedCount: 0 });

      await updateConnectionHealthStatus('model-1', 'missing-conn', 'tenant-1', {
        valid: null,
        message: 'provider timeout',
        status: 'unknown',
      });

      expect(mockWarn).toHaveBeenCalledWith(
        'No matching connection found while persisting health status',
        expect.objectContaining({
          modelId: 'model-1',
          connectionId: 'missing-conn',
          tenantId: 'tenant-1',
          status: 'unknown',
        }),
      );
    });
  });

  describe('startModelHealthJob / stopModelHealthJob — without distributed lock', () => {
    it('starts a periodic job with the specified interval', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      startModelHealthJob(3_600_000);

      expect(setIntervalSpy).toHaveBeenCalledOnce();
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 3_600_000);
    });

    it('does not start a second job if already running', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      startModelHealthJob(3_600_000);
      startModelHealthJob(3_600_000);

      expect(setIntervalSpy).toHaveBeenCalledOnce();
    });

    it('stops the job and allows restart', () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      startModelHealthJob(3_600_000);
      stopModelHealthJob();

      expect(clearIntervalSpy).toHaveBeenCalledOnce();

      startModelHealthJob(7_200_000);
      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    });

    it('stopModelHealthJob is safe to call when no job is running', () => {
      expect(() => stopModelHealthJob()).not.toThrow();
    });
  });

  describe('startModelHealthJob — with distributed lock', () => {
    it('accepts a Redis client for distributed locking', () => {
      const redis = createFakeLockRedis();
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      startModelHealthJob(3_600_000, redis);

      expect(setIntervalSpy).toHaveBeenCalledOnce();
    });

    it('stops cleanly when using distributed lock', () => {
      const redis = createFakeLockRedis();
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      startModelHealthJob(3_600_000, redis);
      stopModelHealthJob();

      expect(clearIntervalSpy).toHaveBeenCalledOnce();
    });
  });

  describe('executeWithDistributedLock — lock orchestration', () => {
    it('executes cycleFn directly when no lock manager', async () => {
      let executed = false;
      const result = await executeWithDistributedLock(null, 3_600_000, async () => {
        executed = true;
      });

      expect(executed).toBe(true);
      expect(result).toBe('executed');
    });

    it('acquires lock, executes cycleFn, releases lock', async () => {
      const redis = createFakeLockRedis();
      const lm = new DistributedLockManager(
        redis as unknown as ConstructorParameters<typeof DistributedLockManager>[0],
      );

      let executed = false;
      const result = await executeWithDistributedLock(lm, 3_600_000, async () => {
        expect(redis.locks.size).toBe(1);
        executed = true;
      });

      expect(executed).toBe(true);
      expect(result).toBe('executed');
      expect(redis.locks.size).toBe(0);
    });

    it('skips cycleFn when another pod holds the lock', async () => {
      const redis = createFakeLockRedis();
      const lm = new DistributedLockManager(
        redis as unknown as ConstructorParameters<typeof DistributedLockManager>[0],
      );

      redis.locks.set('model-health-check:global', 'other-pod:123:abc');

      let executed = false;
      const result = await executeWithDistributedLock(lm, 3_600_000, async () => {
        executed = true;
      });

      expect(executed).toBe(false);
      expect(result).toBe('skipped');
      expect(redis.locks.get('model-health-check:global')).toBe('other-pod:123:abc');
    });

    it('falls back to executing when Redis throws (fail-open)', async () => {
      const failingRedis: HealthCheckRedisClient = {
        async set(): Promise<string | null> {
          throw new Error('Connection refused');
        },
        async get(): Promise<string | null> {
          throw new Error('Connection refused');
        },
        async eval(): Promise<unknown> {
          throw new Error('Connection refused');
        },
        async pttl(): Promise<number> {
          throw new Error('Connection refused');
        },
      };

      const lm = new DistributedLockManager(
        failingRedis as unknown as ConstructorParameters<typeof DistributedLockManager>[0],
      );

      let executed = false;
      const result = await executeWithDistributedLock(lm, 3_600_000, async () => {
        executed = true;
      });

      expect(executed).toBe(true);
      expect(result).toBe('fallback');
    });

    it('releases lock even when cycleFn throws', async () => {
      const redis = createFakeLockRedis();
      const lm = new DistributedLockManager(
        redis as unknown as ConstructorParameters<typeof DistributedLockManager>[0],
      );

      await expect(
        executeWithDistributedLock(lm, 3_600_000, async () => {
          throw new Error('Cycle failed');
        }),
      ).rejects.toThrow('Cycle failed');

      expect(redis.locks.size).toBe(0);
    });
  });

  describe('checkConnectionHealth — error classification', () => {
    it('classifies provider failures without throwing', async () => {
      const { checkConnectionHealth } = await import('../services/llm/model-health-service.js');

      const result = await checkConnectionHealth({
        provider: 'openai',
        apiKey: 'test-invalid-key',
        modelId: 'gpt-4o-mini',
      });

      expect(result).toBeDefined();
      expect(result.status).toBeDefined();
      expect(['healthy', 'unhealthy', 'unknown']).toContain(result.status);
      expect(typeof result.message).toBe('string');
    });

    it('returns a valid HealthCheckResult shape', async () => {
      const { checkConnectionHealth } = await import('../services/llm/model-health-service.js');

      const result = await checkConnectionHealth({
        provider: 'nonexistent-provider',
        apiKey: 'fake-key',
        modelId: 'fake-model',
      });

      expect(result).toHaveProperty('valid');
      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('status');
      expect([true, false, null]).toContain(result.valid);
    });
  });

  describe('resolveConnectionHealthInputFromCredential', () => {
    it('returns null when the credential has no API key', async () => {
      await expect(
        resolveConnectionHealthInputFromCredential(
          { encryptedApiKey: null },
          'tenant-1',
          'anthropic',
          'claude-sonnet-4-6',
        ),
      ).resolves.toBeNull();

      expect(mockResolveTenantPlaintextValue).not.toHaveBeenCalled();
    });

    it('resolves decrypted API keys and endpoints for health checks', async () => {
      mockResolveTenantPlaintextValue
        .mockResolvedValueOnce('sk-decrypted')
        .mockResolvedValueOnce('https://proxy.example.com/v1');

      await expect(
        resolveConnectionHealthInputFromCredential(
          {
            encryptedApiKey: 'N0:AAAA:BBBB:CCCC',
            encryptedEndpoint: 'https://proxy.example.com/v1',
            authConfig: JSON.stringify({ audience: 'tenant-runtime' }),
            _decryptionFailed: true,
          },
          'tenant-1',
          'anthropic',
          'claude-sonnet-4-6',
        ),
      ).resolves.toEqual({
        provider: 'anthropic',
        apiKey: 'sk-decrypted',
        endpoint: 'https://proxy.example.com/v1',
        modelId: 'claude-sonnet-4-6',
        authConfig: { audience: 'tenant-runtime' },
      });

      expect(mockResolveTenantPlaintextValue).toHaveBeenNthCalledWith(
        1,
        'N0:AAAA:BBBB:CCCC',
        'tenant-1',
        { decryptionFailed: true },
      );
      expect(mockResolveTenantPlaintextValue).toHaveBeenNthCalledWith(
        2,
        'https://proxy.example.com/v1',
        'tenant-1',
      );
    });

    it('propagates decryption failures for callers to fail closed', async () => {
      mockResolveTenantPlaintextValue.mockRejectedValueOnce(new Error('bad ciphertext'));

      await expect(
        resolveConnectionHealthInputFromCredential(
          {
            encryptedApiKey: 'N0:AAAA:BBBB:CCCC',
            _decryptionFailed: true,
          },
          'tenant-1',
          'anthropic',
          'claude-sonnet-4-6',
        ),
      ).rejects.toThrow('bad ciphertext');
    });
  });
});
