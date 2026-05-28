/**
 * Trace Forwarder — Unit Tests
 *
 * Verifies that createTraceForwarder correctly translates each
 * TraceContextManager method into a TraceEvent forwarded to the runtime TraceStore,
 * and that events flow through the trace-emitter unified pipeline when provided.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTraceForwarder } from '../../services/execution/trace-forwarder.js';
import type { TraceStoreInterface, TraceEvent } from '../../services/trace-store.js';
import type { TraceEmitter } from '../../services/trace-emitter.js';

function createMockTraceStore(): TraceStoreInterface & {
  capturedEvents: TraceEvent[];
} {
  const capturedEvents: TraceEvent[] = [];
  return {
    capturedEvents,
    addEvent: vi.fn((sessionId: string, event: TraceEvent) => {
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

function createMockTraceEmitter(): {
  emitter: Pick<TraceEmitter, 'emit'>;
  emittedEvents: Array<{ type: string; data: Record<string, unknown> }>;
} {
  const emittedEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  return {
    emittedEvents,
    emitter: {
      emit: vi.fn((event: { type: string; data: Record<string, unknown> }) => {
        emittedEvents.push({ type: event.type, data: event.data });
        return undefined;
      }),
    } as unknown as Pick<TraceEmitter, 'emit'>,
  };
}

describe('createTraceForwarder', () => {
  const SESSION_ID = 'test-session-123';
  let store: ReturnType<typeof createMockTraceStore>;

  beforeEach(() => {
    store = createMockTraceStore();
  });

  it('forwards logConstraintCheck with source: construct-layer', async () => {
    const forwarder = createTraceForwarder(SESSION_ID, store);

    await forwarder.logConstraintCheck('age >= 18', true, { age: 21 });

    expect(store.addEvent).toHaveBeenCalledOnce();
    const event = store.capturedEvents[0];
    expect(event.sessionId).toBe(SESSION_ID);
    expect(event.type).toBe('constraint_check');
    expect(event.data).toMatchObject({
      constraint: 'age >= 18',
      passed: true,
      context: { age: 21 },
      source: 'construct-layer',
    });
  });

  it('forwards logHandoff with source: construct-layer', async () => {
    const forwarder = createTraceForwarder(SESSION_ID, store);

    await forwarder.logHandoff('billing-agent', 'User intent: billing', {
      transferId: 'tx-1',
    });

    expect(store.addEvent).toHaveBeenCalledOnce();
    const event = store.capturedEvents[0];
    expect(event.sessionId).toBe(SESSION_ID);
    expect(event.type).toBe('handoff');
    expect(event.data).toMatchObject({
      toAgent: 'billing-agent',
      reason: 'User intent: billing',
      context: { transferId: 'tx-1' },
      source: 'construct-layer',
    });
  });

  it('startSpan returns a span with end() that emits span_end event', () => {
    const forwarder = createTraceForwarder(SESSION_ID, store);

    const span = forwarder.startSpan('constraint-evaluation');
    expect(span).toBeDefined();
    expect(span.spanId).toBeDefined();
    expect(typeof span.end).toBe('function');

    // end the span
    span.end();

    expect(store.addEvent).toHaveBeenCalledOnce();
    const event = store.capturedEvents[0];
    expect(event.type).toBe('span_end');
    expect(event.data).toMatchObject({
      spanName: 'constraint-evaluation',
      source: 'construct-layer',
    });
    expect(typeof event.data.durationMs).toBe('number');
  });

  it('addEvent forwards generic events with source: construct-layer', () => {
    const forwarder = createTraceForwarder(SESSION_ID, store);

    forwarder.addEvent('custom_metric', { value: 42, label: 'latency' });

    expect(store.addEvent).toHaveBeenCalledOnce();
    const event = store.capturedEvents[0];
    expect(event.sessionId).toBe(SESSION_ID);
    expect(event.type).toBe('custom_metric');
    expect(event.data).toMatchObject({
      value: 42,
      label: 'latency',
      source: 'construct-layer',
    });
  });

  it('forwards workflow metadata on tool calls written directly to TraceStore', async () => {
    const forwarder = createTraceForwarder(SESSION_ID, store);

    await forwarder.logToolCall({
      toolName: 'workflow_tool',
      input: { orderId: '123' },
      output: { status: 'ok' },
      success: true,
      latencyMs: 50,
      metadata: {
        workflow_id: 'wf-1',
        workflow_version_id: 'wfv-2',
        workflow_version: 'v2.0.0',
      },
    });

    expect(store.addEvent).toHaveBeenCalledOnce();
    const event = store.capturedEvents[0];
    expect(event.type).toBe('tool_call');
    expect(event.data).toMatchObject({
      toolName: 'workflow_tool',
      metadata: {
        workflow_id: 'wf-1',
        workflow_version_id: 'wfv-2',
        workflow_version: 'v2.0.0',
      },
      source: 'construct-layer',
    });
  });

  // ─── TraceEmitter wiring tests ───────────────────────────────────────────────

  describe('with traceEmitter', () => {
    it('addEvent routes through traceEmitter.emit() instead of direct TraceStore write', () => {
      const { emitter, emittedEvents } = createMockTraceEmitter();
      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
        traceEmitter: emitter as unknown as TraceEmitter,
      });

      forwarder.addEvent('custom_metric', { value: 42, label: 'latency' });

      // TraceEmitter receives the event
      expect(emitter.emit).toHaveBeenCalledOnce();
      expect(emittedEvents[0]).toMatchObject({
        type: 'custom_metric',
        data: {
          value: 42,
          label: 'latency',
          source: 'construct-layer',
        },
      });

      // Direct TraceStore write is skipped (emitter handles it)
      expect(store.addEvent).not.toHaveBeenCalled();
    });

    it('logLLMCall routes through traceEmitter.emit()', async () => {
      const { emitter, emittedEvents } = createMockTraceEmitter();
      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
        traceEmitter: emitter as unknown as TraceEmitter,
      });

      await forwarder.logLLMCall({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        response: 'Hi there',
        tokensIn: 10,
        tokensOut: 5,
        latencyMs: 200,
      });

      expect(emitter.emit).toHaveBeenCalledOnce();
      expect(emittedEvents[0]).toMatchObject({
        type: 'llm_call',
        data: {
          model: 'gpt-4',
          messagesIn: 1,
          tokensIn: 10,
          tokensOut: 5,
          latencyMs: 200,
          source: 'construct-layer',
        },
      });
      expect(store.addEvent).not.toHaveBeenCalled();
    });

    it('logToolCall routes through traceEmitter.emit()', async () => {
      const { emitter, emittedEvents } = createMockTraceEmitter();
      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
        traceEmitter: emitter as unknown as TraceEmitter,
      });

      await forwarder.logToolCall({
        toolName: 'search',
        input: { query: 'test' },
        output: { results: [] },
        success: true,
        latencyMs: 50,
        metadata: {
          workflow_version_id: 'wfv-2',
          workflow_version: 'v2.0.0',
        },
      });

      expect(emitter.emit).toHaveBeenCalledOnce();
      expect(emittedEvents[0]).toMatchObject({
        type: 'tool_call',
        data: {
          toolName: 'search',
          success: true,
          metadata: {
            workflow_version_id: 'wfv-2',
            workflow_version: 'v2.0.0',
          },
          source: 'construct-layer',
        },
      });
      expect(store.addEvent).not.toHaveBeenCalled();
    });

    it('logConstraintCheck routes through traceEmitter.emit()', async () => {
      const { emitter, emittedEvents } = createMockTraceEmitter();
      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
        traceEmitter: emitter as unknown as TraceEmitter,
      });

      await forwarder.logConstraintCheck('age >= 18', true, { age: 21 });

      expect(emitter.emit).toHaveBeenCalledOnce();
      expect(emittedEvents[0]).toMatchObject({
        type: 'constraint_check',
        data: {
          constraint: 'age >= 18',
          passed: true,
          source: 'construct-layer',
        },
      });
      expect(store.addEvent).not.toHaveBeenCalled();
    });

    it('logHandoff routes through traceEmitter.emit()', async () => {
      const { emitter, emittedEvents } = createMockTraceEmitter();
      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
        traceEmitter: emitter as unknown as TraceEmitter,
      });

      await forwarder.logHandoff('billing-agent', 'billing request', { id: '1' });

      expect(emitter.emit).toHaveBeenCalledOnce();
      expect(emittedEvents[0]).toMatchObject({
        type: 'handoff',
        data: {
          toAgent: 'billing-agent',
          reason: 'billing request',
          source: 'construct-layer',
        },
      });
      expect(store.addEvent).not.toHaveBeenCalled();
    });

    it('startSpan end() routes through traceEmitter.emit()', () => {
      const { emitter, emittedEvents } = createMockTraceEmitter();
      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
        traceEmitter: emitter as unknown as TraceEmitter,
      });

      const span = forwarder.startSpan('test-span');
      span.end();

      expect(emitter.emit).toHaveBeenCalledOnce();
      expect(emittedEvents[0]).toMatchObject({
        type: 'span_end',
        data: {
          spanName: 'test-span',
          source: 'construct-layer',
        },
      });
      expect(store.addEvent).not.toHaveBeenCalled();
    });
  });

  // ─── Options object signature ────────────────────────────────────────────────

  describe('options object signature', () => {
    it('works with options object (no traceEmitter) — falls back to direct TraceStore', () => {
      const forwarder = createTraceForwarder({
        sessionId: SESSION_ID,
        traceStore: store,
      });

      forwarder.addEvent('test_event', { key: 'value' });

      expect(store.addEvent).toHaveBeenCalledOnce();
      const event = store.capturedEvents[0];
      expect(event.type).toBe('test_event');
      expect(event.data).toMatchObject({
        key: 'value',
        source: 'construct-layer',
      });
    });
  });
});
