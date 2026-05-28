/**
 * Unit test: the shared helper that builds a ring-buffer-aware publisher
 * must push durable events to the buffer and skip ephemeral ones.
 *
 * This locks the durable event set in — divergence between this list and
 * docs/superpowers/specs/2026-04-18-arch-v4-design.md §9.1 is a bug.
 */
import { describe, it, expect } from 'vitest';
import { createRingBuffer, type RingBufferClient } from '../../session/ring-buffer.js';
import { buildDurablePublisher, DURABLE_EVENT_KINDS } from '../../session/publisher-factory.js';

class FakeRedis implements RingBufferClient {
  zsets = new Map<string, Array<{ score: number; member: string }>>();
  async zadd(key: string, score: number, member: string): Promise<number> {
    const s = this.zsets.get(key) ?? [];
    s.push({ score, member });
    s.sort((a, b) => a.score - b.score);
    this.zsets.set(key, s);
    return 1;
  }
  async zrangebyscore(key: string, min: number | '-inf', max: number | '+inf'): Promise<string[]> {
    const s = this.zsets.get(key) ?? [];
    return s
      .filter((e) => (min === '-inf' || e.score >= min) && (max === '+inf' || e.score <= max))
      .map((e) => e.member);
  }
  async zrange(
    key: string,
    start: number,
    stop: number,
    withScores?: 'WITHSCORES',
  ): Promise<string[]> {
    const s = this.zsets.get(key) ?? [];
    const slice = s.slice(start, stop === -1 ? undefined : stop + 1);
    return withScores === 'WITHSCORES'
      ? slice.flatMap((e) => [e.member, String(e.score)])
      : slice.map((e) => e.member);
  }
  async zcard(key: string): Promise<number> {
    return this.zsets.get(key)?.length ?? 0;
  }
  async zremrangebyrank(key: string, start: number, stop: number): Promise<number> {
    const s = this.zsets.get(key) ?? [];
    const removed = s.splice(start, stop - start + 1);
    return removed.length;
  }
  async expire(): Promise<number> {
    return 1;
  }
  async del(key: string): Promise<number> {
    const had = this.zsets.has(key);
    this.zsets.delete(key);
    return had ? 1 : 0;
  }
}

/** Narrow event type for tests — avoids `as never` casts on event literals. */
type TestEvent = { type: string; sessionId: string; seq?: number; replaySeq?: number };

describe('buildDurablePublisher', () => {
  const liveCalls: Array<{ kind: string }> = [];
  const live = async (event: TestEvent): Promise<void> => {
    liveCalls.push({ kind: event.type });
  };

  it('exposes the V4 design §9.1 durable event set', () => {
    expect(DURABLE_EVENT_KINDS).toEqual(
      new Set([
        'artifact_updated',
        'interactive_tool',
        'turn_committed',
        'turn_ended',
        'turn_canceled',
        'turn_failed',
        'queued_message_accepted',
      ]),
    );
  });

  it('pushes durable events into the ring buffer AND calls live', async () => {
    const redis = new FakeRedis();
    const rb = createRingBuffer({
      redis,
      sizeLimit: 1000,
      ttlSeconds: 3600,
    });
    const publish = buildDurablePublisher<TestEvent>({
      live,
      ringBuffer: rb,
      nextDurableSeq: async () => 41,
    });

    liveCalls.length = 0;
    await publish({ type: 'turn_committed', seq: 1, sessionId: 'sess-1' });

    // Live was called (fan-out continues).
    expect(liveCalls.map((c) => c.kind)).toEqual(['turn_committed']);
    // Ring buffer received the event under the session-global replay cursor.
    const replayed = await rb.readSince('sess-1', 40);
    expect(Array.isArray(replayed)).toBe(true);
    expect((replayed as Array<{ kind: string; seq: number }>).length).toBe(1);
    expect((replayed as Array<{ kind: string; seq: number }>)[0].kind).toBe('turn_committed');
    expect((replayed as Array<{ kind: string; seq: number }>)[0].seq).toBe(41);
  });

  it('does NOT push ephemeral events into the ring buffer', async () => {
    const redis = new FakeRedis();
    const rb = createRingBuffer({
      redis,
      sizeLimit: 1000,
      ttlSeconds: 3600,
    });
    const publish = buildDurablePublisher<TestEvent>({ live, ringBuffer: rb });

    liveCalls.length = 0;
    let seq = 1;
    for (const type of ['text_delta', 'status', 'turn_started']) {
      await publish({ type, sessionId: 'sess-1', seq: seq++ });
    }
    expect(liveCalls.length).toBe(3);
    // Ephemeral events are never pushed — buffer is empty.
    const replayed = await rb.readSince('sess-1', 0);
    expect((replayed as Array<unknown>).length).toBe(0);
  });

  it('invokes onDurableInvariantViolation when a durable event lacks replaySeq', async () => {
    const redis = new FakeRedis();
    const rb = createRingBuffer({ redis, sizeLimit: 1000, ttlSeconds: 3600 });
    const violations: Array<{ type: string }> = [];
    const publish = buildDurablePublisher<TestEvent>({
      live,
      ringBuffer: rb,
      onDurableInvariantViolation: (e) => {
        violations.push({ type: e.type });
      },
    });

    liveCalls.length = 0;
    // Durable event without replaySeq — should trigger the handler and skip
    // ring-buffer push, but still call live.
    await publish({ type: 'turn_committed', sessionId: 'sess-1' });
    expect(violations).toEqual([{ type: 'turn_committed' }]);
    expect(liveCalls.map((c) => c.kind)).toEqual(['turn_committed']);
    const replayed = await rb.readSince('sess-1', 8);
    expect((replayed as Array<unknown>).length).toBe(0);
  });

  it('uses an existing replaySeq when present', async () => {
    const redis = new FakeRedis();
    const rb = createRingBuffer({ redis, sizeLimit: 1000, ttlSeconds: 3600 });
    const publish = buildDurablePublisher<TestEvent>({ live, ringBuffer: rb });

    liveCalls.length = 0;
    await publish({ type: 'turn_ended', sessionId: 'sess-1', replaySeq: 9 });

    expect(liveCalls.map((c) => c.kind)).toEqual(['turn_ended']);
    const replayed = await rb.readSince('sess-1', 8);
    const events = replayed as Array<{
      kind: string;
      seq: number;
      payload: { replaySeq?: number; type?: string };
    }>;
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('turn_ended');
    expect(events[0].seq).toBe(9);
    expect(events[0].payload.replaySeq).toBe(9);
  });

  it('default missing-replaySeq behavior throws', async () => {
    const redis = new FakeRedis();
    const rb = createRingBuffer({ redis, sizeLimit: 1000, ttlSeconds: 3600 });
    const publish = buildDurablePublisher<TestEvent>({ live, ringBuffer: rb });

    await expect(publish({ type: 'turn_committed', sessionId: 'sess-1' })).rejects.toThrow(
      /missing replaySeq/,
    );
  });
});
