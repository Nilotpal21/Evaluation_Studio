import { describe, it, expect, beforeEach } from 'vitest';
import {
  IntentQueue,
  createIntentQueue,
  enqueueIntents,
  dequeueNext,
  pruneExpired,
  peekNext,
} from '../services/execution/intent-queue.js';

describe('IntentQueue', () => {
  let queue: IntentQueue;
  beforeEach(() => {
    queue = createIntentQueue();
  });

  it('creates empty queue', () => {
    expect(queue.pending).toEqual([]);
  });

  it('enqueues intents sorted by confidence', () => {
    enqueueIntents(queue, [
      { intent: 'a', confidence: 0.7, original_message: 'msg' },
      { intent: 'b', confidence: 0.9, original_message: 'msg' },
    ]);
    expect(queue.pending[0].intent).toBe('b');
    expect(queue.pending[1].intent).toBe('a');
  });

  it('dequeues highest confidence first', () => {
    enqueueIntents(queue, [
      { intent: 'a', confidence: 0.7, original_message: 'msg' },
      { intent: 'b', confidence: 0.9, original_message: 'msg' },
    ]);
    const next = dequeueNext(queue);
    expect(next!.intent).toBe('b');
    expect(queue.pending).toHaveLength(1);
  });

  it('returns null when empty', () => {
    expect(dequeueNext(queue)).toBeNull();
  });

  it('peeks without removing', () => {
    enqueueIntents(queue, [{ intent: 'a', confidence: 0.9, original_message: 'msg' }]);
    expect(peekNext(queue)!.intent).toBe('a');
    expect(queue.pending).toHaveLength(1);
  });

  it('prunes expired entries', () => {
    queue.pending = [
      {
        intent: 'old',
        confidence: 0.8,
        original_message: 'msg',
        detected_at: new Date(Date.now() - 700_000).toISOString(),
      },
      {
        intent: 'fresh',
        confidence: 0.8,
        original_message: 'msg',
        detected_at: new Date().toISOString(),
      },
    ];
    pruneExpired(queue, 600_000);
    expect(queue.pending).toHaveLength(1);
    expect(queue.pending[0].intent).toBe('fresh');
  });

  it('prevents duplicate intents (updates confidence)', () => {
    enqueueIntents(queue, [{ intent: 'a', confidence: 0.7, original_message: 'msg' }]);
    enqueueIntents(queue, [{ intent: 'a', confidence: 0.9, original_message: 'msg2' }]);
    expect(queue.pending).toHaveLength(1);
    expect(queue.pending[0].confidence).toBe(0.9);
  });
});
