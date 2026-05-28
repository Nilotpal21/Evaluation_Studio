/**
 * Redis Verification Token Store Tests
 *
 * Tests the Redis-backed implementation of VerificationTokenStore.
 * Uses an in-memory Map-based mock for Redis to validate key format,
 * TTL handling, tenant isolation, Date serialization, and CRUD operations.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisVerificationTokenStore } from '../../../../contexts/identity/infrastructure/redis-verification-token-store.js';
import type { StoredVerificationAttempt } from '../../../../contexts/identity/infrastructure/verification-token-store.js';

// =============================================================================
// MOCK REDIS CLIENT
// =============================================================================

interface MockRedisClient {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
}

function createMockRedis(): MockRedisClient {
  const store = new Map<string, string>();
  const ttlMap = new Map<string, number>();

  const client: MockRedisClient = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _mode?: string, ttl?: number) => {
      store.set(key, value);
      if (ttl != null) ttlMap.set(key, ttl);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      ttlMap.delete(key);
      return existed ? 1 : 0;
    }),
    eval: vi.fn(async (script: string, _numkeys: number, ...args: (string | number)[]) => {
      const key = args[0] as string;
      const raw = store.get(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      const ttl = ttlMap.get(key) ?? 1;

      if (script.includes("obj['attempts']")) {
        obj.attempts = (obj.attempts ?? 0) + 1;
        store.set(key, JSON.stringify(obj));
        client.set(key, JSON.stringify(obj), 'EX', ttl);
        return obj.attempts;
      }
      if (script.includes("obj['status'] = 'verified'")) {
        obj.status = 'verified';
        store.set(key, JSON.stringify(obj));
        client.set(key, JSON.stringify(obj), 'EX', ttl);
        return 1;
      }
      return null;
    }),
  };
  return client;
}

// =============================================================================
// HELPERS
// =============================================================================

/** One hour in milliseconds. */
const ONE_HOUR_MS = 3_600_000;

/** Two hours in milliseconds. */
const TWO_HOURS_MS = 7_200_000;

function makeAttempt(
  overrides: Partial<StoredVerificationAttempt> = {},
): StoredVerificationAttempt {
  return {
    id: 'attempt-001',
    tenantId: 'tenant-001',
    sessionId: 'sess-001',
    method: 'otp',
    identityValue: '+1234567890',
    identityType: 'phone',
    status: 'pending',
    attempts: 0,
    maxAttempts: 5,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    expiresAt: new Date(Date.now() + ONE_HOUR_MS),
    codeHash: 'hashed-code-abc123',
    ...overrides,
  } as StoredVerificationAttempt;
}

// =============================================================================
// TESTS
// =============================================================================

