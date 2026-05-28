import { describe, it, expect } from 'vitest';
import { createIntentQueue, enqueueIntents } from '../services/execution/intent-queue.js';

describe('max_intents enforcement in intent queue', () => {
  it('should truncate queue to maxSize after enqueue', () => {
    const queue = createIntentQueue();
    const intents = Array.from({ length: 5 }, (_, i) => ({
      intent: `intent_${i}`,
      confidence: 0.9 - i * 0.1,
      original_message: 'test',
    }));
    enqueueIntents(queue, intents, 3);
    expect(queue.pending).toHaveLength(3);
    // Highest confidence retained
    expect(queue.pending[0].intent).toBe('intent_0');
    expect(queue.pending[1].intent).toBe('intent_1');
    expect(queue.pending[2].intent).toBe('intent_2');
  });

  it('should keep all intents when maxSize is undefined', () => {
    const queue = createIntentQueue();
    const intents = Array.from({ length: 5 }, (_, i) => ({
      intent: `intent_${i}`,
      confidence: 0.9 - i * 0.1,
      original_message: 'test',
    }));
    enqueueIntents(queue, intents);
    expect(queue.pending).toHaveLength(5);
  });

  it('should not truncate when queue size is within limit', () => {
    const queue = createIntentQueue();
    enqueueIntents(
      queue,
      [
        { intent: 'a', confidence: 0.9, original_message: 'test' },
        { intent: 'b', confidence: 0.8, original_message: 'test' },
      ],
      5,
    );
    expect(queue.pending).toHaveLength(2);
  });

  it('should retain merged duplicates within maxSize', () => {
    const queue = createIntentQueue();
    enqueueIntents(queue, [
      { intent: 'a', confidence: 0.5, original_message: 'test1' },
      { intent: 'b', confidence: 0.7, original_message: 'test1' },
      { intent: 'c', confidence: 0.9, original_message: 'test1' },
    ]);
    // Now add a duplicate that merges + new ones exceeding max
    enqueueIntents(
      queue,
      [
        { intent: 'a', confidence: 0.95, original_message: 'test2' }, // merges, becomes highest
        { intent: 'd', confidence: 0.6, original_message: 'test2' },
      ],
      3,
    );
    expect(queue.pending).toHaveLength(3);
    expect(queue.pending[0].intent).toBe('a'); // 0.95 now highest
  });
});
