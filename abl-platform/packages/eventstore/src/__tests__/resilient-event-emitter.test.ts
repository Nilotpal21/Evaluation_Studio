import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { ResilientEventEmitter } from '../emitter/resilient-event-emitter.js';
import { MemoryEventQueue } from '../queues/memory-queue.js';
import { FileSystemWAL } from '../resilience/filesystem-wal.js';
import { EventRegistry } from '../schema/event-registry.js';
import { createTestEvent, resetEventCounter } from './helpers.js';

describe('ResilientEventEmitter', () => {
  let primaryQueue: MemoryEventQueue;
  let fallbackQueue: MemoryEventQueue;
  let registry: EventRegistry;
  let walDir: string;
  let emitter: ResilientEventEmitter;

  beforeEach(() => {
    resetEventCounter();
    primaryQueue = new MemoryEventQueue();
    fallbackQueue = new MemoryEventQueue();
    registry = new EventRegistry();
    registry.register(
      'session.started',
      z
        .object({
          channel: z.string(),
          agent_name: z.string(),
          deployment_id: z.string(),
          resolution_method: z.enum(['new', 'resumed', 'artifact']),
          caller_identity_tier: z.enum(['anonymous', 'identified', 'verified']),
        })
        .passthrough(),
      { version: '1.0.0', category: 'session', containsPII: false },
    );
    walDir = mkdtempSync(join(tmpdir(), 'resilient-event-emitter-'));
    emitter = new ResilientEventEmitter(
      primaryQueue,
      fallbackQueue,
      new FileSystemWAL({ directory: walDir }),
      registry,
    );
  });

  afterEach(async () => {
    await emitter.close();
    rmSync(walDir, { recursive: true, force: true });
  });

  it('auto-generates event_id when missing', () => {
    emitter.emit(createTestEvent({ event_id: '' }));

    const queuedEvent = primaryQueue.peekQueue()[0] as Record<string, unknown>;
    expect(queuedEvent.event_id).toBeTruthy();
    expect(queuedEvent.event_id).not.toBe('');
  });

  it('auto-infers category when missing', () => {
    emitter.emit(createTestEvent({ category: '' as never }));

    const queuedEvent = primaryQueue.peekQueue()[0] as Record<string, unknown>;
    expect(queuedEvent.category).toBe('session');
  });

  it('passes unregistered event types through the primary queue', () => {
    emitter.emit(
      createTestEvent({
        event_type: 'system.runtime_trace',
        category: 'system',
        data: {
          _runtime_trace_type: 'dsl_prompt',
          rendered: 'Let me verify your identity to get started.',
        },
      }),
    );

    const queuedEvent = primaryQueue.peekQueue()[0] as Record<string, unknown>;
    expect(queuedEvent.event_type).toBe('system.runtime_trace');
    expect(queuedEvent.category).toBe('system');
    expect(queuedEvent.data).toMatchObject({
      _runtime_trace_type: 'dsl_prompt',
      rendered: 'Let me verify your identity to get started.',
    });
  });
});
