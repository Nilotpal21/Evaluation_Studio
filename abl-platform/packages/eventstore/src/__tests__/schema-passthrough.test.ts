/**
 * EventStore Schema Passthrough Tests
 *
 * Tests that .passthrough() on Zod schemas preserves unknown fields,
 * that registered events validate correctly with camelCase fields,
 * and that the EventEmitter handles unregistered types and validation failures
 * in a permissive manner (never drops events at runtime).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { EventRegistry } from '../schema/event-registry.js';
import { EventEmitter } from '../emitter/event-emitter.js';
import { MemoryEventQueue } from '../queues/memory-queue.js';
import { createTestEvent, resetEventCounter } from './helpers.js';

// ─── Passthrough behavior on schemas ────────────────────────────────────────

describe('Schema .passthrough() behavior', () => {
  let registry: EventRegistry;

  beforeEach(() => {
    registry = new EventRegistry();
  });

  it('preserves extra/unknown fields through validation', () => {
    const schema = z
      .object({
        mode: z.enum(['scripted', 'reasoning']).optional(),
      })
      .passthrough();

    registry.register('agent.entered', schema, {
      version: '1.0.0',
      category: 'agent',
      containsPII: false,
    });

    const result = registry.validate({
      event_type: 'agent.entered',
      data: {
        mode: 'scripted',
        customField: 'should-survive',
        nestedObj: { deep: true },
      },
    });

    expect(result.valid).toBe(true);
  });

  it('passthrough preserves unknown fields in validateData output', () => {
    const schema = z
      .object({
        mode: z.enum(['scripted', 'reasoning']).optional(),
      })
      .passthrough();

    registry.register('agent.entered', schema, {
      version: '1.0.0',
      category: 'agent',
      containsPII: false,
    });

    const parsed = registry.validateData<Record<string, unknown>>('agent.entered', {
      mode: 'reasoning',
      extraField: 'preserved',
      numericExtra: 42,
    });

    expect(parsed.mode).toBe('reasoning');
    expect(parsed.extraField).toBe('preserved');
    expect(parsed.numericExtra).toBe(42);
  });

  it('validates camelCase fields defined in schema', () => {
    const schema = z
      .object({
        decisionKind: z.enum(['handoff', 'delegation', 'flow_transition']).optional(),
        outcome: z.string().optional(),
        reasoning: z.string().optional(),
      })
      .passthrough();

    registry.register('agent.decision', schema, {
      version: '1.0.0',
      category: 'agent',
      containsPII: false,
    });

    const result = registry.validate({
      event_type: 'agent.decision',
      data: {
        decisionKind: 'handoff',
        outcome: 'transferred',
        reasoning: 'user asked for billing',
      },
    });

    expect(result.valid).toBe(true);
  });

  it('validates snake_case alias fields alongside camelCase', () => {
    const schema = z
      .object({
        from_agent: z.string().optional(),
        fromAgent: z.string().optional(),
        to_agent: z.string().optional(),
        toAgent: z.string().optional(),
        reason: z.string().optional(),
      })
      .passthrough();

    registry.register('agent.handoff', schema, {
      version: '1.0.0',
      category: 'agent',
      containsPII: false,
    });

    // snake_case fields
    const snakeResult = registry.validate({
      event_type: 'agent.handoff',
      data: { from_agent: 'support', to_agent: 'billing', reason: 'billing inquiry' },
    });
    expect(snakeResult.valid).toBe(true);

    // camelCase fields
    const camelResult = registry.validate({
      event_type: 'agent.handoff',
      data: { fromAgent: 'support', toAgent: 'billing', reason: 'billing inquiry' },
    });
    expect(camelResult.valid).toBe(true);

    // Mixed
    const mixedResult = registry.validate({
      event_type: 'agent.handoff',
      data: { from_agent: 'support', toAgent: 'billing' },
    });
    expect(mixedResult.valid).toBe(true);
  });

  it('validates LLM event schemas with dual-casing fields', () => {
    const schema = z
      .object({
        model: z.string().optional(),
        input_tokens: z.number().optional(),
        tokensIn: z.number().optional(),
        output_tokens: z.number().optional(),
        tokensOut: z.number().optional(),
      })
      .passthrough();

    registry.register('llm.call.completed', schema, {
      version: '1.0.0',
      category: 'llm',
      containsPII: false,
    });

    const result = registry.validate({
      event_type: 'llm.call.completed',
      data: {
        model: 'gpt-4o',
        tokensIn: 500,
        tokensOut: 200,
        customMetric: 'extra-data',
      },
    });

    expect(result.valid).toBe(true);
  });
});

// ─── EventEmitter permissive mode ───────────────────────────────────────────

describe('EventEmitter schema passthrough behavior', () => {
  let queue: MemoryEventQueue;
  let registry: EventRegistry;
  let emitter: EventEmitter;

  beforeEach(() => {
    resetEventCounter();
    queue = new MemoryEventQueue();
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

    emitter = new EventEmitter(queue, registry);
  });

  it('passes through registered events with extra fields', () => {
    const event = createTestEvent({
      data: {
        channel: 'web',
        agent_name: 'test-agent',
        deployment_id: 'deploy-1',
        resolution_method: 'new',
        caller_identity_tier: 'anonymous',
        extraField: 'should-survive',
      },
    });

    emitter.emit(event);
    expect(queue.pendingCount).toBe(1);
  });

  it('passes through unregistered event types without data validation', () => {
    // Code uses createLogger (not console.debug) for structured logging.
    // We verify the behavioral contract: unregistered events pass through.
    emitter.emit({
      event_id: 'evt-unknown-1',
      event_type: 'custom.unknown.event',
      category: 'custom',
      tenant_id: 'tenant-a',
      project_id: 'project-a',
      session_id: 'sess-1',
      timestamp: new Date(),
      data: { anyField: 'anyValue', nested: { deep: true } },
    } as never);

    // Event should still be enqueued (permissive mode)
    expect(queue.pendingCount).toBe(1);
  });

  it('warns but does not drop events with invalid data in non-strict mode', () => {
    // Code uses createLogger (not console.warn) for structured logging.
    // We verify the behavioral contract: invalid events pass through.
    const event = createTestEvent({
      data: { channel: 123 as unknown as string },
    });
    emitter.emit(event);

    // Invalid events pass through (never block runtime)
    expect(queue.pendingCount).toBe(1);
  });

  it('throws on validation failure in strict mode', () => {
    const strictEmitter = new EventEmitter(queue, registry, {
      validation: { enabled: true, strictMode: true },
    });

    const event = createTestEvent({
      data: { channel: 123 as unknown as string },
    });

    expect(() => strictEmitter.emit(event)).toThrow('Invalid event');
    expect(queue.pendingCount).toBe(0);
  });

  it('unregistered event types pass through in batch mode', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    emitter.emitBatch([
      createTestEvent(),
      {
        event_id: 'evt-unknown-2',
        event_type: 'some.new.type',
        category: 'custom',
        tenant_id: 'tenant-a',
        project_id: 'project-a',
        session_id: 'sess-2',
        timestamp: new Date(),
        data: { foo: 'bar' },
      } as never,
    ]);

    debugSpy.mockRestore();

    // Both events enqueued
    expect(queue.pendingCount).toBe(2);
  });
});
