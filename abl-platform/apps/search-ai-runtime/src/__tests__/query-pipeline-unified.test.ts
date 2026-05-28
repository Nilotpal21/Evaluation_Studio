/**
 * Query Pipeline Unified Tests
 *
 * Pure function tests for exported utilities (no vi.mock needed).
 *
 * Covers:
 * - buildQueryCacheKey: deterministic keys, auth scoping, field exclusion
 * - QueryCache: hit/miss/TTL/tenant isolation
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { buildQueryCacheKey } from '../services/query/query-pipeline.js';
import { QueryCache } from '../services/query/query-cache.js';
import type { UnifiedSearchQuery } from '../services/query/types.js';

// =============================================================================
// buildQueryCacheKey — Pure function tests (no mocks needed)
// =============================================================================

describe('buildQueryCacheKey', () => {
  const baseQuery: UnifiedSearchQuery = {
    indexId: 'idx-1',
    query: 'test search',
    queryType: 'hybrid',
  };

  test('produces deterministic key for same query', () => {
    const key1 = buildQueryCacheKey(baseQuery, 'public');
    const key2 = buildQueryCacheKey(baseQuery, 'public');
    expect(key1).toBe(key2);
    expect(key1).toHaveLength(64); // SHA-256 hex
  });

  test('different queries produce different keys', () => {
    const key1 = buildQueryCacheKey({ ...baseQuery, query: 'test A' }, 'public');
    const key2 = buildQueryCacheKey({ ...baseQuery, query: 'test B' }, 'public');
    expect(key1).not.toBe(key2);
  });

  test('different indexIds produce different keys', () => {
    const key1 = buildQueryCacheKey({ ...baseQuery, indexId: 'idx-1' }, 'public');
    const key2 = buildQueryCacheKey({ ...baseQuery, indexId: 'idx-2' }, 'public');
    expect(key1).not.toBe(key2);
  });

  test('different queryTypes produce different keys', () => {
    const key1 = buildQueryCacheKey({ ...baseQuery, queryType: 'hybrid' }, 'public');
    const key2 = buildQueryCacheKey({ ...baseQuery, queryType: 'semantic' }, 'public');
    expect(key1).not.toBe(key2);
  });

  test('different authModes produce different keys', () => {
    const key1 = buildQueryCacheKey(baseQuery, 'public');
    const key2 = buildQueryCacheKey(baseQuery, 'user', { idpUserId: 'u1' } as any);
    expect(key1).not.toBe(key2);
  });

  test('different users produce different keys (tenant isolation)', () => {
    const key1 = buildQueryCacheKey(baseQuery, 'user', { idpUserId: 'user-A' } as any);
    const key2 = buildQueryCacheKey(baseQuery, 'user', { idpUserId: 'user-B' } as any);
    expect(key1).not.toBe(key2);
  });

  test('excludes debug field from cache key', () => {
    const key1 = buildQueryCacheKey({ ...baseQuery, debug: true }, 'public');
    const key2 = buildQueryCacheKey({ ...baseQuery, debug: false }, 'public');
    expect(key1).toBe(key2);
  });

  test('includes filters in cache key', () => {
    const withFilters = {
      ...baseQuery,
      filters: [{ field: 'type', operator: 'eq', value: 'pdf' }],
    };
    const key1 = buildQueryCacheKey(baseQuery, 'public');
    const key2 = buildQueryCacheKey(withFilters as any, 'public');
    expect(key1).not.toBe(key2);
  });

  test('includes topK in cache key', () => {
    const key1 = buildQueryCacheKey({ ...baseQuery, topK: 5 }, 'public');
    const key2 = buildQueryCacheKey({ ...baseQuery, topK: 10 }, 'public');
    expect(key1).not.toBe(key2);
  });

  test('undefined authMode defaults to public', () => {
    const key1 = buildQueryCacheKey(baseQuery, undefined);
    const key2 = buildQueryCacheKey(baseQuery, 'public');
    expect(key1).toBe(key2);
  });

  test('user mode without idpUserId omits userId from key', () => {
    const key1 = buildQueryCacheKey(baseQuery, 'user');
    const key2 = buildQueryCacheKey(baseQuery, 'user', {} as any);
    expect(key1).toBe(key2);
  });
});

// =============================================================================
// QueryCache — Integration tests with in-memory fallback
// =============================================================================

describe('QueryCache — in-memory', () => {
  let cache: QueryCache;

  beforeEach(() => {
    cache = new QueryCache(); // No Redis — in-memory only
  });

  test('returns null for cache miss', async () => {
    const result = await cache.get('nonexistent', 'tenant-1');
    expect(result).toBeNull();
  });

  test('stores and retrieves value', async () => {
    const data = { results: [{ title: 'Test' }], totalCount: 1 };
    await cache.set('key-1', data, 300, 'tenant-1');
    const result = await cache.get('key-1', 'tenant-1');
    expect(result).toEqual(data);
  });

  test('tenant isolation — different tenants see different values', async () => {
    await cache.set('same-key', { data: 'tenant-A' }, 300, 'tenant-A');
    await cache.set('same-key', { data: 'tenant-B' }, 300, 'tenant-B');

    const resultA = await cache.get<{ data: string }>('same-key', 'tenant-A');
    const resultB = await cache.get<{ data: string }>('same-key', 'tenant-B');
    expect(resultA?.data).toBe('tenant-A');
    expect(resultB?.data).toBe('tenant-B');
  });

  test('respects TTL — expired entries return null', async () => {
    await cache.set('expiring', { value: 1 }, 0, 'tenant-1'); // 0 second TTL
    // Entry expires immediately
    await new Promise((r) => setTimeout(r, 10));
    const result = await cache.get('expiring', 'tenant-1');
    expect(result).toBeNull();
  });

  test('clear removes all entries', async () => {
    await cache.set('key-1', { a: 1 }, 300, 'tenant-1');
    await cache.set('key-2', { b: 2 }, 300, 'tenant-1');
    await cache.clear();
    expect(await cache.get('key-1', 'tenant-1')).toBeNull();
    expect(await cache.get('key-2', 'tenant-1')).toBeNull();
  });
});

// NOTE: parseClassifyPlan, buildSimpleClassifyPrompt, and classifyKBComplexity
// tests live in apps/runtime tests — those functions are in the runtime package.
// =============================================================================