describe('RedisVerificationTokenStore', () => {
  let mockRedis: MockRedisClient;
  let store: RedisVerificationTokenStore;

  beforeEach(() => {
    mockRedis = createMockRedis();
    store = new RedisVerificationTokenStore(() => mockRedis);
  });

  // ---------------------------------------------------------------------------
  // create() + get() roundtrip
  // ---------------------------------------------------------------------------

  describe('create + get roundtrip', () => {
    it('stores and retrieves a verification attempt with all fields intact', async () => {
      const attempt = makeAttempt();

      await store.create(attempt);
      const result = await store.get('tenant-001', 'attempt-001');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('attempt-001');
      expect(result!.tenantId).toBe('tenant-001');
      expect(result!.sessionId).toBe('sess-001');
      expect(result!.method).toBe('otp');
      expect(result!.identityValue).toBe('+1234567890');
      expect(result!.identityType).toBe('phone');
      expect(result!.status).toBe('pending');
      expect(result!.attempts).toBe(0);
      expect(result!.maxAttempts).toBe(5);
      expect(result!.codeHash).toBe('hashed-code-abc123');
    });

    it('deserializes Date fields correctly from ISO strings', async () => {
      const createdAt = new Date('2025-06-15T10:30:00.000Z');
      const expiresAt = new Date(Date.now() + ONE_HOUR_MS);
      const attempt = makeAttempt({ createdAt, expiresAt });

      await store.create(attempt);
      const result = await store.get('tenant-001', 'attempt-001');

      expect(result).not.toBeNull();
      expect(result!.createdAt).toBeInstanceOf(Date);
      expect(result!.expiresAt).toBeInstanceOf(Date);
      expect(result!.createdAt.toISOString()).toBe(createdAt.toISOString());
      expect(result!.expiresAt.toISOString()).toBe(expiresAt.toISOString());
    });

    it('stores under the correct tenant-scoped key format', async () => {
      const attempt = makeAttempt();

      await store.create(attempt);

      expect(mockRedis.set).toHaveBeenCalledWith(
        'verify:tenant-001:attempt-001',
        expect.any(String),
        'EX',
        expect.any(Number),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // get() returns null
  // ---------------------------------------------------------------------------

  describe('get()', () => {
    it('returns null for nonexistent attempt', async () => {
      const result = await store.get('tenant-001', 'nonexistent');

      expect(result).toBeNull();
    });

    it('queries Redis with the correct tenant-scoped key', async () => {
      await store.get('tenant-X', 'attempt-Y');

      expect(mockRedis.get).toHaveBeenCalledWith('verify:tenant-X:attempt-Y');
    });
  });

  // ---------------------------------------------------------------------------
  // TTL computation
  // ---------------------------------------------------------------------------

  describe('TTL computation', () => {
    it('sets TTL from attempt.expiresAt', async () => {
      const futureDate = new Date(Date.now() + TWO_HOURS_MS);
      const attempt = makeAttempt({ expiresAt: futureDate });

      await store.create(attempt);

      const ttlArg = mockRedis.set.mock.calls[0][3] as number;
      // TTL should be approximately 7200 seconds (2 hours), with tolerance for test execution time
      expect(ttlArg).toBeGreaterThan(7100);
      expect(ttlArg).toBeLessThanOrEqual(7200);
    });

    it('uses a minimum TTL of 1 second for nearly-expired attempts', async () => {
      const pastDate = new Date(Date.now() - 1000);
      const attempt = makeAttempt({ expiresAt: pastDate });

      await store.create(attempt);

      const ttlArg = mockRedis.set.mock.calls[0][3] as number;
      expect(ttlArg).toBeGreaterThanOrEqual(1);
    });

    it('passes EX mode for TTL-based expiry', async () => {
      const attempt = makeAttempt();

      await store.create(attempt);

      const modeArg = mockRedis.set.mock.calls[0][2] as string;
      expect(modeArg).toBe('EX');
    });
  });

  // ---------------------------------------------------------------------------
  // incrementAttempts()
  // ---------------------------------------------------------------------------

  describe('incrementAttempts()', () => {
    it('increments the attempts counter by 1', async () => {
      const attempt = makeAttempt({ attempts: 2 });
      await store.create(attempt);

      await store.incrementAttempts('tenant-001', 'attempt-001');

      const result = await store.get('tenant-001', 'attempt-001');
      expect(result).not.toBeNull();
      expect(result!.attempts).toBe(3);
    });

    it('preserves all other fields after increment', async () => {
      const attempt = makeAttempt();
      await store.create(attempt);

      await store.incrementAttempts('tenant-001', 'attempt-001');

      const result = await store.get('tenant-001', 'attempt-001');
      expect(result).not.toBeNull();
      expect(result!.status).toBe('pending');
      expect(result!.codeHash).toBe('hashed-code-abc123');
      expect(result!.method).toBe('otp');
    });

    it('does not throw when attempt does not exist', async () => {
      await expect(store.incrementAttempts('tenant-001', 'nonexistent')).resolves.not.toThrow();
    });

    it('uses atomic Lua eval for increment', async () => {
      const attempt = makeAttempt();
      await store.create(attempt);

      await store.incrementAttempts('tenant-001', 'attempt-001');

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining("obj['attempts']"),
        1,
        'verify:tenant-001:attempt-001',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // markVerified()
  // ---------------------------------------------------------------------------

  describe('markVerified()', () => {
    it('updates the status to verified', async () => {
      const attempt = makeAttempt({ status: 'pending' });
      await store.create(attempt);

      await store.markVerified('tenant-001', 'attempt-001');

      const result = await store.get('tenant-001', 'attempt-001');
      expect(result).not.toBeNull();
      expect(result!.status).toBe('verified');
    });

    it('preserves all other fields after marking verified', async () => {
      const attempt = makeAttempt({ attempts: 3 });
      await store.create(attempt);

      await store.markVerified('tenant-001', 'attempt-001');

      const result = await store.get('tenant-001', 'attempt-001');
      expect(result).not.toBeNull();
      expect(result!.attempts).toBe(3);
      expect(result!.codeHash).toBe('hashed-code-abc123');
      expect(result!.sessionId).toBe('sess-001');
    });

    it('does not throw when attempt does not exist', async () => {
      await expect(store.markVerified('tenant-001', 'nonexistent')).resolves.not.toThrow();
    });

    it('uses atomic Lua eval for markVerified', async () => {
      const attempt = makeAttempt();
      await store.create(attempt);

      await store.markVerified('tenant-001', 'attempt-001');

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining("obj['status'] = 'verified'"),
        1,
        'verify:tenant-001:attempt-001',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation
  // ---------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('different tenants with same attemptId do not share data', async () => {
      const attemptA = makeAttempt({
        tenantId: 'tenant-A',
        sessionId: 'sess-A',
        codeHash: 'hash-A',
      });
      const attemptB = makeAttempt({
        tenantId: 'tenant-B',
        sessionId: 'sess-B',
        codeHash: 'hash-B',
      });

      await store.create(attemptA);
      await store.create(attemptB);

      const resultA = await store.get('tenant-A', 'attempt-001');
      const resultB = await store.get('tenant-B', 'attempt-001');

      expect(resultA).not.toBeNull();
      expect(resultB).not.toBeNull();
      expect(resultA!.sessionId).toBe('sess-A');
      expect(resultA!.codeHash).toBe('hash-A');
      expect(resultB!.sessionId).toBe('sess-B');
      expect(resultB!.codeHash).toBe('hash-B');
    });

    it('attempt from tenant A is not visible to tenant B', async () => {
      const attempt = makeAttempt({ tenantId: 'tenant-A' });
      await store.create(attempt);

      const result = await store.get('tenant-B', 'attempt-001');

      expect(result).toBeNull();
    });

    it('incrementAttempts is tenant-scoped', async () => {
      const attemptA = makeAttempt({ tenantId: 'tenant-A', attempts: 1 });
      const attemptB = makeAttempt({ tenantId: 'tenant-B', attempts: 1 });
      await store.create(attemptA);
      await store.create(attemptB);

      await store.incrementAttempts('tenant-A', 'attempt-001');

      const resultA = await store.get('tenant-A', 'attempt-001');
      const resultB = await store.get('tenant-B', 'attempt-001');
      expect(resultA!.attempts).toBe(2);
      expect(resultB!.attempts).toBe(1);
    });

    it('markVerified is tenant-scoped', async () => {
      const attemptA = makeAttempt({ tenantId: 'tenant-A' });
      const attemptB = makeAttempt({ tenantId: 'tenant-B' });
      await store.create(attemptA);
      await store.create(attemptB);

      await store.markVerified('tenant-A', 'attempt-001');

      const resultA = await store.get('tenant-A', 'attempt-001');
      const resultB = await store.get('tenant-B', 'attempt-001');
      expect(resultA!.status).toBe('verified');
      expect(resultB!.status).toBe('pending');
    });

    it('key format includes tenantId as a namespace', async () => {
      await store.get('tenant-001', 'attempt-001');

      const redisKey = mockRedis.get.mock.calls[0][0] as string;
      expect(redisKey).toContain('tenant-001');
      expect(redisKey).toBe('verify:tenant-001:attempt-001');
    });
  });
});
