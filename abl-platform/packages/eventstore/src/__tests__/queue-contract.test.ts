/**
 * Shared queue contract tests.
 * Runs against DirectQueue and MemoryEventQueue to verify behavioral equivalence.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { IEventQueue } from '../interfaces/event-queue.js';
import { DirectQueue } from '../queues/direct-queue.js';
import { MemoryEventQueue } from '../queues/memory-queue.js';

function runQueueContractTests(name: string, createQueue: () => IEventQueue) {
  describe(`IEventQueue contract: ${name}`, () => {
    let queue: IEventQueue;

    beforeEach(() => {
      queue = createQueue();
    });

    it('has a queue name', () => {
      expect(queue.queueName).toBeTruthy();
    });

    it('isHealthy returns true', () => {
      expect(queue.isHealthy()).toBe(true);
    });

    it('enqueue + onProcess delivers event to handler', async () => {
      const received: unknown[] = [];
      queue.onProcess((event) => {
        received.push(event);
      });

      queue.enqueue({ type: 'test', value: 1 });

      // For MemoryEventQueue, need to flush
      await queue.flush();

      expect(received.length).toBe(1);
      expect(received[0]).toEqual({ type: 'test', value: 1 });
    });

    it('enqueueBatch delivers all events', async () => {
      const received: unknown[] = [];
      queue.onProcess((event) => {
        received.push(event);
      });

      queue.enqueueBatch([{ id: 1 }, { id: 2 }, { id: 3 }]);

      await queue.flush();

      expect(received.length).toBe(3);
    });

    it('throws if no handler registered on enqueue', () => {
      // DirectQueue throws if no handler, MemoryEventQueue just enqueues
      if (name === 'DirectQueue') {
        expect(() => queue.enqueue({ test: true })).toThrow();
      }
    });

    it('throws on duplicate handler registration', () => {
      queue.onProcess(() => {});
      expect(() => queue.onProcess(() => {})).toThrow();
    });

    it('close() cleans up', async () => {
      queue.onProcess(() => {});
      await queue.close();
      // Should not throw
    });

    it('preserves event ordering', async () => {
      const received: number[] = [];
      queue.onProcess((event) => {
        received.push((event as { id: number }).id);
      });

      for (let i = 0; i < 10; i++) {
        queue.enqueue({ id: i });
      }

      await queue.flush();

      // Events should be processed in order
      expect(received).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });
  });
}

// Run against DirectQueue
runQueueContractTests('DirectQueue', () => new DirectQueue());

// Run against MemoryEventQueue
runQueueContractTests('MemoryEventQueue', () => new MemoryEventQueue());

// ─── MemoryEventQueue-specific tests ──────────────────────────────────────────

describe('MemoryEventQueue specific', () => {
  it('pendingCount tracks queue size', () => {
    const queue = new MemoryEventQueue();
    queue.onProcess(() => {});

    expect(queue.pendingCount).toBe(0);
    queue.enqueue({ id: 1 });
    queue.enqueue({ id: 2 });
    expect(queue.pendingCount).toBe(2);
  });

  it('peekQueue returns queued events without processing', () => {
    const queue = new MemoryEventQueue();
    queue.onProcess(() => {});
    queue.enqueue({ id: 1 });
    queue.enqueue({ id: 2 });

    const peeked = queue.peekQueue();
    expect(peeked).toEqual([{ id: 1 }, { id: 2 }]);
    expect(queue.pendingCount).toBe(2); // Not consumed
  });

  it('clear removes all events without processing', () => {
    const queue = new MemoryEventQueue();
    queue.onProcess(() => {});
    queue.enqueue({ id: 1 });
    queue.enqueue({ id: 2 });

    queue.clear();
    expect(queue.pendingCount).toBe(0);
  });

  it('overflow throws error', () => {
    const queue = new MemoryEventQueue({ maxSize: 2 });
    queue.onProcess(() => {});
    queue.enqueue({ id: 1 });
    queue.enqueue({ id: 2 });
    expect(() => queue.enqueue({ id: 3 })).toThrow('overflow');
  });
});
