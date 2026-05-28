/**
 * Trace Emitter Tests
 *
 * Comprehensive unit tests for createTraceEmitter — the factory that produces
 * the runtime's trace emission interface. Covers:
 * - Event enrichment (sessionId, deploymentId, environment, agentVersions)
 * - TraceStore integration (addEvent called with enriched events)
 * - WebSocket delivery (send called when OPEN, skipped otherwise)
 * - PII scrubbing (scrubPII flag controls redaction on LLM + tool events)
 * - Each log* method emits the correct TraceEventType
 * - Span tracking (agent enter/exit, parentSpanId, spanStack)
 * - Error resilience (TraceStore throws, WS not open)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

// Mock the trace store singleton
const mockAddEvent = vi.fn();
vi.mock('../../services/trace-store.js', () => ({
  getTraceStore: () => ({ addEvent: mockAddEvent }),
}));

// Mock the compiler scrubbing utilities
vi.mock('@abl/compiler', () => ({
  scrubToolCallData: vi.fn((data: Record<string, unknown>) => {
    // Simple mock: prefix string values with [SCRUBBED]
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      result[k] = typeof v === 'string' ? `[SCRUBBED]${v}` : v;
    }
    return result;
  }),
  redactPII: vi.fn((text: string) => text.replace(/user@example\.com/g, '[REDACTED_EMAIL]')),
  scrubSecrets: vi.fn((data: Record<string, unknown>) => data),
}));

import { createTraceEmitter, type TraceEmitterConfig } from '../../services/trace-emitter.js';
import { scrubToolCallData, redactPII } from '@abl/compiler';
import type WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockWs(readyState: number = 1 /* OPEN */): WebSocket {
  const ws = {
    readyState,
    OPEN: 1,
    CLOSED: 3,
    CONNECTING: 0,
    CLOSING: 2,
    send: vi.fn(),
  } as unknown as WebSocket;
  return ws;
}

