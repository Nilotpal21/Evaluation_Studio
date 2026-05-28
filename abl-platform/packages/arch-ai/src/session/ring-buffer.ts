/**
 * Redis sorted-set ring buffer for durable SSE event replay.
 *
 * Source of truth: docs/superpowers/specs/2026-04-18-arch-v4-design.md §9.3
 *
 * One sorted set per session, keyed by `arch:v4:events:<sessionId>`.
 * Score = seq number. Values = JSON-serialised RingBufferEvent.
 *
 * Design constraints:
 *  - 1-hour TTL (refreshed on every push)
 *  - 1000-event size cap (FIFO eviction — oldest evicted first)
 *  - readSince(sinceSeq) returns SNAPSHOT_REQUIRED when caller is behind the
 *    oldest surviving entry, so the reconnect path knows to re-fetch a full
 *    session snapshot before replaying incremental events.
 */

export interface RingBufferEvent {
  seq: number;
  kind: string;
  payload: unknown;
  timestamp: number;
}

/**
 * Minimal Redis interface required by the ring buffer.
 * Defined here so callers can inject any compatible client (ioredis, FakeRedis
 * in tests, etc.) without importing a concrete driver.
 */
export interface RingBufferClient {
  zadd(key: string, score: number, member: string): Promise<number>;
  zrangebyscore(key: string, min: number | '-inf', max: number | '+inf'): Promise<string[]>;
  zrange(key: string, start: number, stop: number, withScores?: 'WITHSCORES'): Promise<string[]>;
  zcard(key: string): Promise<number>;
  zremrangebyrank(key: string, start: number, stop: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  del(key: string): Promise<number>;
}

export interface RingBufferConfig {
  redis: RingBufferClient;
  /** Maximum number of events to retain per session. FIFO eviction. */
  sizeLimit: number;
  /** TTL in seconds, refreshed on every push. */
  ttlSeconds: number;
}

export interface RingBuffer {
  /**
   * Append an event to the session's ring buffer.
   * Evicts oldest entries if size exceeds sizeLimit. Refreshes TTL.
   */
  push(sessionId: string, event: RingBufferEvent): Promise<void>;

  /**
   * Return all events with seq > sinceSeq, in ascending seq order.
   *
   * Returns 'SNAPSHOT_REQUIRED' when:
   *  - The oldest entry in the buffer has seq > sinceSeq + 1, meaning at
   *    least one event between sinceSeq and the buffer's oldest entry was
   *    evicted. The caller must fetch a full session snapshot before resuming.
   */
  readSince(sessionId: string, sinceSeq: number): Promise<RingBufferEvent[] | 'SNAPSHOT_REQUIRED'>;

  /** Remove the entire buffer for a session (e.g. on session teardown). */
  clear(sessionId: string): Promise<void>;
}

const keyFor = (sessionId: string) => `arch:v4:events:${sessionId}`;

export function createRingBuffer(cfg: RingBufferConfig): RingBuffer {
  return {
    async push(sessionId, event) {
      const key = keyFor(sessionId);
      await cfg.redis.zadd(key, event.seq, JSON.stringify(event));

      // Enforce size cap: after adding, evict oldest (lowest-score) entries.
      const size = await cfg.redis.zcard(key);
      if (size > cfg.sizeLimit) {
        const removeCount = size - cfg.sizeLimit;
        // zremrangebyrank(key, 0, removeCount - 1) removes the N lowest-score entries.
        await cfg.redis.zremrangebyrank(key, 0, removeCount - 1);
      }

      // Refresh TTL on every write so active sessions stay alive.
      await cfg.redis.expire(key, cfg.ttlSeconds);
    },

    async readSince(sessionId, sinceSeq) {
      const key = keyFor(sessionId);

      // Fetch the oldest entry (rank 0) with its score so we can check for
      // eviction gaps. zrange with WITHSCORES returns [member, score, ...].
      const oldestWithScore = await cfg.redis.zrange(key, 0, 0, 'WITHSCORES');
      if (oldestWithScore.length >= 2) {
        const oldestSeq = Number(oldestWithScore[1]);
        // If the oldest surviving event's seq is strictly greater than
        // sinceSeq + 1, one or more intermediate events were evicted.
        // The caller's cursor is behind the buffer's retention window.
        if (oldestSeq > sinceSeq + 1) {
          return 'SNAPSHOT_REQUIRED';
        }
      }

      // Return all members with score > sinceSeq (i.e. seq > sinceSeq).
      const members = await cfg.redis.zrangebyscore(key, sinceSeq + 1, '+inf');
      return members.map((m) => JSON.parse(m) as RingBufferEvent);
    },

    async clear(sessionId) {
      await cfg.redis.del(keyFor(sessionId));
    },
  };
}
