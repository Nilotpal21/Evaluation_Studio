import { describe, it, expect, beforeEach } from 'vitest';
import { createRingBuffer } from '../../session/ring-buffer.js';
import type { RingBufferEvent } from '../../session/ring-buffer.js';

// In-memory fake Redis client with the methods our ring buffer uses.
// Strict dependency-injection — no vi.mock of platform packages.
type ZEntry = { score: number; member: string };
class FakeRedis {
  private zsets = new Map<string, ZEntry[]>();
  private ttls = new Map<string, number>();

  async zadd(key: string, score: number, member: string): Promise<number> {
    const set = this.zsets.get(key) ?? [];
    set.push({ score, member });
    set.sort((a, b) => a.score - b.score);
    this.zsets.set(key, set);
    return 1;
  }
  async zrangebyscore(key: string, min: number | '-inf', max: number | '+inf'): Promise<string[]> {
    const set = this.zsets.get(key) ?? [];
    return set
      .filter((e) => {
        if (min !== '-inf' && e.score < min) return false;
        if (max !== '+inf' && e.score > max) return false;
        return true;
      })
      .map((e) => e.member);
  }
  async zrange(
    key: string,
    start: number,
    stop: number,
    withScores?: 'WITHSCORES',
  ): Promise<string[]> {
    const set = this.zsets.get(key) ?? [];
    const slice = set.slice(start, stop === -1 ? undefined : stop + 1);
    if (withScores === 'WITHSCORES') {
      return slice.flatMap((e) => [e.member, String(e.score)]);
    }
    return slice.map((e) => e.member);
  }
  async zcard(key: string): Promise<number> {
    return (this.zsets.get(key) ?? []).length;
  }
  async zremrangebyrank(key: string, start: number, stop: number): Promise<number> {
    const set = this.zsets.get(key) ?? [];
    const removed = set.splice(start, stop === -1 ? set.length : stop - start + 1);
    this.zsets.set(key, set);
    return removed.length;
  }
  async expire(key: string, seconds: number): Promise<number> {
    this.ttls.set(key, seconds);
    return 1;
  }
  async del(key: string): Promise<number> {
    const had = this.zsets.delete(key);
    this.ttls.delete(key);
    return had ? 1 : 0;
  }

  _getTTL(key: string) {
    return this.ttls.get(key);
  }
  _size(key: string) {
    return this.zsets.get(key)?.length ?? 0;
  }
}

describe('RingBuffer', () => {
  let redis: FakeRedis;
  beforeEach(() => {
    redis = new FakeRedis();
  });

  it('stores and returns durable events keyed by seq', async () => {
    const buf = createRingBuffer({ redis, sizeLimit: 1000, ttlSeconds: 3600 });
    const event: RingBufferEvent = {
      seq: 1,
      kind: 'turn_committed',
      payload: {},
      timestamp: Date.now(),
    };
    await buf.push('session-1', event);

    const result = await buf.readSince('session-1', 0);
    expect(result).toEqual([event]);
  });

  it('returns only events with seq > sinceSeq', async () => {
    const buf = createRingBuffer({ redis, sizeLimit: 1000, ttlSeconds: 3600 });
    const a: RingBufferEvent = {
      seq: 1,
      kind: 'artifact_update',
      payload: { channel: 'topology' },
      timestamp: 1,
    };
    const b: RingBufferEvent = {
      seq: 2,
      kind: 'turn_committed',
      payload: {},
      timestamp: 2,
    };
    const c: RingBufferEvent = {
      seq: 3,
      kind: 'turn_ended',
      payload: {},
      timestamp: 3,
    };
    await buf.push('s1', a);
    await buf.push('s1', b);
    await buf.push('s1', c);

    const result = await buf.readSince('s1', 1);
    expect(result).toEqual([b, c]);
  });

  it('returns SNAPSHOT_REQUIRED when sinceSeq is older than buffer', async () => {
    const buf = createRingBuffer({ redis, sizeLimit: 3, ttlSeconds: 3600 });
    for (let i = 10; i < 14; i++) {
      await buf.push('s1', {
        seq: i,
        kind: 'artifact_update',
        payload: {},
        timestamp: i,
      });
    }
    // Buffer size-capped at 3; oldest seq is 11 after eviction.

    const result = await buf.readSince('s1', 5);
    expect(result).toBe('SNAPSHOT_REQUIRED');
  });

  it('evicts oldest entries FIFO when size exceeds limit', async () => {
    const buf = createRingBuffer({ redis, sizeLimit: 3, ttlSeconds: 3600 });
    for (let i = 1; i <= 5; i++) {
      await buf.push('s1', {
        seq: i,
        kind: 'artifact_update',
        payload: { n: i },
        timestamp: i,
      });
    }
    expect(redis._size('arch:v4:events:s1')).toBe(3);

    // readSince(0) — buffer oldest is seq 3, caller position 0 is older → snapshot required.
    const result = await buf.readSince('s1', 0);
    expect(result).toBe('SNAPSHOT_REQUIRED');

    // readSince(2) — buffer oldest is seq 3, caller position 2 → can return seq 3,4,5.
    const fresh = await buf.readSince('s1', 2);
    expect(fresh).toEqual([
      { seq: 3, kind: 'artifact_update', payload: { n: 3 }, timestamp: 3 },
      { seq: 4, kind: 'artifact_update', payload: { n: 4 }, timestamp: 4 },
      { seq: 5, kind: 'artifact_update', payload: { n: 5 }, timestamp: 5 },
    ]);
  });

  it('refreshes TTL on every write', async () => {
    const buf = createRingBuffer({ redis, sizeLimit: 1000, ttlSeconds: 3600 });
    await buf.push('s1', { seq: 1, kind: 'artifact_update', payload: {}, timestamp: 1 });
    expect(redis._getTTL('arch:v4:events:s1')).toBe(3600);
  });

  it('clear() removes the session buffer', async () => {
    const buf = createRingBuffer({ redis, sizeLimit: 1000, ttlSeconds: 3600 });
    await buf.push('s1', { seq: 1, kind: 'artifact_update', payload: {}, timestamp: 1 });
    await buf.clear('s1');
    expect(redis._size('arch:v4:events:s1')).toBe(0);
  });
});