function baseConfig(overrides: Partial<TraceEmitterConfig> = {}): TraceEmitterConfig {
  return {
    sessionId: 'sess-abc',
    ws: createMockWs(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createTraceEmitter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // emit() — event enrichment
  // =========================================================================

  describe('emit() — event enrichment', () => {
    it('should add sessionId to every emitted event', () => {
      const emitter = createTraceEmitter(baseConfig({ sessionId: 'sess-123' }));
      const result = emitter.emit({
        type: 'decision',
        timestamp: new Date('2025-01-01'),
        data: { foo: 'bar' },
      });

      expect(result).toBeDefined();
      expect(result!.sessionId).toBe('sess-123');
    });

    it('should assign a unique id to each event', () => {
      const emitter = createTraceEmitter(baseConfig());
      const r1 = emitter.emit({ type: 'decision', timestamp: new Date(), data: {} });
      const r2 = emitter.emit({ type: 'decision', timestamp: new Date(), data: {} });

      expect(typeof r1!.id).toBe('string');
      expect(typeof r2!.id).toBe('string');
      expect(r1!.id).not.toBe(r2!.id);
    });

    it('should include deploymentId when configured', () => {
      const emitter = createTraceEmitter(baseConfig({ deploymentId: 'dep-42' }));
      const result = emitter.emit({ type: 'error', timestamp: new Date(), data: {} });

      expect(result!.deploymentId).toBe('dep-42');
    });

    it('should include environment when configured', () => {
      const emitter = createTraceEmitter(baseConfig({ environment: 'staging' }));
      const result = emitter.emit({ type: 'error', timestamp: new Date(), data: {} });

      expect(result!.environment).toBe('staging');
    });

    it('should include agentVersions when configured', () => {
      const versions = { booking: 3, search: 1 };
      const emitter = createTraceEmitter(baseConfig({ agentVersions: versions }));
      const result = emitter.emit({ type: 'error', timestamp: new Date(), data: {} });

      expect(result!.agentVersions).toEqual(versions);
    });

    it('should not include deploymentId when not configured', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.emit({ type: 'error', timestamp: new Date(), data: {} });

      expect(result).not.toHaveProperty('deploymentId');
    });

    it('should not include environment when not configured', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.emit({ type: 'error', timestamp: new Date(), data: {} });

      expect(result).not.toHaveProperty('environment');
    });

    it('should not include agentVersions when not configured', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.emit({ type: 'error', timestamp: new Date(), data: {} });

      expect(result).not.toHaveProperty('agentVersions');
    });

    it('should preserve all original event fields', () => {
      const emitter = createTraceEmitter(baseConfig());
      const ts = new Date('2025-06-15T10:00:00Z');
      const result = emitter.emit({
        type: 'handoff',
        timestamp: ts,
        durationMs: 42,
        data: { key: 'value' },
        agentName: 'booking',
        spanId: 'span-1',
        parentSpanId: 'span-0',
      });

      expect(result!.type).toBe('handoff');
      expect(result!.timestamp).toBe(ts);
      expect(result!.durationMs).toBe(42);
      expect(result!.data).toEqual({ key: 'value' });
      expect(result!.agentName).toBe('booking');
      expect(result!.spanId).toBe('span-1');
      expect(result!.parentSpanId).toBe('span-0');
    });
  });

  // =========================================================================
  // emit() — TraceStore integration
  // =========================================================================

  describe('emit() — TraceStore integration', () => {
    it('should call TraceStore.addEvent with sessionId and enriched event', () => {
      const emitter = createTraceEmitter(baseConfig({ sessionId: 'sess-store' }));
      emitter.emit({ type: 'decision', timestamp: new Date(), data: { x: 1 } });

      expect(mockAddEvent).toHaveBeenCalledTimes(1);
      expect(mockAddEvent).toHaveBeenCalledWith(
        'sess-store',
        expect.objectContaining({ sessionId: 'sess-store' }),
      );
      const storedEvent = mockAddEvent.mock.calls[0][1];
      expect(typeof storedEvent.id).toBe('string');
      expect(storedEvent.id.length).toBeGreaterThan(0);
    });

    it('should not throw when TraceStore.addEvent throws', () => {
      mockAddEvent.mockImplementationOnce(() => {
        throw new Error('Redis down');
      });

      const emitter = createTraceEmitter(baseConfig());
      // Should not throw
      const result = emitter.emit({ type: 'error', timestamp: new Date(), data: {} });
      expect(result).toBeDefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'TraceStore unavailable — trace event not persisted',
        expect.objectContaining({
          sessionId: 'sess-abc',
          eventType: 'error',
          error: 'Redis down',
        }),
      );
    });

    it('should still send over WebSocket even when TraceStore throws', () => {
      mockAddEvent.mockImplementationOnce(() => {
        throw new Error('Redis down');
      });

      const ws = createMockWs();
      const emitter = createTraceEmitter(baseConfig({ ws }));
      emitter.emit({ type: 'error', timestamp: new Date(), data: {} });

      expect(ws.send).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'TraceStore unavailable — trace event not persisted',
        expect.objectContaining({
          sessionId: 'sess-abc',
          eventType: 'error',
          error: 'Redis down',
        }),
      );
    });
  });

  // =========================================================================
  // emit() — WebSocket delivery
  // =========================================================================

  describe('emit() — WebSocket delivery', () => {
    it('should send JSON message over WebSocket when readyState is OPEN', () => {
      const ws = createMockWs(1);
      const emitter = createTraceEmitter(baseConfig({ ws, sessionId: 'sess-ws' }));
      emitter.emit({ type: 'decision', timestamp: new Date(), data: {} });

      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(sent.type).toBe('trace_event');
      expect(sent.sessionId).toBe('sess-ws');
      expect(sent.event).toBeDefined();
      expect(typeof sent.event.id).toBe('string');
      expect(sent.event.id.length).toBeGreaterThan(0);
    });

    it('should not send over WebSocket when readyState is CLOSED', () => {
      const ws = createMockWs(3);
      const emitter = createTraceEmitter(baseConfig({ ws }));
      emitter.emit({ type: 'decision', timestamp: new Date(), data: {} });

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('should not send over WebSocket when readyState is CONNECTING', () => {
      const ws = createMockWs(0);
      const emitter = createTraceEmitter(baseConfig({ ws }));
      emitter.emit({ type: 'decision', timestamp: new Date(), data: {} });

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('should not send over WebSocket when readyState is CLOSING', () => {
      const ws = createMockWs(2);
      const emitter = createTraceEmitter(baseConfig({ ws }));
      emitter.emit({ type: 'decision', timestamp: new Date(), data: {} });

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('should return the enriched event regardless of WebSocket state', () => {
      const ws = createMockWs(3); // CLOSED
      const emitter = createTraceEmitter(baseConfig({ ws }));
      const result = emitter.emit({ type: 'error', timestamp: new Date(), data: {} });

      expect(result).toBeDefined();
      expect(typeof result!.id).toBe('string');
      expect(result!.id.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // logLLMCall
  // =========================================================================

  describe('logLLMCall()', () => {
    it('should emit an event with type llm_call', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logLLMCall({
        model: 'gpt-4',
        messagesIn: 5,
        tokensIn: 100,
        tokensOut: 50,
        latencyMs: 200,
      });

      expect(result!.type).toBe('llm_call');
    });

    it('should include durationMs from latencyMs', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logLLMCall({
        model: 'gpt-4',
        messagesIn: 5,
        tokensIn: 100,
        tokensOut: 50,
        latencyMs: 350,
      });

      expect(result!.durationMs).toBe(350);
    });

    it('should pass all params in data when scrubPII is false', () => {
      const emitter = createTraceEmitter(baseConfig({ scrubPII: false }));
      const params = {
        model: 'gpt-4',
        messagesIn: 3,
        tokensIn: 50,
        tokensOut: 25,
        latencyMs: 100,
        cost: 0.01,
        messages: [{ role: 'user', content: 'hello user@example.com' }],
        response: 'hi user@example.com',
      };
      const result = emitter.logLLMCall(params);

      expect(result!.data).toEqual(params);
      expect(redactPII).not.toHaveBeenCalled();
    });

    it('should scrub message content when scrubPII is true', () => {
      const emitter = createTraceEmitter(baseConfig({ scrubPII: true }));
      const result = emitter.logLLMCall({
        model: 'gpt-4',
        messagesIn: 1,
        tokensIn: 10,
        tokensOut: 5,
        latencyMs: 50,
        messages: [{ role: 'user', content: 'contact user@example.com' }],
        response: 'email is user@example.com',
      });

      const data = result!.data as Record<string, unknown>;
      const messages = data.messages as Array<{ role: string; content: string }>;
      expect(messages[0].content).toBe('contact [REDACTED_EMAIL]');
      expect(data.response).toBe('email is [REDACTED_EMAIL]');
    });

    it('should not scrub messages when scrubPII is undefined', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logLLMCall({
        model: 'gpt-4',
        messagesIn: 1,
        tokensIn: 10,
        tokensOut: 5,
        latencyMs: 50,
        messages: [{ role: 'user', content: 'contact user@example.com' }],
      });

      const data = result!.data as Record<string, unknown>;
      const messages = data.messages as Array<{ role: string; content: string }>;
      expect(messages[0].content).toBe('contact user@example.com');
    });

    it('should handle undefined messages array', () => {
      const emitter = createTraceEmitter(baseConfig({ scrubPII: true }));
      const result = emitter.logLLMCall({
        model: 'gpt-4',
        messagesIn: 1,
        tokensIn: 10,
        tokensOut: 5,
        latencyMs: 50,
      });

      const data = result!.data as Record<string, unknown>;
      expect(data.messages).toBeUndefined();
    });

    it('should handle undefined response with scrubPII enabled', () => {
      const emitter = createTraceEmitter(baseConfig({ scrubPII: true }));
      const result = emitter.logLLMCall({
        model: 'gpt-4',
        messagesIn: 1,
        tokensIn: 10,
        tokensOut: 5,
        latencyMs: 50,
        response: undefined,
      });

      const data = result!.data as Record<string, unknown>;
      expect(data.response).toBeUndefined();
    });

    it('should include optional cost in data', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logLLMCall({
        model: 'claude-3',
        messagesIn: 2,
        tokensIn: 80,
        tokensOut: 40,
        latencyMs: 150,
        cost: 0.005,
      });

      const data = result!.data as Record<string, unknown>;
      expect(data.cost).toBe(0.005);
    });
  });

  // =========================================================================
  // logToolCall
  // =========================================================================

  describe('logToolCall()', () => {
    it('should emit an event with type tool_call', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logToolCall({
        toolName: 'search_hotels',
        input: { city: 'Paris' },
        output: { results: [] },
        success: true,
        latencyMs: 120,
      });

      expect(result!.type).toBe('tool_call');
    });

    it('should include durationMs from latencyMs', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logToolCall({
        toolName: 'search',
        input: {},
        output: null,
        success: true,
        latencyMs: 250,
      });

      expect(result!.durationMs).toBe(250);
    });

    it('should not scrub when scrubPII is false', () => {
      const emitter = createTraceEmitter(baseConfig({ scrubPII: false }));
      emitter.logToolCall({
        toolName: 'search',
        input: { query: 'test' },
        output: { data: 'result' },
        success: true,
        latencyMs: 50,
      });

      expect(scrubToolCallData).not.toHaveBeenCalled();
    });

    it('should scrub input when scrubPII is true', () => {
      const emitter = createTraceEmitter(baseConfig({ scrubPII: true }));
      emitter.logToolCall({
        toolName: 'search',
        input: { authorization: 'Bearer secret-token' },
        output: 'plain string output',
        success: true,
        latencyMs: 50,
      });

      expect(scrubToolCallData).toHaveBeenCalledWith(
        { authorization: 'Bearer secret-token' },
        { piiRecognizerRegistry: undefined },
      );
    });

    it('should scrub object output when scrubPII is true', () => {
      const emitter = createTraceEmitter(baseConfig({ scrubPII: true }));
      emitter.logToolCall({
        toolName: 'lookup',
        input: {},
        output: { secret: 'key123' },
        success: true,
        latencyMs: 30,
      });

      // scrubToolCallData is called for both input and output (output is an object)
      expect(scrubToolCallData).toHaveBeenCalledTimes(2);
    });

    it('should not scrub non-object output when scrubPII is true', () => {
      const emitter = createTraceEmitter(baseConfig({ scrubPII: true }));
      const result = emitter.logToolCall({
        toolName: 'ping',
        input: {},
        output: 'pong',
        success: true,
        latencyMs: 10,
      });

      // scrubToolCallData called once for input, not for string output
      expect(scrubToolCallData).toHaveBeenCalledTimes(1);
      const data = result!.data as Record<string, unknown>;
      expect(data.output).toBe('pong');
    });

    it('should handle null output when scrubPII is true', () => {
      const emitter = createTraceEmitter(baseConfig({ scrubPII: true }));
      const result = emitter.logToolCall({
        toolName: 'ping',
        input: {},
        output: null,
        success: false,
        latencyMs: 10,
        error: 'timeout',
      });

      const data = result!.data as Record<string, unknown>;
      expect(data.output).toBeNull();
      expect(data.error).toBe('timeout');
    });

    it('should include error field when provided', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logToolCall({
        toolName: 'api_call',
        input: {},
        output: null,
        success: false,
        latencyMs: 5000,
        error: 'Connection timed out',
      });

      const data = result!.data as Record<string, unknown>;
      expect(data.error).toBe('Connection timed out');
      expect(data.success).toBe(false);
    });

    it('should preserve workflow metadata when provided', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logToolCall({
        toolName: 'workflow_tool',
        input: { orderId: '123' },
        output: { ok: true },
        success: true,
        latencyMs: 25,
        metadata: {
          workflow_id: 'wf-1',
          workflow_version_id: 'wfv-2',
          workflow_version: 'v2.0.0',
        },
      });

      const data = result!.data as Record<string, unknown>;
      expect(data.metadata).toEqual({
        workflow_id: 'wf-1',
        workflow_version_id: 'wfv-2',
        workflow_version: 'v2.0.0',
      });
    });
  });

  // =========================================================================
  // logConstraintCheck
  // =========================================================================

  describe('logConstraintCheck()', () => {
    it('should emit an event with type constraint_check', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logConstraintCheck({
        constraint: 'max_budget_exceeded',
        passed: false,
        context: { budget: 5000, limit: 3000 },
      });

      expect(result!.type).toBe('constraint_check');
    });

    it('should include all params in data', () => {
      const emitter = createTraceEmitter(baseConfig());
      const params = {
        constraint: 'valid_dates',
        passed: true,
        context: { checkIn: '2025-01-01', checkOut: '2025-01-05' },
      };
      const result = emitter.logConstraintCheck(params);

      expect(result!.data).toEqual(params);
    });
  });

  // =========================================================================
  // logHandoff
  // =========================================================================

  describe('logHandoff()', () => {
    it('should emit an event with type handoff', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logHandoff({
        toAgent: 'billing_agent',
        reason: 'User has billing question',
        context: { customerId: 'c-1' },
      });

      expect(result!.type).toBe('handoff');
    });

    it('should include contextMeta with keysEvaluated instead of raw context', () => {
      const emitter = createTraceEmitter(baseConfig({ sessionId: 'sess-h1' }));
      const params = {
        toAgent: 'support',
        reason: 'escalation needed',
        context: { priority: 'high', customerId: 'c-1' },
      };
      const result = emitter.logHandoff(params);

      const data = result!.data as Record<string, unknown>;
      expect(data.toAgent).toBe('support');
      expect(data.reason).toBe('escalation needed');
      expect(data).not.toHaveProperty('context');
      const meta = data.contextMeta as {
        keysEvaluated: string[];
        keyCount: number;
        sessionId: string;
      };
      expect(meta.keysEvaluated).toEqual(['priority', 'customerId']);
      expect(meta.keyCount).toBe(2);
      expect(meta.sessionId).toBe('sess-h1');
    });
  });

  // =========================================================================
  // logEscalation
  // =========================================================================

  describe('logEscalation()', () => {
    it('should emit an event with type escalation', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logEscalation({
        reason: 'Unresolvable complaint',
        priority: 'critical',
        context: { attempts: 5 },
      });

      expect(result!.type).toBe('escalation');
    });

    it('should include contextMeta with keysEvaluated instead of raw context', () => {
      const emitter = createTraceEmitter(baseConfig({ sessionId: 'sess-e1' }));
      const params = {
        reason: 'Customer angry',
        priority: 'high',
        context: { sentiment: -0.8, attempts: 5 },
      };
      const result = emitter.logEscalation(params);

      const data = result!.data as Record<string, unknown>;
      expect(data.reason).toBe('Customer angry');
      expect(data.priority).toBe('high');
      expect(data).not.toHaveProperty('context');
      const meta = data.contextMeta as {
        keysEvaluated: string[];
        keyCount: number;
        sessionId: string;
      };
      expect(meta.keysEvaluated).toEqual(['sentiment', 'attempts']);
      expect(meta.keyCount).toBe(2);
      expect(meta.sessionId).toBe('sess-e1');
    });
  });

  // =========================================================================
  // logError
  // =========================================================================

  describe('logError()', () => {
    it('should emit an event with type error', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logError({
        errorType: 'tool_failure',
        message: 'API returned 500',
      });

      expect(result!.type).toBe('error');
    });

    it('should include optional stack trace', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logError({
        errorType: 'runtime_error',
        message: 'Null pointer',
        stack: 'Error: Null pointer\n    at foo.ts:10',
      });

      const data = result!.data as Record<string, unknown>;
      expect(data.stack).toContain('foo.ts:10');
    });
  });

  // =========================================================================
  // logCustom
  // =========================================================================

  describe('logCustom()', () => {
    it('should emit an event with the specified custom type', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logCustom('dsl_collect', { field: 'email', status: 'collected' });

      expect(result!.type).toBe('dsl_collect');
    });

    it('should include the provided data', () => {
      const emitter = createTraceEmitter(baseConfig());
      const data = { key: 'value', count: 42 };
      const result = emitter.logCustom('dsl_set', data);

      expect(result!.data).toEqual(data);
    });
  });

  // =========================================================================
  // Span tracking — logAgentEnter / logAgentExit
  // =========================================================================

  describe('span tracking', () => {
    it('logAgentEnter should create a spanId', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logAgentEnter({
        agentName: 'booking',
        mode: 'scripted',
      });

      expect(result!.type).toBe('agent_enter');
      expect(result!.spanId).toMatch(/^span-booking-/);
    });

    it('logAgentEnter should set currentSpanId accessible via getCurrentSpanId', () => {
      const emitter = createTraceEmitter(baseConfig());
      emitter.logAgentEnter({ agentName: 'booking', mode: 'scripted' });

      expect(emitter.getCurrentSpanId()).toMatch(/^span-booking-/);
    });

    it('logAgentEnter should use default trigger when not provided', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logAgentEnter({ agentName: 'agent1', mode: 'reasoning' });

      const data = result!.data as Record<string, unknown>;
      expect(data.trigger).toBe('user_message');
    });

    it('logAgentEnter should use provided trigger', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logAgentEnter({
        agentName: 'agent1',
        mode: 'reasoning',
        trigger: 'delegation',
      });

      const data = result!.data as Record<string, unknown>;
      expect(data.trigger).toBe('delegation');
    });

    it('logAgentEnter should stack spans for nested agents', () => {
      const emitter = createTraceEmitter(baseConfig());

      // First agent enter
      const r1 = emitter.logAgentEnter({ agentName: 'supervisor', mode: 'reasoning' });
      const span1 = r1!.spanId;

      // Second agent enter (nested)
      const r2 = emitter.logAgentEnter({ agentName: 'booking', mode: 'scripted' });
      const span2 = r2!.spanId;

      // The nested agent should have the parent span
      expect(r2!.parentSpanId).toBe(span1);
      expect(span2).not.toBe(span1);
      expect(emitter.getCurrentSpanId()).toBe(span2);
    });

    it('logAgentEnter should use explicit parentSpanId when provided', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logAgentEnter({
        agentName: 'child',
        mode: 'scripted',
        parentSpanId: 'explicit-parent-span',
      });

      expect(result!.parentSpanId).toBe('explicit-parent-span');
    });

    it('logAgentExit should restore previous spanId from stack', () => {
      const emitter = createTraceEmitter(baseConfig());

      emitter.logAgentEnter({ agentName: 'supervisor', mode: 'reasoning' });
      const outerSpan = emitter.getCurrentSpanId();

      emitter.logAgentEnter({ agentName: 'booking', mode: 'scripted' });
      expect(emitter.getCurrentSpanId()).not.toBe(outerSpan);

      emitter.logAgentExit({ agentName: 'booking', result: 'completed' });
      expect(emitter.getCurrentSpanId()).toBe(outerSpan);
    });

    it('logAgentExit should emit the exit event with correct spanId', () => {
      const emitter = createTraceEmitter(baseConfig());
      emitter.logAgentEnter({ agentName: 'booking', mode: 'scripted' });
      const spanId = emitter.getCurrentSpanId();

      const result = emitter.logAgentExit({
        agentName: 'booking',
        result: 'completed',
        durationMs: 500,
      });

      expect(result!.type).toBe('agent_exit');
      expect(result!.spanId).toBe(spanId);
      expect(result!.durationMs).toBe(500);
    });

    it('logAgentExit should clear currentSpanId when stack is empty', () => {
      const emitter = createTraceEmitter(baseConfig());

      emitter.logAgentEnter({ agentName: 'booking', mode: 'scripted' });
      emitter.logAgentExit({ agentName: 'booking', result: 'completed' });

      expect(emitter.getCurrentSpanId()).toBeUndefined();
    });

    it('getCurrentSpanId should return undefined initially', () => {
      const emitter = createTraceEmitter(baseConfig());
      expect(emitter.getCurrentSpanId()).toBeUndefined();
    });
  });

  // =========================================================================
  // Flow step events
  // =========================================================================

  describe('flow step events', () => {
    it('logFlowStepEnter should emit flow_step_enter with currentSpanId', () => {
      const emitter = createTraceEmitter(baseConfig());
      emitter.logAgentEnter({ agentName: 'booking', mode: 'scripted' });
      const spanId = emitter.getCurrentSpanId();

      const result = emitter.logFlowStepEnter({
        agentName: 'booking',
        stepName: 'gather_info',
        stepType: 'collect',
      });

      expect(result!.type).toBe('flow_step_enter');
      expect(result!.spanId).toBe(spanId);
      expect(result!.agentName).toBe('booking');
      const data = result!.data as Record<string, unknown>;
      expect(data.stepName).toBe('gather_info');
      expect(data.stepType).toBe('collect');
    });

    it('logFlowStepExit should emit flow_step_exit with durationMs', () => {
      const emitter = createTraceEmitter(baseConfig());
      emitter.logAgentEnter({ agentName: 'booking', mode: 'scripted' });

      const result = emitter.logFlowStepExit({
        agentName: 'booking',
        stepName: 'gather_info',
        durationMs: 300,
      });

      expect(result!.type).toBe('flow_step_exit');
      expect(result!.durationMs).toBe(300);
    });

    it('logFlowTransition should emit flow_transition with from/to steps', () => {
      const emitter = createTraceEmitter(baseConfig());
      emitter.logAgentEnter({ agentName: 'booking', mode: 'scripted' });

      const result = emitter.logFlowTransition({
        agentName: 'booking',
        fromStep: 'gather_info',
        toStep: 'confirm',
        condition: 'all_fields_collected',
      });

      expect(result!.type).toBe('flow_transition');
      const data = result!.data as Record<string, unknown>;
      expect(data.fromStep).toBe('gather_info');
      expect(data.toStep).toBe('confirm');
      expect(data.condition).toBe('all_fields_collected');
    });
  });

  // =========================================================================
  // Delegation events
  // =========================================================================

  describe('delegation events', () => {
    it('logDelegateStart should emit delegate_start', () => {
      const emitter = createTraceEmitter(baseConfig());
      emitter.logAgentEnter({ agentName: 'supervisor', mode: 'reasoning' });

      const result = emitter.logDelegateStart({
        fromAgent: 'supervisor',
        targetAgent: 'booking',
        task: 'Book a hotel in Paris',
      });

      expect(result!.type).toBe('delegate_start');
      expect(result!.agentName).toBe('supervisor');
      const data = result!.data as Record<string, unknown>;
      expect(data.targetAgent).toBe('booking');
      expect(data.task).toBe('Book a hotel in Paris');
    });

    it('logDelegateComplete should emit delegate_complete', () => {
      const emitter = createTraceEmitter(baseConfig());
      emitter.logAgentEnter({ agentName: 'supervisor', mode: 'reasoning' });

      const result = emitter.logDelegateComplete({
        fromAgent: 'supervisor',
        targetAgent: 'booking',
        success: true,
        durationMs: 2000,
      });

      expect(result!.type).toBe('delegate_complete');
      expect(result!.durationMs).toBe(2000);
      const data = result!.data as Record<string, unknown>;
      expect(data.success).toBe(true);
    });

    it('logDelegateComplete should report failure', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logDelegateComplete({
        fromAgent: 'supervisor',
        targetAgent: 'booking',
        success: false,
        durationMs: 5000,
      });

      const data = result!.data as Record<string, unknown>;
      expect(data.success).toBe(false);
    });
  });

  // =========================================================================
  // Timestamp generation
  // =========================================================================

  describe('timestamp generation', () => {
    it('each log method should set a timestamp on the event', () => {
      const emitter = createTraceEmitter(baseConfig());

      const methods = [
        () =>
          emitter.logLLMCall({
            model: 'm',
            messagesIn: 0,
            tokensIn: 0,
            tokensOut: 0,
            latencyMs: 0,
          }),
        () =>
          emitter.logToolCall({
            toolName: 't',
            input: {},
            output: null,
            success: true,
            latencyMs: 0,
          }),
        () => emitter.logConstraintCheck({ constraint: 'c', passed: true, context: {} }),
        () => emitter.logHandoff({ toAgent: 'a', reason: 'r', context: {} }),
        () => emitter.logEscalation({ reason: 'r', priority: 'low', context: {} }),
        () => emitter.logError({ errorType: 'e', message: 'm' }),
        () => emitter.logCustom('dsl_set', {}),
      ];

      for (const method of methods) {
        const result = method();
        expect(result!.timestamp).toBeInstanceOf(Date);
      }
    });
  });

  // =========================================================================
  // Full deployment context enrichment
  // =========================================================================

  describe('full deployment context', () => {
    it('should enrich every event with all deployment fields when all are set', () => {
      const emitter = createTraceEmitter(
        baseConfig({
          sessionId: 'sess-full',
          deploymentId: 'dep-99',
          environment: 'production',
          agentVersions: { booking: 5, search: 2 },
        }),
      );

      const result = emitter.logError({ errorType: 'test', message: 'test' });

      expect(result!.sessionId).toBe('sess-full');
      expect(result!.deploymentId).toBe('dep-99');
      expect(result!.environment).toBe('production');
      expect(result!.agentVersions).toEqual({ booking: 5, search: 2 });
    });
  });

  // =========================================================================
  // Multiple emissions accumulate in TraceStore
  // =========================================================================

  describe('multiple emissions', () => {
    it('should call TraceStore.addEvent for each emission', () => {
      const emitter = createTraceEmitter(baseConfig());

      emitter.logError({ errorType: 'a', message: 'a' });
      emitter.logError({ errorType: 'b', message: 'b' });
      emitter.logError({ errorType: 'c', message: 'c' });

      expect(mockAddEvent).toHaveBeenCalledTimes(3);
    });

    it('should send each event over WebSocket', () => {
      const ws = createMockWs();
      const emitter = createTraceEmitter(baseConfig({ ws }));

      emitter.logError({ errorType: 'a', message: 'a' });
      emitter.logError({ errorType: 'b', message: 'b' });

      expect(ws.send).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Deep span nesting (3 levels)
  // =========================================================================

  describe('deep span nesting', () => {
    it('should correctly track 3 levels of nested agents', () => {
      const emitter = createTraceEmitter(baseConfig());

      // Level 1
      emitter.logAgentEnter({ agentName: 'supervisor', mode: 'reasoning' });
      const span1 = emitter.getCurrentSpanId();

      // Level 2
      const r2 = emitter.logAgentEnter({ agentName: 'booking', mode: 'scripted' });
      const span2 = emitter.getCurrentSpanId();
      expect(r2!.parentSpanId).toBe(span1);

      // Level 3
      const r3 = emitter.logAgentEnter({ agentName: 'payment', mode: 'scripted' });
      const span3 = emitter.getCurrentSpanId();
      expect(r3!.parentSpanId).toBe(span2);

      // Unwind level 3
      emitter.logAgentExit({ agentName: 'payment', result: 'completed' });
      expect(emitter.getCurrentSpanId()).toBe(span2);

      // Unwind level 2
      emitter.logAgentExit({ agentName: 'booking', result: 'completed' });
      expect(emitter.getCurrentSpanId()).toBe(span1);

      // Unwind level 1
      emitter.logAgentExit({ agentName: 'supervisor', result: 'completed' });
      expect(emitter.getCurrentSpanId()).toBeUndefined();

      // All three spans were distinct
      expect(new Set([span1, span2, span3]).size).toBe(3);
    });
  });

  // =========================================================================
  // Flow events carry the current spanId
  // =========================================================================

  describe('flow events use current span context', () => {
    it('logFlowStepEnter should have undefined spanId when no agent entered', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logFlowStepEnter({
        agentName: 'orphan',
        stepName: 'step1',
      });

      expect(result!.spanId).toBeUndefined();
    });

    it('logFlowTransition should have undefined spanId when no agent entered', () => {
      const emitter = createTraceEmitter(baseConfig());
      const result = emitter.logFlowTransition({
        agentName: 'orphan',
        fromStep: 'a',
        toStep: 'b',
      });

      expect(result!.spanId).toBeUndefined();
    });

    it('delegation events should carry the current spanId', () => {
      const emitter = createTraceEmitter(baseConfig());
      emitter.logAgentEnter({ agentName: 'supervisor', mode: 'reasoning' });
      const spanId = emitter.getCurrentSpanId();

      const startResult = emitter.logDelegateStart({
        fromAgent: 'supervisor',
        targetAgent: 'booking',
      });
      expect(startResult!.spanId).toBe(spanId);

      const completeResult = emitter.logDelegateComplete({
        fromAgent: 'supervisor',
        targetAgent: 'booking',
        success: true,
      });
      expect(completeResult!.spanId).toBe(spanId);
    });
  });

  // =========================================================================
  // emitDecision — verbosity-gated decision events with decisionKind
  // =========================================================================

  describe('emitDecision()', () => {
    it('should emit an event with type decision and decisionKind in data', () => {
      const emitter = createTraceEmitter(baseConfig({ verbosity: 'standard' }));
      const result = emitter.emitDecision('handoff', {
        toAgent: 'billing',
        reason: 'user requested',
      });

      expect(result).toBeDefined();
      expect(result!.type).toBe('decision');
      const data = result!.data as Record<string, unknown>;
      expect(data.decisionKind).toBe('handoff');
      expect(data.toAgent).toBe('billing');
      expect(data.reason).toBe('user requested');
    });

    it('should gate verbose-tier decisions at standard verbosity', () => {
      const emitter = createTraceEmitter(baseConfig({ verbosity: 'standard' }));
      const result = emitter.emitDecision('gather_extraction', { field: 'email' });

      expect(result).toBeUndefined();
      // Should not have called addEvent since the decision was gated
      expect(mockAddEvent).not.toHaveBeenCalled();
    });

    it('should emit verbose-tier decisions at verbose verbosity', () => {
      const emitter = createTraceEmitter(baseConfig({ verbosity: 'verbose' }));
      const result = emitter.emitDecision('gather_extraction', { field: 'email' });

      expect(result).toBeDefined();
      expect(result!.type).toBe('decision');
      const data = result!.data as Record<string, unknown>;
      expect(data.decisionKind).toBe('gather_extraction');
      expect(data.field).toBe('email');
    });

    it('should gate all decisions at minimal verbosity', () => {
      const emitter = createTraceEmitter(baseConfig({ verbosity: 'minimal' }));
      const result = emitter.emitDecision('handoff', { toAgent: 'billing' });

      expect(result).toBeUndefined();
    });

    it('should emit all decision kinds at debug verbosity', () => {
      const emitter = createTraceEmitter(baseConfig({ verbosity: 'debug' }));

      const kinds = [
        'handoff',
        'delegation',
        'flow_transition',
        'gather_extraction',
        'correction',
        'data_mutation',
      ] as const;

      for (const kind of kinds) {
        const result = emitter.emitDecision(kind, { test: true });
        expect(result).toBeDefined();
        expect(result!.type).toBe('decision');
        expect((result!.data as Record<string, unknown>).decisionKind).toBe(kind);
      }
    });

    it('should default to standard verbosity when not configured', () => {
      const emitter = createTraceEmitter(baseConfig());

      // Standard-tier kind should emit
      const r1 = emitter.emitDecision('handoff', { toAgent: 'billing' });
      expect(r1).toBeDefined();

      // Verbose-tier kind should not emit
      const r2 = emitter.emitDecision('gather_extraction', { field: 'email' });
      expect(r2).toBeUndefined();
    });

    it('should include spanId and parentSpanId from active agent context', () => {
      const emitter = createTraceEmitter(baseConfig({ verbosity: 'standard' }));

      emitter.logAgentEnter({ agentName: 'supervisor', mode: 'reasoning' });
      const parentSpan = emitter.getCurrentSpanId();

      emitter.logAgentEnter({ agentName: 'booking', mode: 'scripted' });
      const childSpan = emitter.getCurrentSpanId();

      mockAddEvent.mockClear();
      const result = emitter.emitDecision('flow_transition', {
        fromStep: 'gather',
        toStep: 'confirm',
      });

      expect(result).toBeDefined();
      expect(result!.spanId).toBe(childSpan);
      expect(result!.parentSpanId).toBe(parentSpan);
    });

    it('should store the decision event in TraceStore', () => {
      const emitter = createTraceEmitter(
        baseConfig({ sessionId: 'sess-dec', verbosity: 'standard' }),
      );
      mockAddEvent.mockClear();

      emitter.emitDecision('constraint_check', { constraint: 'max_budget', passed: false });

      expect(mockAddEvent).toHaveBeenCalledTimes(1);
      expect(mockAddEvent).toHaveBeenCalledWith(
        'sess-dec',
        expect.objectContaining({ type: 'decision' }),
      );
    });

    it('should send decision event over WebSocket', () => {
      const ws = createMockWs();
      const emitter = createTraceEmitter(baseConfig({ ws, verbosity: 'standard' }));

      emitter.emitDecision('escalation', { reason: 'angry customer' });

      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(sent.type).toBe('trace_event');
      expect(sent.event.type).toBe('decision');
    });
  });

  // =========================================================================
  // Return type shape — TraceEventWithId
  // =========================================================================

  describe('return shape (TraceEventWithId)', () => {
    it('should always return an object with id and sessionId', () => {
      const emitter = createTraceEmitter(baseConfig({ sessionId: 'sess-shape' }));
      const result = emitter.emit({ type: 'error', timestamp: new Date(), data: {} });

      expect(typeof result!.id).toBe('string');
      expect(result!.sessionId).toBe('sess-shape');
      expect(result!.type).toBe('error');
      expect(result!.timestamp).toBeInstanceOf(Date);
      expect(result!.data).toBeDefined();
    });
  });
});
