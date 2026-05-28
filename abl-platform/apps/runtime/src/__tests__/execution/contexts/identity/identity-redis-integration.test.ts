/**
 * Identity Redis Integration Tests
 *
 * INT-1: RedisVerificationTokenStore — real Redis integration tests
 * INT-2: RedisResolutionKeyStore — real Redis integration tests
 *
 * These tests require a running Redis instance at 127.0.0.1:6379.
 * If Redis is unavailable, all tests are skipped gracefully.
 *
 * Uses unique key prefixes per test run to avoid collisions.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Redis from 'ioredis';
import { RedisVerificationTokenStore } from '../../../../contexts/identity/infrastructure/redis-verification-token-store.js';
import { RedisResolutionKeyStore } from '../../../../contexts/identity/infrastructure/resolution-key-store.js';
import type { StoredVerificationAttempt } from '../../../../contexts/identity/infrastructure/verification-token-store.js';
import type { SessionResolutionKey } from '../../../../contexts/identity/domain/session-resolution-key.js';
import { buildResolutionKeyId } from '../../../../contexts/identity/domain/session-resolution-key.js';

// =============================================================================
// REDIS CONNECTION
// =============================================================================

let redis: Redis | null = null;
let redisAvailable = false;

/** Unique prefix per test run to avoid key collisions. */
const RUN_PREFIX = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Track all keys created during tests for cleanup. */
const createdKeys: string[] = [];

