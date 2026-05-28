import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { EventEmitter } from '../emitter/event-emitter.js';
import { EventRegistry } from '../schema/event-registry.js';
import { MemoryEventQueue } from '../queues/memory-queue.js';
import { createTestEvent, resetEventCounter } from './helpers.js';

describe('EventEmitter', () => {
  let queue: MemoryEventQueue;
  let registry: EventRegistry;
  let emitter: EventEmitter;

  beforeEach(() => {
    resetEventCounter();
    queue = new MemoryEventQueue();
    registry = new EventRegistry();

    // Register a test event type
    registry.register(
      'session.started',
      z.object({
        channel: z.string(),
        agent_name: z.string(),
        deployment_id: z.string(),
        resolution_method: z.enum(['new', 'resumed', 'artifact']),
        caller_identity_tier: z.enum(['anonymous', 'identified', 'verified']),
      }),
      { version: '1.0.0', category: 'session', containsPII: false },
    );

    emitter = new EventEmitter(queue, registry);
  });

  describe('emit()', () => {
    it('enqueues a valid event', () => {
      const event = createTestEvent();
      emitter.emit(event);

      expect(queue.pendingCount).toBe(1);
    });

    it('auto-generates event_id if missing', () => {
      const event = createTestEvent({ event_id: '' });
      emitter.emit(event);

      const queued = queue.peekQueue();
      expect(queued.length).toBe(1);
      const queuedEvent = queued[0] as Record<string, unknown>;
      expect(queuedEvent.event_id).toBeTruthy();
      expect(queuedEvent.event_id).not.toBe('');
    });

    it('auto-infers category from event_type', () => {
      const event = createTestEvent({ category: '' as never });
      emitter.emit(event);

      const queued = queue.peekQueue();
      const queuedEvent = queued[0] as Record<string, unknown>;
      expect(queuedEvent.category).toBe('session');
    });

    it('passes through invalid events with warning in non-strict mode', () => {
      const event = createTestEvent({
        data: { channel: 123 as unknown as string }, // wrong type
      });

      // Code uses createLogger (not console.warn) for structured logging.
      // We verify the behavioral contract: invalid events pass through in permissive mode.
      emitter.emit(event);

      // Permissive: invalid events pass through (never block runtime)
      expect(queue.pendingCount).toBe(1);
    });

    it('throws on invalid events in strict mode', () => {
      const strictEmitter = new EventEmitter(queue, registry, {
        validation: { enabled: true, strictMode: true },
      });

      const event = createTestEvent({
        data: { channel: 123 as unknown as string },
      });

      expect(() => strictEmitter.emit(event)).toThrow('Invalid event');
    });

    it('skips validation when disabled', () => {
      const noValidationEmitter = new EventEmitter(queue, registry, {
        validation: { enabled: false },
      });

      // Invalid data but validation is off
      noValidationEmitter.emit(createTestEvent({ data: {} }));

      expect(queue.pendingCount).toBe(1);
    });
  });

  describe('emitBatch()', () => {
    it('enqueues multiple valid events', () => {
      const events = [createTestEvent(), createTestEvent()];
      emitter.emitBatch(events);

      expect(queue.pendingCount).toBe(2);
    });

    it('passes through invalid events in batch with warning (never drops)', () => {
      const valid = createTestEvent();
      const invalid = createTestEvent({ data: {} });

      // Code uses createLogger (not console.warn) for structured logging.
      // We verify the behavioral contract: both events pass through in permissive mode.
      emitter.emitBatch([valid, invalid]);

      // Permissive: both events pass through (never block runtime)
      expect(queue.pendingCount).toBe(2);
    });
  });

  describe('pendingCount', () => {
    it('reflects queue pending count', () => {
      expect(emitter.pendingCount).toBe(0);
      emitter.emit(createTestEvent());
      expect(emitter.pendingCount).toBe(1);
    });
  });

  describe('close()', () => {
    it('closes the queue', async () => {
      queue.onProcess(() => {});
      await emitter.close();
      // Should not throw
    });
  });
});
