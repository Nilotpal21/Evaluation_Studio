/**
 * Trace Forwarder — Tracer Integration Tests
 *
 * Tests the tracer-based paths in createTraceForwarder:
 * - When tracer provided: events route through tracer.emit()
 * - When tracer NOT provided: fallback to legacy path
 * - Span management via spanMap
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTraceForwarder } from '../../services/execution/trace-forwarder.js';
import type { TraceStoreInterface, TraceEvent } from '../../services/trace-store.js';
import type { TraceEmitter } from '../../services/trace-emitter.js';
import type { Tracer, Span, SpanContext } from '@agent-platform/shared-observability/tracing';

vi.mock('@agent-platform/shared-observability/sti', () => ({
  tracePath: (_name: string, fn: Function) => fn,
}));

function createMockTraceStore(): TraceStoreInterface & {
  capturedEvents: TraceEvent[];
} {
  const capturedEvents: TraceEvent[] = [];
  return {
    capturedEvents,
    addEvent: vi.fn((_sessionId: string, event: TraceEvent) => {
      capturedEvents.push(event);
    }),
    readSince: vi.fn((_sessionId: string, afterEventId?: string) => ({
      events: [],
      totalBuffered: 0,
      afterEventId,
      snapshotRequired: false,
    })),
    subscribe: vi.fn(() => ({ success: true, eventCount: 0 })),
    unsubscribe: vi.fn(),
    unsubscribeAll: vi.fn(),
    getEvents: vi.fn(() => []),
    getActiveSessions: vi.fn(() => []),
    setSessionAgent: vi.fn(),
    removeSession: vi.fn(),
    stop: vi.fn(),
  };
}

function createMockSpan(spanId: string, parentSpanId?: string): Span {
  return {
    name: `span-${spanId}`,
    context: { traceId: 'trace-abc', spanId, parentSpanId } as SpanContext,
    attributes: {},
    setAttribute: vi.fn(),
    addEvent: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
  };
}

function createMockTracer(): {
  tracer: Tracer;
  emittedEvents: Array<{ type: string; data: Record<string, unknown> }>;
  startedSpans: Span[];
} {
  const emittedEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  const startedSpans: Span[] = [];
  let activeSpan: Span | null = null;

  const tracer: Tracer = {
    startSpan: vi.fn((name: string, _options?: Record<string, unknown>) => {
      const span = createMockSpan(`${name}-${Date.now()}`);
      startedSpans.push(span);
      activeSpan = span;
      return span;
    }),
    withSpan: vi.fn(),
    runSync: vi.fn(),
    run: vi.fn(),
    activeSpan: vi.fn(() => activeSpan),
    emit: vi.fn((event: { type: string; data: Record<string, unknown> }) => {
      emittedEvents.push(event);
    }),
    continueFrom: vi.fn(),
  };

  return { tracer, emittedEvents, startedSpans };
}

describe('Trace Forwarder — Tracer Integration', () => {
  const SESSION_ID = 'test-session-123';
  let store: ReturnType<typeof createMockTraceStore>;

  beforeEach(() => {
    store = createMockTraceStore();
    vi.clearAllMocks();
  });

  describe('with tracer — events route through tracer.emit()', () => {
    it('addEvent routes through tracer.emit()', () => {
      const { tracer, emittedEvents } = createMockTracer();
      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
        tracer,
      });

      forwarder.addEvent('custom_metric', { value: 42 });

      expect(tracer.emit).toHaveBeenCalledOnce();
      expect(emittedEvents[0]).toMatchObject({
        type: 'custom_metric',
        data: { value: 42, source: 'construct-layer' },
      });
      // Direct TraceStore write should be skipped
      expect(store.addEvent).not.toHaveBeenCalled();
    });

    it('logLLMCall routes through tracer.emit()', async () => {
      const { tracer, emittedEvents } = createMockTracer();
      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
        tracer,
      });

      await forwarder.logLLMCall({
        model: 'claude-3',
        messages: [{ role: 'user', content: 'hello' }],
        response: 'Hi',
        tokensIn: 10,
        tokensOut: 5,
        latencyMs: 200,
      });

      expect(tracer.emit).toHaveBeenCalledOnce();
      expect(emittedEvents[0]).toMatchObject({
        type: 'llm_call',
        data: expect.objectContaining({
          model: 'claude-3',
          source: 'construct-layer',
        }),
      });
      expect(store.addEvent).not.toHaveBeenCalled();
    });

    it('logToolCall routes through tracer.emit()', async () => {
      const { tracer, emittedEvents } = createMockTracer();
      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
        tracer,
      });

      await forwarder.logToolCall({
        toolName: 'search',
        input: { q: 'test' },
        output: { results: [] },
        success: true,
        latencyMs: 50,
        metadata: {
          workflow_version_id: 'wfv-2',
          workflow_version: 'v2.0.0',
        },
      });

      expect(tracer.emit).toHaveBeenCalledOnce();
      expect(emittedEvents[0]).toMatchObject({
        type: 'tool_call',
        data: expect.objectContaining({
          toolName: 'search',
          metadata: {
            workflow_version_id: 'wfv-2',
            workflow_version: 'v2.0.0',
          },
          source: 'construct-layer',
        }),
      });
    });

    it('logConstraintCheck routes through tracer.emit()', async () => {
      const { tracer, emittedEvents } = createMockTracer();
      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
        tracer,
      });

      await forwarder.logConstraintCheck('age >= 18', true, { age: 21 });

      expect(tracer.emit).toHaveBeenCalledOnce();
      expect(emittedEvents[0]).toMatchObject({
        type: 'constraint_check',
        data: expect.objectContaining({
          constraint: 'age >= 18',
          source: 'construct-layer',
        }),
      });
    });

    it('logHandoff routes through tracer.emit()', async () => {
      const { tracer, emittedEvents } = createMockTracer();
      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
        tracer,
      });

      await forwarder.logHandoff('billing', 'intent: billing', { id: '1' });

      expect(tracer.emit).toHaveBeenCalledOnce();
      expect(emittedEvents[0]).toMatchObject({
        type: 'handoff',
        data: expect.objectContaining({
          toAgent: 'billing',
          source: 'construct-layer',
        }),
      });
    });
  });

  describe('with tracer — span management via spanMap', () => {
    it('startSpan creates a tracer-managed span', () => {
      const { tracer, startedSpans } = createMockTracer();
      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
        tracer,
      });

      const span = forwarder.startSpan('constraint-eval');

      expect(tracer.startSpan).toHaveBeenCalledWith('constraint-eval', {
        attributes: { source: 'construct-layer' },
      });
      expect(span.spanId).toBe(startedSpans[0].context.spanId);
    });

    it('span.end() ends the tracer-managed span', () => {
      const { tracer, startedSpans } = createMockTracer();
      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
        tracer,
      });

      const span = forwarder.startSpan('test-span');
      span.end();

      expect(startedSpans[0].end).toHaveBeenCalledOnce();
      // Should NOT emit span_end to tracer (tracer handles it internally)
      expect(tracer.emit).not.toHaveBeenCalled();
      // Should NOT write directly to store
      expect(store.addEvent).not.toHaveBeenCalled();
    });

    it('getCurrentSpan returns tracer-managed span wrapper', () => {
      const { tracer } = createMockTracer();
      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
        tracer,
      });

      const span = forwarder.startSpan('active-span');
      const current = forwarder.getCurrentSpan();

      expect(current).toBeDefined();
      expect(current!.spanId).toBe(span.spanId);
    });

    it('getCurrentSpan returns undefined when no active span', () => {
      const { tracer } = createMockTracer();
      // Override activeSpan to return null
      (tracer.activeSpan as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
        tracer,
      });

      expect(forwarder.getCurrentSpan()).toBeUndefined();
    });
  });

  describe('without tracer — fallback to legacy path', () => {
    it('addEvent writes directly to TraceStore', () => {
      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
      });

      forwarder.addEvent('test_event', { key: 'value' });

      expect(store.addEvent).toHaveBeenCalledOnce();
      expect(store.capturedEvents[0].data).toMatchObject({
        key: 'value',
        source: 'construct-layer',
      });
    });

    it('startSpan uses closure-based tracking', () => {
      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
      });

      const span = forwarder.startSpan('legacy-span');
      expect(span.spanId).toBeDefined();
      expect(typeof span.end).toBe('function');

      span.end();
      expect(store.addEvent).toHaveBeenCalledOnce();
      expect(store.capturedEvents[0].type).toBe('span_end');
    });

    it('getCurrentSpan returns closure-based span', () => {
      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
      });

      const span = forwarder.startSpan('my-span');
      const current = forwarder.getCurrentSpan();

      expect(current).toBeDefined();
      expect(current!.spanId).toBe(span.spanId);
    });
  });

  describe('tracer takes precedence over traceEmitter', () => {
    it('when both tracer and traceEmitter provided, tracer wins', () => {
      const { tracer, emittedEvents } = createMockTracer();
      const mockEmitter = { emit: vi.fn() } as unknown as TraceEmitter;

      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
        traceEmitter: mockEmitter,
        tracer,
      });

      forwarder.addEvent('test', { key: 'val' });

      expect(tracer.emit).toHaveBeenCalledOnce();
      expect(mockEmitter.emit).not.toHaveBeenCalled();
      expect(store.addEvent).not.toHaveBeenCalled();
    });
  });
});
