/**
 * Citation Token Service Tests
 *
 * Tests for extractS3Key, validateTenantOwnership, and checkClickLimit.
 * These are utility functions used by the citation download route.
 *
 * Business logic covered:
 * - S3 key extraction from various URL formats
 * - Tenant ownership validation (security gate)
 * - Click limit enforcement with atomic Redis operations
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  extractS3Key,
  validateTenantOwnership,
  checkClickLimit,
  CitationError,
} from '../services/citation-token.service.js';

describe('extractS3Key', () => {
  test('strips s3://bucket/ prefix', () => {
    expect(extractS3Key('s3://my-bucket/documents/tenant-1/idx/file.pdf')).toBe(
      'documents/tenant-1/idx/file.pdf',
    );
  });

  test('strips /uploads/ prefix', () => {
    expect(extractS3Key('/uploads/documents/tenant-1/file.pdf')).toBe(
      'documents/tenant-1/file.pdf',
    );
  });

  test('returns input unchanged if no recognized prefix', () => {
    expect(extractS3Key('documents/tenant-1/file.pdf')).toBe('documents/tenant-1/file.pdf');
  });

  test('handles s3:// with no slash after bucket (just bucket name)', () => {
    expect(extractS3Key('s3://mybucket')).toBe('mybucket');
  });

  test('handles s3:// with slash immediately after bucket', () => {
    expect(extractS3Key('s3://bucket/key.pdf')).toBe('key.pdf');
  });

  test('handles empty string input', () => {
    expect(extractS3Key('')).toBe('');
  });

  test('handles deep nested paths', () => {
    expect(extractS3Key('s3://bucket/a/b/c/d/e/file.pdf')).toBe('a/b/c/d/e/file.pdf');
  });
});

describe('validateTenantOwnership', () => {
  test('passes when key contains /tenantId/ in path', () => {
    expect(() =>
      validateTenantOwnership('tenant-001', 'documents/tenant-001/idx/file.pdf'),
    ).not.toThrow();
  });

  test('passes when key starts with tenantId/', () => {
    expect(() =>
      validateTenantOwnership('tenant-001', 'tenant-001/documents/file.pdf'),
    ).not.toThrow();
  });

  test('throws TENANT_VIOLATION when key does not contain tenantId', () => {
    expect(() =>
      validateTenantOwnership('tenant-001', 'documents/tenant-002/idx/file.pdf'),
    ).toThrow(CitationError);

    try {
      validateTenantOwnership('tenant-001', 'documents/tenant-002/idx/file.pdf');
    } catch (e) {
      expect((e as CitationError).code).toBe('TENANT_VIOLATION');
    }
  });

  test('throws when tenantId is substring but not path segment', () => {
    // "tenant-1" should not match "tenant-10" segment
    // Actually the current implementation checks for `/${tenantId}/` which would not match
    // `tenant-1` in `/tenant-10/` since `/tenant-1/` != `/tenant-10/`
    expect(() => validateTenantOwnership('tenant-1', 'documents/tenant-10/idx/file.pdf')).toThrow(
      CitationError,
    );
  });

  test('passes with multi-segment tenant IDs containing slashes-adjacent chars', () => {
    expect(() =>
      validateTenantOwnership('org-abc-tenant-xyz', 'documents/org-abc-tenant-xyz/index/file.pdf'),
    ).not.toThrow();
  });

  test('passes when tenantId appears in crawler path pattern', () => {
    expect(() => validateTenantOwnership('t-123', 'crawler/cleaned/t-123/page.html')).not.toThrow();
  });
});

describe('checkClickLimit', () => {
  // Create a mock Redis that simulates atomic SET NX + DECR behavior
  let redisStore: Map<string, { value: number; ttl: number }>;

  function createMockRedis() {
    redisStore = new Map();
    return {
      set: async (key: string, value: string, ex: string, ttl: number, nx: string) => {
        if (nx === 'NX' && !redisStore.has(key)) {
          redisStore.set(key, { value: parseInt(value), ttl });
          return 'OK';
        }
        return null;
      },
      decr: async (key: string) => {
        const entry = redisStore.get(key);
        if (!entry) return -1;
        entry.value -= 1;
        return entry.value;
      },
      del: async (key: string) => {
        redisStore.delete(key);
        return 1;
      },
    } as any;
  }

  beforeEach(() => {
    redisStore = new Map();
  });

  test('returns remaining count on first click', async () => {
    const redis = createMockRedis();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const remaining = await checkClickLimit(redis, 'jti-1', 5, exp);
    // First click: SET NX sets 5, DECR returns 4
    expect(remaining).toBe(4);
  });

  test('decrements correctly on each subsequent click', async () => {
    const redis = createMockRedis();
    const exp = Math.floor(Date.now() / 1000) + 3600;

    const r1 = await checkClickLimit(redis, 'jti-2', 3, exp);
    expect(r1).toBe(2); // 3 - 1

    const r2 = await checkClickLimit(redis, 'jti-2', 3, exp);
    expect(r2).toBe(1); // 2 - 1

    const r3 = await checkClickLimit(redis, 'jti-2', 3, exp);
    expect(r3).toBe(0); // 1 - 1 (last allowed click)
  });

  test('throws CITATION_EXHAUSTED when clicks exceeded', async () => {
    const redis = createMockRedis();
    const exp = Math.floor(Date.now() / 1000) + 3600;

    // Exhaust all clicks
    await checkClickLimit(redis, 'jti-3', 1, exp); // remaining = 0

    // Next click should throw
    await expect(checkClickLimit(redis, 'jti-3', 1, exp)).rejects.toThrow(CitationError);
    try {
      await checkClickLimit(redis, 'jti-3', 1, exp);
    } catch (e) {
      expect((e as CitationError).code).toBe('CITATION_EXHAUSTED');
    }
  });

  test('throws CITATION_EXPIRED when TTL expired (exp in the past)', async () => {
    const redis = createMockRedis();
    const exp = Math.floor(Date.now() / 1000) - 10; // Already expired

    await expect(checkClickLimit(redis, 'jti-expired', 5, exp)).rejects.toThrow(CitationError);
    try {
      await checkClickLimit(redis, 'jti-expired', 5, exp);
    } catch (e) {
      expect((e as CitationError).code).toBe('CITATION_EXPIRED');
    }
  });

  test('uses default TTL (3600) when no exp claim', async () => {
    const redis = createMockRedis();
    const remaining = await checkClickLimit(redis, 'jti-no-exp', 5, undefined as any);
    // No exp → redisTtl = undefined - Date.now()/1000 → NaN → but default is 3600
    // Actually looking at code: exp ? exp - Math.floor(Date.now() / 1000) : 3600
    // So no exp = TTL 3600, which is > 0, so it proceeds
    expect(remaining).toBe(4);
  });

  test('keeps exhausted key until TTL so click limits cannot reset', async () => {
    const redis = createMockRedis();
    const exp = Math.floor(Date.now() / 1000) + 3600;

    await checkClickLimit(redis, 'jti-del', 1, exp); // remaining = 0

    try {
      await checkClickLimit(redis, 'jti-del', 1, exp);
    } catch {
      // Expected to throw
    }

    const entry = redisStore.get('citation:clicks:jti-del');
    expect(entry).toBeDefined();
    expect(entry!.value).toBeLessThan(0);
  });
});
