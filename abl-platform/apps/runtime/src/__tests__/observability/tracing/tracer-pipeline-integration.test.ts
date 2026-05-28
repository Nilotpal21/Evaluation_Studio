/**
 * Tracer → WritePipeline → EventStore Integration Tests
 *
 * Tests the full pipeline without mocking intermediate layers:
 * - TracerImpl with real WritePipelineImpl (mocked sinks)
 * - tracer.withSpan() → tracer.emit() → verify event reaches all sinks
 * - Verify traceId, spanId, parentSpanId correct in output
 * - Verify span_end event written on span.end()
 * - Nested spans: verify parent-child relationships
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { TracerImpl } from '../../../services/tracing/tracer.js';
import { WritePipelineImpl } from '../../../services/tracing/write-pipeline.js';
import {
  RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE,
  RUNTIME_TRACE_TYPE_DATA_KEY,
} from '../../../services/trace-event-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSinks() {
  const traceStoreCalls: { sessionId: string; event: unknown }[] = [];
  const broadcastCalls: { sessionId: string; message: unknown }[] = [];
  const eventStoreCalls: unknown[] = [];

  const traceStore = {
    addEvent: vi.fn((sessionId: string, event: unknown) => {
      traceStoreCalls.push({ sessionId, event });
    }),
  };

  const eventStoreEmitter = {
    emit: vi.fn((event: unknown) => {
      eventStoreCalls.push(event);
    }),
  };

  return {
    config: {
      getTraceStore: () => traceStore,
      getEventStore: () => ({ emitter: eventStoreEmitter }),
      broadcastToSession: vi.fn((sessionId: string, message: unknown) => {
        broadcastCalls.push({ sessionId, message });
      }),
    },
    traceStoreCalls,
    broadcastCalls,
    eventStoreCalls,
    traceStore,
    eventStoreEmitter,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tracer → WritePipeline → Sinks integration', () => {
  let sinks: ReturnType<typeof createMockSinks>;
  let pipeline: WritePipelineImpl;
  let tracer: TracerImpl;

  beforeEach(() => {
    sinks = createMockSinks();
    pipeline = new WritePipelineImpl(sinks.config);
    tracer = new TracerImpl({
      sessionId: 'sess-integration-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      writePipeline: pipeline,
    });
  });

  it('tracer.withSpan() emits span_end event to TraceStore and WS', async () => {
    await tracer.withSpan('test-operation', () => {
      // No-op — just verify span lifecycle
    });

    // span_end should reach TraceStore
    const spanEndInStore = sinks.traceStoreCalls.find(
      (c) => (c.event as Record<string, unknown>).type === 'span_end',
    );
    expect(spanEndInStore).toBeDefined();

    // span_end should be broadcast via WS
    const spanEndBroadcast = sinks.broadcastCalls.find(
      (c) =>
        ((c.message as Record<string, unknown>).event as Record<string, unknown>)?.type ===
        'span_end',
    );
    expect(spanEndBroadcast).toBeDefined();

    const spanEndInEventStore = sinks.eventStoreCalls.find(
      (event) =>
        (event as Record<string, unknown>).event_type === RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE,
    );
    expect(spanEndInEventStore).toEqual(
      expect.objectContaining({
        event_type: RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE,
        category: 'system',
        data: expect.objectContaining({
          [RUNTIME_TRACE_TYPE_DATA_KEY]: 'span_end',
        }),
      }),
    );
  });

  it('tracer.emit() inside withSpan() uses correct span context', async () => {
    let capturedTraceId: string | undefined;
    let capturedSpanId: string | undefined;

    await tracer.withSpan('parent-op', () => {
      const span = tracer.activeSpan()!;
      capturedTraceId = span.context.traceId;
      capturedSpanId = span.context.spanId;

      tracer.emit({ type: 'custom_event', data: { key: 'value' } });
    });

    // Find the custom_event in TraceStore
    const customEvent = sinks.traceStoreCalls.find(
      (c) => (c.event as Record<string, unknown>).type === 'custom_event',
    );
    expect(customEvent).toBeDefined();

    const event = customEvent!.event as Record<string, unknown>;
    expect(event.traceId).toBe(capturedTraceId);
    expect(event.spanId).toBe(capturedSpanId);
    expect(event.sessionId).toBe('sess-integration-1');
    expect(event.tenantId).toBe('tenant-1');
    expect(event.projectId).toBe('project-1');
  });

  it('span_end event contains correct traceId, spanId, parentSpanId', async () => {
    await tracer.withSpan('measured-op', () => {
      // work
    });

    const spanEnd = sinks.traceStoreCalls.find(
      (c) => (c.event as Record<string, unknown>).type === 'span_end',
    );
    expect(spanEnd).toBeDefined();

    const event = spanEnd!.event as Record<string, unknown>;
    expect(event.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(event.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(event.parentSpanId).toBeUndefined(); // Root span has no parent
    expect(event.sessionId).toBe('sess-integration-1');
  });

  it('nested spans produce correct parent-child relationships', async () => {
    let outerTraceId: string | undefined;
    let outerSpanId: string | undefined;
    let innerTraceId: string | undefined;
    let innerSpanId: string | undefined;
    let innerParentSpanId: string | undefined;

    await tracer.withSpan('outer', async () => {
      const outerSpan = tracer.activeSpan()!;
      outerTraceId = outerSpan.context.traceId;
      outerSpanId = outerSpan.context.spanId;

      await tracer.withSpan('inner', () => {
        const innerSpan = tracer.activeSpan()!;
        innerTraceId = innerSpan.context.traceId;
        innerSpanId = innerSpan.context.spanId;
        innerParentSpanId = innerSpan.context.parentSpanId;
      });
    });

    // Same trace
    expect(innerTraceId).toBe(outerTraceId);
    // Inner's parent is outer
    expect(innerParentSpanId).toBe(outerSpanId);
    // Different span IDs
    expect(innerSpanId).not.toBe(outerSpanId);

    // Verify span_end events contain correct hierarchy
    const spanEnds = sinks.traceStoreCalls.filter(
      (c) => (c.event as Record<string, unknown>).type === 'span_end',
    );
    expect(spanEnds).toHaveLength(2);

    // Inner span_end should have parentSpanId
    const innerEnd = spanEnds.find(
      (c) => (c.event as Record<string, unknown>).spanId === innerSpanId,
    );
    expect(innerEnd).toBeDefined();
    expect((innerEnd!.event as Record<string, unknown>).parentSpanId).toBe(outerSpanId);

    // Outer span_end should not have parentSpanId
    const outerEnd = spanEnds.find(
      (c) => (c.event as Record<string, unknown>).spanId === outerSpanId,
    );
    expect(outerEnd).toBeDefined();
    expect((outerEnd!.event as Record<string, unknown>).parentSpanId).toBeUndefined();
  });

  it('span.end() writes span_end with durationMs', async () => {
    const span = tracer.startSpan('manual-span');

    // Simulate some work
    span.setAttribute('op', 'test');
    span.setStatus('ok');
    span.end();

    const spanEnd = sinks.traceStoreCalls.find(
      (c) => (c.event as Record<string, unknown>).type === 'span_end',
    );
    expect(spanEnd).toBeDefined();

    const event = spanEnd!.event as Record<string, unknown>;
    expect(typeof event.durationMs).toBe('number');
    expect((event.data as Record<string, unknown>).spanName).toBe('manual-span');
    expect(
      ((event.data as Record<string, unknown>).attributes as Record<string, string>)['span.status'],
    ).toBe('ok');
  });

  it('withSpan sets error status on failure and still writes span_end', async () => {
    await expect(
      tracer.withSpan('failing-op', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const spanEnd = sinks.traceStoreCalls.find(
      (c) => (c.event as Record<string, unknown>).type === 'span_end',
    );
    expect(spanEnd).toBeDefined();

    const attrs = ((spanEnd!.event as Record<string, unknown>).data as Record<string, unknown>)
      .attributes as Record<string, string>;
    expect(attrs['span.status']).toBe('error');
    expect(attrs['span.status_message']).toBe('boom');
  });

  it('events emitted without active span use fallback traceId', () => {
    tracer.emit({ type: 'orphan_event', data: { orphan: true } });

    const orphan = sinks.traceStoreCalls.find(
      (c) => (c.event as Record<string, unknown>).type === 'orphan_event',
    );
    expect(orphan).toBeDefined();

    const event = orphan!.event as Record<string, unknown>;
    expect(event.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(event.spanId).toBeUndefined();
  });
});
