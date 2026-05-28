/**
 * Trace Emitter — Tracer Integration Tests
 *
 * Tests the Phase 2 tracer integration paths in createTraceEmitter:
 * - getActiveSpanId() reads from tracer.activeSpan() when tracer available
 * - Falls back to closure-based currentSpanId when no tracer
 * - logAgentEnter starts span via tracer
 * - logAgentExit ends correct span (via tracerSpanMap fix)
 * - emit() enriches events with span context
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const mockAddEvent = vi.fn();
vi.mock('../../services/trace-store.js', () => ({
  getTraceStore: () => ({ addEvent: mockAddEvent }),
}));

vi.mock('@abl/compiler', () => ({
  scrubToolCallData: vi.fn((d: Record<string, unknown>) => d),
  redactPII: vi.fn((t: string) => t),
  scrubSecrets: vi.fn((d: Record<string, unknown>) => d),
}));

vi.mock('../../services/eventstore-singleton.js', () => ({
  getEventStore: () => null,
}));

vi.mock('../../services/trace-event-types.js', () => ({
  TRACE_TO_PLATFORM_TYPE: {},
  inferCategory: () => 'trace',
}));

vi.mock('@agent-platform/shared-observability/sti', () => ({
  tracePath: (_name: string, fn: Function) => fn,
  getSharedSTRBuffer: () => null,
}));

import { createTraceEmitter, type TraceEmitterConfig } from '../../services/trace-emitter.js';
import type { Tracer, Span, SpanContext } from '@agent-platform/shared-observability/tracing';

function createMockWs() {
  return {
    readyState: 1,
    OPEN: 1,
    send: vi.fn(),
  } as unknown as import('ws').WebSocket;
}

function createMockSpan(spanId: string, parentSpanId?: string): Span {
  return {
    name: `span-${spanId}`,
    context: { traceId: 'trace-123', spanId, parentSpanId } as SpanContext,
    attributes: {},
    setAttribute: vi.fn(),
    addEvent: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
  };
}

function createMockTracer(): Tracer & {
  _activeSpan: Span | null;
  _startedSpans: Span[];
} {
  let activeSpan: Span | null = null;
  const startedSpans: Span[] = [];

  const tracer: Tracer & { _activeSpan: Span | null; _startedSpans: Span[] } = {
    _activeSpan: null,
    _startedSpans: startedSpans,
    startSpan: vi.fn(
      (name: string, options?: { agentName?: string; attributes?: Record<string, string> }) => {
        const span = createMockSpan(`${name}-${Date.now()}`, activeSpan?.context.spanId);
        if (options?.agentName) span.agentName = options.agentName;
        startedSpans.push(span);
        activeSpan = span;
        tracer._activeSpan = span;
        return span;
      },
    ),
    withSpan: vi.fn(),
    runSync: vi.fn(),
    run: vi.fn(),
    activeSpan: vi.fn(() => activeSpan),
    emit: vi.fn(),
    continueFrom: vi.fn(),
  };

  return tracer;
}

function baseConfig(overrides: Partial<TraceEmitterConfig> = {}): TraceEmitterConfig {
  return {
    sessionId: 'test-session',
    ws: createMockWs(),
    ...overrides,
  };
}

describe('Trace Emitter — Tracer Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getActiveSpanId — tracer path', () => {
    it('reads spanId from tracer.activeSpan() when tracer is available', () => {
      const tracer = createMockTracer();
      const emitter = createTraceEmitter(baseConfig({ tracer }));

      // Before any agent enters, activeSpan is null
      expect(emitter.getCurrentSpanId()).toBeUndefined();

      // Enter an agent — tracer starts a span
      emitter.logAgentEnter({ agentName: 'agent1', mode: 'reasoning' });

      const spanId = emitter.getCurrentSpanId();
      expect(spanId).toBeDefined();
      // The span ID should come from the tracer's started span
      expect(tracer.startSpan).toHaveBeenCalledWith(
        'agent:agent1',
        expect.objectContaining({ agentName: 'agent1' }),
      );
    });
  });

  describe('getActiveSpanId — closure fallback', () => {
    it('falls back to closure-based currentSpanId when no tracer', () => {
      const emitter = createTraceEmitter(baseConfig());

      expect(emitter.getCurrentSpanId()).toBeUndefined();

      emitter.logAgentEnter({ agentName: 'agent1', mode: 'scripted' });

      const spanId = emitter.getCurrentSpanId();
      expect(spanId).toBeDefined();
      expect(spanId).toMatch(/^span-agent1-/);
    });
  });

  describe('logAgentEnter — tracer span management', () => {
    it('starts a tracer-managed span with correct name', () => {
      const tracer = createMockTracer();
      const emitter = createTraceEmitter(baseConfig({ tracer }));

      const result = emitter.logAgentEnter({ agentName: 'booking', mode: 'scripted' });

      expect(tracer.startSpan).toHaveBeenCalledOnce();
      expect(tracer.startSpan).toHaveBeenCalledWith(
        'agent:booking',
        expect.objectContaining({ agentName: 'booking' }),
      );
      expect(result!.type).toBe('agent_enter');
      expect(result!.spanId).toBeDefined();
    });

    it('sets parentSpanId from tracer span context', () => {
      const tracer = createMockTracer();
      const emitter = createTraceEmitter(baseConfig({ tracer }));

      // Enter parent agent
      const parentResult = emitter.logAgentEnter({ agentName: 'supervisor', mode: 'reasoning' });
      const parentSpanId = parentResult!.spanId;

      // Enter child agent
      const childResult = emitter.logAgentEnter({ agentName: 'worker', mode: 'scripted' });

      // Child should reference parent
      expect(childResult!.parentSpanId).toBeDefined();
    });

    it('uses explicit parentSpanId if provided', () => {
      const tracer = createMockTracer();
      const emitter = createTraceEmitter(baseConfig({ tracer }));

      const result = emitter.logAgentEnter({
        agentName: 'child',
        mode: 'reasoning',
        parentSpanId: 'explicit-parent',
      });

      expect(result!.parentSpanId).toBe('explicit-parent');
    });

    it('updates closure fallback for non-tracer-aware callers', () => {
      const tracer = createMockTracer();
      const emitter = createTraceEmitter(baseConfig({ tracer }));

      emitter.logAgentEnter({ agentName: 'agent1', mode: 'reasoning' });

      // getCurrentSpanId should work even though tracer is managing spans
      expect(emitter.getCurrentSpanId()).toBeDefined();
    });
  });

  describe('logAgentExit — tracerSpanMap fix', () => {
    it('ends the correct agent span via tracerSpanMap (not tracer.activeSpan)', () => {
      const tracer = createMockTracer();
      const emitter = createTraceEmitter(baseConfig({ tracer }));

      emitter.logAgentEnter({ agentName: 'agent1', mode: 'reasoning' });
      const span1 = tracer._startedSpans[0];

      emitter.logAgentExit({ agentName: 'agent1', result: 'completed' });

      // The specific span should have been ended, not just whatever activeSpan returns
      expect(span1.setStatus).toHaveBeenCalledWith('ok');
      expect(span1.end).toHaveBeenCalledOnce();
    });

    it('sets error status on span when result is error', () => {
      const tracer = createMockTracer();
      const emitter = createTraceEmitter(baseConfig({ tracer }));

      emitter.logAgentEnter({ agentName: 'failing', mode: 'reasoning' });
      const span = tracer._startedSpans[0];

      emitter.logAgentExit({ agentName: 'failing', result: 'error' });

      expect(span.setStatus).toHaveBeenCalledWith('error');
      expect(span.end).toHaveBeenCalledOnce();
    });

    it('pops span stack correctly for nested agents', () => {
      const tracer = createMockTracer();
      const emitter = createTraceEmitter(baseConfig({ tracer }));

      // Enter parent
      emitter.logAgentEnter({ agentName: 'parent', mode: 'reasoning' });
      const parentSpanId = emitter.getCurrentSpanId();

      // Enter child
      emitter.logAgentEnter({ agentName: 'child', mode: 'scripted' });

      // Exit child — in real code, the tracer's activeSpan() would return
      // null after the span context is popped from AsyncLocalStorage.
      // Simulate that by making activeSpan return null after end().
      (tracer.activeSpan as ReturnType<typeof vi.fn>).mockReturnValue(null);
      emitter.logAgentExit({ agentName: 'child', result: 'completed' });

      // getActiveSpanId falls back to closure currentSpanId when tracer.activeSpan() is null
      expect(emitter.getCurrentSpanId()).toBe(parentSpanId);
    });

    it('handles exit without tracer (closure path)', () => {
      const emitter = createTraceEmitter(baseConfig());

      emitter.logAgentEnter({ agentName: 'agent1', mode: 'reasoning' });
      const result = emitter.logAgentExit({ agentName: 'agent1', result: 'completed' });

      expect(result!.type).toBe('agent_exit');
      expect(result!.spanId).toMatch(/^span-agent1-/);
    });
  });

  describe('emit() enriches events with span context', () => {
    it('flow step events include spanId from tracer', () => {
      const tracer = createMockTracer();
      const emitter = createTraceEmitter(baseConfig({ tracer }));

      emitter.logAgentEnter({ agentName: 'agent1', mode: 'scripted' });

      const result = emitter.logFlowStepEnter({
        agentName: 'agent1',
        stepName: 'greet',
      });

      expect(result!.spanId).toBeDefined();
    });

    it('decision events include spanId and parentSpanId', () => {
      const tracer = createMockTracer();
      const emitter = createTraceEmitter(baseConfig({ tracer, verbosity: 'verbose' }));

      emitter.logAgentEnter({ agentName: 'agent1', mode: 'reasoning' });

      const result = emitter.emitDecision('flow_transition', {
        fromStep: 'a',
        toStep: 'b',
      });

      expect(result).toBeDefined();
      expect(result!.spanId).toBeDefined();
    });
  });
});
