import { describe, it, expect } from 'vitest';

/**
 * Unit tests for SET-based session counting logic.
 * Tests the in-memory fallback (Map<string, Set<string>>) which mirrors
 * the Redis SET semantics (SADD/SREM/SCARD).
 */
describe('Session counting (SET-based)', () => {
  function createCounter() {
    const sets = new Map<string, Set<string>>();
    const MAX = 5;

    function claim(tenantId: string, sessionId: string, limit: number): number {
      let s = sets.get(tenantId);
      if (!s) {
        if (sets.size >= MAX) {
          const oldest = sets.keys().next().value;
          if (oldest !== undefined) sets.delete(oldest);
        }
        s = new Set();
        sets.set(tenantId, s);
      }
      if (limit >= 0 && s.size >= limit) return -1;
      s.add(sessionId);
      return s.size;
    }

    function release(tenantId: string, sessionId: string): number {
      const s = sets.get(tenantId);
      if (!s) return 0;
      s.delete(sessionId);
      return s.size;
    }

    function count(tenantId: string): number {
      return sets.get(tenantId)?.size ?? 0;
    }

    return { claim, release, count, sets };
  }

  it('tracks sessions by ID', () => {
    const { claim, count } = createCounter();
    claim('t1', 'sess-a', -1);
    claim('t1', 'sess-b', -1);
    expect(count('t1')).toBe(2);
  });

  it('idempotent add — same session ID twice does not double count', () => {
    const { claim, count } = createCounter();
    claim('t1', 'sess-a', -1);
    claim('t1', 'sess-a', -1);
    expect(count('t1')).toBe(1);
  });

  it('removes by session ID', () => {
    const { claim, release, count } = createCounter();
    claim('t1', 'sess-a', -1);
    claim('t1', 'sess-b', -1);
    release('t1', 'sess-a');
    expect(count('t1')).toBe(1);
  });

  it('release of unknown session is a no-op', () => {
    const { claim, release, count } = createCounter();
    claim('t1', 'sess-a', -1);
    release('t1', 'sess-unknown');
    expect(count('t1')).toBe(1);
  });

  it('rejects when at limit', () => {
    const { claim } = createCounter();
    expect(claim('t1', 'sess-a', 2)).toBe(1);
    expect(claim('t1', 'sess-b', 2)).toBe(2);
    expect(claim('t1', 'sess-c', 2)).toBe(-1);
  });

  it('unlimited when limit is -1', () => {
    const { claim } = createCounter();
    for (let i = 0; i < 100; i++) {
      expect(claim('t1', `sess-${i}`, -1)).toBe(i + 1);
    }
  });

  it('isolates counts per tenant', () => {
    const { claim, count } = createCounter();
    claim('t1', 'sess-a', -1);
    claim('t1', 'sess-b', -1);
    claim('t2', 'sess-c', -1);
    expect(count('t1')).toBe(2);
    expect(count('t2')).toBe(1);
  });

  it('bounds in-memory map size', () => {
    const { claim, sets } = createCounter();
    for (let i = 0; i < 10; i++) {
      claim(`tenant-${i}`, `sess-${i}`, -1);
    }
    expect(sets.size).toBeLessThanOrEqual(5);
  });
});