beforeAll(async () => {
  try {
    redis = new Redis({
      host: '127.0.0.1',
      port: 6379,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    await redis.connect();
    await redis.ping();
    redisAvailable = true;
  } catch {
    console.warn(
      '[Test Setup] Redis not available — identity Redis integration tests will be skipped',
    );
    redis = null;
  }
});

afterAll(async () => {
  if (redis) {
    // Clean up any remaining keys
    if (createdKeys.length > 0) {
      await redis.del(...createdKeys);
    }
    await redis.quit();
  }
});

// =============================================================================
// HELPERS
// =============================================================================

let seq = 0;
function uniqueId(prefix = 'id'): string {
  return `${RUN_PREFIX}-${prefix}-${++seq}`;
}

function getRedis(): Redis {
  if (!redis) throw new Error('Redis not available');
  return redis;
}

function makeStoredAttempt(
  overrides: Partial<StoredVerificationAttempt> = {},
): StoredVerificationAttempt {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000); // 60s from now
  return {
    id: uniqueId('attempt'),
    tenantId: uniqueId('tenant'),
    sessionId: uniqueId('session'),
    method: 'otp',
    identityValue: 'user@example.com',
    identityType: 'email_thread',
    status: 'pending',
    attempts: 0,
    maxAttempts: 5,
    createdAt: now,
    expiresAt,
    codeHash: 'hash_abc123',
    ...overrides,
  } as StoredVerificationAttempt;
}

function makeResolutionKey(overrides: Partial<SessionResolutionKey> = {}): SessionResolutionKey {
  const expiresAt = new Date(Date.now() + 60_000); // 60s from now
  return {
    tenantId: uniqueId('tenant'),
    channelId: uniqueId('channel'),
    artifactHash: uniqueId('hash'),
    sessionId: uniqueId('session'),
    expiresAt,
    ...overrides,
  };
}

/**
 * Track a verification token key for cleanup.
 * Key pattern: verify:{tenantId}:{attemptId}
 */
function trackVerifyKey(tenantId: string, attemptId: string): void {
  createdKeys.push(`verify:${tenantId}:${attemptId}`);
}

/**
 * Track a resolution key for cleanup.
 * Key pattern: session_resolution:{tenantId}:{channelId}:{artifactHash}
 */
function trackResolutionKey(tenantId: string, channelId: string, artifactHash: string): void {
  createdKeys.push(buildResolutionKeyId(tenantId, channelId, artifactHash));
}

// =============================================================================
// INT-1: RedisVerificationTokenStore
// =============================================================================

describe('INT-1: RedisVerificationTokenStore (real Redis)', () => {
  let store: RedisVerificationTokenStore;

  beforeAll(() => {
    if (!redisAvailable) return;
    store = new RedisVerificationTokenStore(() => getRedis());
  });

  afterEach(async () => {
    if (!redisAvailable || !redis) return;
    // Clean up tracked keys
    if (createdKeys.length > 0) {
      await redis.del(...createdKeys);
      createdKeys.length = 0;
    }
  });

  test('skips if Redis is not available', () => {
    if (!redisAvailable) {
      console.log('Redis not available — skipping INT-1 tests');
      return;
    }
    expect(store).toBeDefined();
  });

  test('create and get returns correct data with Date fields round-tripped', async () => {
    if (!redisAvailable) return;

    const attempt = makeStoredAttempt();
    trackVerifyKey(attempt.tenantId, attempt.id);

    await store.create(attempt);
    const result = await store.get(attempt.tenantId, attempt.id);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(attempt.id);
    expect(result!.tenantId).toBe(attempt.tenantId);
    expect(result!.sessionId).toBe(attempt.sessionId);
    expect(result!.method).toBe(attempt.method);
    expect(result!.identityValue).toBe(attempt.identityValue);
    expect(result!.identityType).toBe(attempt.identityType);
    expect(result!.status).toBe('pending');
    expect(result!.attempts).toBe(0);
    expect(result!.maxAttempts).toBe(5);
    expect(result!.codeHash).toBe(attempt.codeHash);

    // Date fields round-trip correctly
    expect(result!.createdAt).toBeInstanceOf(Date);
    expect(result!.expiresAt).toBeInstanceOf(Date);
    expect(result!.createdAt.toISOString()).toBe(attempt.createdAt.toISOString());
    expect(result!.expiresAt.toISOString()).toBe(attempt.expiresAt.toISOString());
  });

  test('incrementAttempts atomically increments via Lua script', async () => {
    if (!redisAvailable) return;

    const attempt = makeStoredAttempt({ attempts: 0 });
    trackVerifyKey(attempt.tenantId, attempt.id);

    await store.create(attempt);

    // Increment three times
    await store.incrementAttempts(attempt.tenantId, attempt.id);
    await store.incrementAttempts(attempt.tenantId, attempt.id);
    await store.incrementAttempts(attempt.tenantId, attempt.id);

    const result = await store.get(attempt.tenantId, attempt.id);
    expect(result).not.toBeNull();
    expect(result!.attempts).toBe(3);
    // Other fields should be unchanged
    expect(result!.status).toBe('pending');
    expect(result!.id).toBe(attempt.id);
  });

  test('markVerified atomically sets status to verified via Lua script', async () => {
    if (!redisAvailable) return;

    const attempt = makeStoredAttempt({ status: 'pending' });
    trackVerifyKey(attempt.tenantId, attempt.id);

    await store.create(attempt);
    await store.markVerified(attempt.tenantId, attempt.id);

    const result = await store.get(attempt.tenantId, attempt.id);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('verified');
    // Other fields should be unchanged
    expect(result!.id).toBe(attempt.id);
    expect(result!.attempts).toBe(attempt.attempts);
  });

  test('tenant isolation: get with different tenantId returns null', async () => {
    if (!redisAvailable) return;

    const attempt = makeStoredAttempt();
    trackVerifyKey(attempt.tenantId, attempt.id);

    await store.create(attempt);

    // Try to get with a different tenantId
    const differentTenant = uniqueId('other-tenant');
    const result = await store.get(differentTenant, attempt.id);
    expect(result).toBeNull();
  });

  test('TTL expiry: create with short TTL, verify expiry', async () => {
    if (!redisAvailable) return;

    // Create an attempt that expires in 1 second
    const shortExpiresAt = new Date(Date.now() + 1_000);
    const attempt = makeStoredAttempt({ expiresAt: shortExpiresAt });
    trackVerifyKey(attempt.tenantId, attempt.id);

    await store.create(attempt);

    // Verify it exists immediately
    const immediate = await store.get(attempt.tenantId, attempt.id);
    expect(immediate).not.toBeNull();

    // Wait for TTL to expire (1.5s should be enough for a 1s TTL)
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const expired = await store.get(attempt.tenantId, attempt.id);
    expect(expired).toBeNull();
  });

  test('non-existent attempt returns null', async () => {
    if (!redisAvailable) return;

    const result = await store.get(uniqueId('tenant'), uniqueId('nonexistent'));
    expect(result).toBeNull();
  });

  test('incrementAttempts on non-existent key is a no-op', async () => {
    if (!redisAvailable) return;

    // Should not throw — Lua script returns nil for missing key
    await store.incrementAttempts(uniqueId('tenant'), uniqueId('nonexistent'));
  });

  test('markVerified on non-existent key is a no-op', async () => {
    if (!redisAvailable) return;

    // Should not throw — Lua script returns nil for missing key
    await store.markVerified(uniqueId('tenant'), uniqueId('nonexistent'));
  });
});

// =============================================================================
// INT-2: RedisResolutionKeyStore
// =============================================================================

describe('INT-2: RedisResolutionKeyStore (real Redis)', () => {
  let store: RedisResolutionKeyStore;

  beforeAll(() => {
    if (!redisAvailable) return;
    store = new RedisResolutionKeyStore(() => getRedis());
  });

  afterEach(async () => {
    if (!redisAvailable || !redis) return;
    // Clean up tracked keys
    if (createdKeys.length > 0) {
      await redis.del(...createdKeys);
      createdKeys.length = 0;
    }
  });

  test('skips if Redis is not available', () => {
    if (!redisAvailable) {
      console.log('Redis not available — skipping INT-2 tests');
      return;
    }
    expect(store).toBeDefined();
  });

  test('save key, findByKey returns session locator', async () => {
    if (!redisAvailable) return;

    const key = makeResolutionKey();
    trackResolutionKey(key.tenantId, key.channelId, key.artifactHash);

    await store.save(key);
    const result = await store.findByKey(key.tenantId, key.channelId, key.artifactHash);

    expect(result).not.toBeNull();
    expect(result!.sessionLocator.sessionId).toBe(key.sessionId);
    expect(result!.sessionLocator.tenantId).toBe(key.tenantId);
    expect(result!.sessionPrincipalId).toBe(key.sessionId);
  });

  test('tenant isolation: findByKey with different tenantId returns null', async () => {
    if (!redisAvailable) return;

    const key = makeResolutionKey();
    trackResolutionKey(key.tenantId, key.channelId, key.artifactHash);

    await store.save(key);

    const differentTenant = uniqueId('other-tenant');
    const result = await store.findByKey(differentTenant, key.channelId, key.artifactHash);
    expect(result).toBeNull();
  });

  test('channel isolation: findByKey with different channelId returns null', async () => {
    if (!redisAvailable) return;

    const key = makeResolutionKey();
    trackResolutionKey(key.tenantId, key.channelId, key.artifactHash);

    await store.save(key);

    const differentChannel = uniqueId('other-channel');
    const result = await store.findByKey(key.tenantId, differentChannel, key.artifactHash);
    expect(result).toBeNull();
  });

  test('overwrite: save with same tuple but different sessionId', async () => {
    if (!redisAvailable) return;

    const tenantId = uniqueId('tenant');
    const channelId = uniqueId('channel');
    const artifactHash = uniqueId('hash');
    trackResolutionKey(tenantId, channelId, artifactHash);

    const firstSessionId = uniqueId('session-1');
    const secondSessionId = uniqueId('session-2');

    // Save first key
    await store.save({
      tenantId,
      channelId,
      artifactHash,
      sessionId: firstSessionId,
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Verify first session
    const first = await store.findByKey(tenantId, channelId, artifactHash);
    expect(first).not.toBeNull();
    expect(first!.sessionLocator.sessionId).toBe(firstSessionId);

    // Overwrite with second session
    await store.save({
      tenantId,
      channelId,
      artifactHash,
      sessionId: secondSessionId,
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Verify overwrite
    const second = await store.findByKey(tenantId, channelId, artifactHash);
    expect(second).not.toBeNull();
    expect(second!.sessionLocator.sessionId).toBe(secondSessionId);
  });

  test('remove: verify deletion', async () => {
    if (!redisAvailable) return;

    const key = makeResolutionKey();
    trackResolutionKey(key.tenantId, key.channelId, key.artifactHash);

    await store.save(key);

    // Verify it exists
    const before = await store.findByKey(key.tenantId, key.channelId, key.artifactHash);
    expect(before).not.toBeNull();

    // Remove it
    await store.remove(key.tenantId, key.channelId, key.artifactHash);

    // Verify it is gone
    const after = await store.findByKey(key.tenantId, key.channelId, key.artifactHash);
    expect(after).toBeNull();
  });

  test('TTL expiry: save with near-future expiresAt, verify expired', async () => {
    if (!redisAvailable) return;

    const key = makeResolutionKey({
      expiresAt: new Date(Date.now() + 1_000), // 1 second from now
    });
    trackResolutionKey(key.tenantId, key.channelId, key.artifactHash);

    await store.save(key);

    // Verify it exists immediately
    const immediate = await store.findByKey(key.tenantId, key.channelId, key.artifactHash);
    expect(immediate).not.toBeNull();

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const expired = await store.findByKey(key.tenantId, key.channelId, key.artifactHash);
    expect(expired).toBeNull();
  });

  test('findByKey on non-existent key returns null', async () => {
    if (!redisAvailable) return;

    const result = await store.findByKey(uniqueId('tenant'), uniqueId('channel'), uniqueId('hash'));
    expect(result).toBeNull();
  });

  test('remove on non-existent key is a no-op', async () => {
    if (!redisAvailable) return;

    // Should not throw
    await store.remove(uniqueId('tenant'), uniqueId('channel'), uniqueId('hash'));
  });
});
