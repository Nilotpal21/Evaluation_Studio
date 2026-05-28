/**
 * LRUTTLCache — Unit Tests
 *
 * Covers:
 * - LRU eviction in insertion order
 * - TTL expiry via injected clock
 * - No double-eviction on re-set
 * - clear() empties the cache
 * - delete() returns boolean
 * - has() returns false for expired entries
 */

import { describe, test, expect } from 'vitest';
import { LRUTTLCache } from '../lru-ttl-cache.js';

describe('LRUTTLCache', () => {
  // ─── Basic get/set ──────────────────────────────────────────────────────

  test('stores and retrieves values', () => {
    const cache = new LRUTTLCache<string>({ maxEntries: 10, ttlMs: 60_000 });
    cache.set('a', 'alpha');
    cache.set('b', 'beta');
    expect(cache.get('a')).toBe('alpha');
    expect(cache.get('b')).toBe('beta');
    expect(cache.size).toBe(2);
  });

  test('returns undefined for missing keys', () => {
    const cache = new LRUTTLCache<string>({ maxEntries: 10, ttlMs: 60_000 });
    expect(cache.get('missing')).toBeUndefined();
  });

  // ─── LRU eviction ──────────────────────────────────────────────────────

  test('evicts oldest entry when maxEntries exceeded', () => {
    const cache = new LRUTTLCache<number>({ maxEntries: 3, ttlMs: 60_000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Adding a 4th should evict 'a' (oldest)
    cache.set('d', 4);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
    expect(cache.size).toBe(3);
  });

  test('evicts in insertion order (FIFO for LRU)', () => {
    const cache = new LRUTTLCache<number>({ maxEntries: 2, ttlMs: 60_000 });
    cache.set('a', 1);
    cache.set('b', 2);
    // Evicts 'a'
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    // Evicts 'b'
    cache.set('d', 4);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  test('re-set refreshes position (no double-eviction)', () => {
    const cache = new LRUTTLCache<number>({ maxEntries: 3, ttlMs: 60_000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    // Re-set 'a' — moves it to the end of insertion order
    cache.set('a', 10);
    expect(cache.size).toBe(3);

    // Adding 'd' should evict 'b' (now oldest), not 'a'
    cache.set('d', 4);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(10);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
    expect(cache.size).toBe(3);
  });

  // ─── TTL expiry ─────────────────────────────────────────────────────────

  test('returns undefined for expired entries on get (lazy eviction)', () => {
    let clock = 1000;
    const cache = new LRUTTLCache<string>({
      maxEntries: 10,
      ttlMs: 5000,
      now: () => clock,
    });

    cache.set('x', 'value');
    expect(cache.get('x')).toBe('value');

    // Advance clock past TTL
    clock = 6000;
    expect(cache.get('x')).toBeUndefined();
    // Entry should be physically removed
    expect(cache.size).toBe(0);
  });

  test('has() returns false for expired entries', () => {
    let clock = 0;
    const cache = new LRUTTLCache<string>({
      maxEntries: 10,
      ttlMs: 100,
      now: () => clock,
    });

    cache.set('k', 'v');
    expect(cache.has('k')).toBe(true);

    clock = 100; // Exactly at TTL boundary — should expire (>= check)
    expect(cache.has('k')).toBe(false);
    expect(cache.size).toBe(0);
  });

  test('TTL is based on insertion time, not last access', () => {
    let clock = 0;
    const cache = new LRUTTLCache<string>({
      maxEntries: 10,
      ttlMs: 100,
      now: () => clock,
    });

    cache.set('k', 'v');
    clock = 50;
    expect(cache.get('k')).toBe('v'); // Access does NOT reset TTL

    clock = 100;
    expect(cache.get('k')).toBeUndefined(); // Expired relative to insertion
  });

  // ─── delete ─────────────────────────────────────────────────────────────

  test('delete returns true for existing key', () => {
    const cache = new LRUTTLCache<string>({ maxEntries: 10, ttlMs: 60_000 });
    cache.set('a', 'val');
    expect(cache.delete('a')).toBe(true);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test('delete returns false for non-existing key', () => {
    const cache = new LRUTTLCache<string>({ maxEntries: 10, ttlMs: 60_000 });
    expect(cache.delete('nope')).toBe(false);
  });

  // ─── clear ──────────────────────────────────────────────────────────────

  test('clear empties the cache', () => {
    const cache = new LRUTTLCache<string>({ maxEntries: 10, ttlMs: 60_000 });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    expect(cache.size).toBe(3);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeUndefined();
  });

  // ─── Edge cases ─────────────────────────────────────────────────────────

  test('maxEntries=1 only ever holds one entry', () => {
    const cache = new LRUTTLCache<string>({ maxEntries: 1, ttlMs: 60_000 });
    cache.set('a', '1');
    cache.set('b', '2');
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('2');
  });

  test('overwrite same key does not increase size', () => {
    const cache = new LRUTTLCache<string>({ maxEntries: 5, ttlMs: 60_000 });
    cache.set('k', 'v1');
    cache.set('k', 'v2');
    expect(cache.size).toBe(1);
    expect(cache.get('k')).toBe('v2');
  });
});
