/**
 * Realtime Voice Observability Tests
 *
 * Tests the realtime voice tracing functions: turn lifecycle, first audio out,
 * tool call recording, and turn completion with timing breakdown.
 * Only OTEL API is mocked (no real collector in unit tests).
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// OTEL mock — provides mock tracer/spans for assertion
// vi.hoisted() ensures these are available before vi.mock() runs
// ---------------------------------------------------------------------------
const { mockSpanEnd, mockSetAttribute, mockSetAttributes, mockSetStatus, mockStartSpan } =
  vi.hoisted(() => {
    const mockSpanEnd = vi.fn();
    const mockSetAttribute = vi.fn();
    const mockSetAttributes = vi.fn();
    const mockSetStatus = vi.fn();

    const createMockSpan = () => ({
      setAttribute: mockSetAttribute,
      setAttributes: mockSetAttributes,
      setStatus: mockSetStatus,
      end: mockSpanEnd,
    });

    const mockStartSpan = vi.fn(() => createMockSpan());

    return { mockSpanEnd, mockSetAttribute, mockSetAttributes, mockSetStatus, mockStartSpan };
  });

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({ startSpan: mockStartSpan }),
    setSpan: vi.fn(() => ({ _mockOtelContext: true })),
  },
  context: {
    active: vi.fn(() => ({ _mockActive: true })),
  },
  metrics: {
    getMeter: () => ({
      createCounter: () => ({ add: vi.fn() }),
    }),
  },
  SpanStatusCode: { OK: 1, ERROR: 2 },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  startRealtimeVoiceTurn,
  recordRealtimeFirstAudioOut,
  recordRealtimeToolCall,
  completeRealtimeVoiceTurn,
  failRealtimeVoiceTurn,
  createRealtimeTimingReportEvent,
  getActiveRealtimeVoiceTurn,
  type RealtimeVoiceTurnContext,
  type RealtimeVoiceTimingBreakdown,
} from '../../observability/voice-trace.js';

// =============================================================================
// SETUP
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  // Clear the internal Map between tests by completing or overwriting
});

// =============================================================================
// startRealtimeVoiceTurn
// =============================================================================

describe('startRealtimeVoiceTurn', () => {
  test('returns context with unique IDs', () => {
    const ctx = startRealtimeVoiceTurn('session-1');
    expect(ctx.turnId).toBeDefined();
    expect(ctx.traceId).toBeDefined();
    expect(ctx.spanId).toBeDefined();
    expect(ctx.sessionId).toBe('session-1');
  });

  test('returns context with status=active', () => {
    const ctx = startRealtimeVoiceTurn('session-2');
    expect(ctx.status).toBe('active');
  });

  test('returns context with zero counters', () => {
    const ctx = startRealtimeVoiceTurn('session-3');
    expect(ctx.audioDurationInMs).toBe(0);
    expect(ctx.audioDurationOutMs).toBe(0);
    expect(ctx.toolCallCount).toBe(0);
    expect(ctx.toolCallLatencyMs).toBe(0);
  });

  test('stores in map (verifiable via getActiveRealtimeVoiceTurn)', () => {
    const ctx = startRealtimeVoiceTurn('session-4');
    const retrieved = getActiveRealtimeVoiceTurn('session-4');
    expect(retrieved).toBe(ctx);

    // Clean up
    completeRealtimeVoiceTurn(ctx);
  });

  test('creates OTEL span with correct attributes', () => {
    const ctx = startRealtimeVoiceTurn('session-5');
    expect(mockStartSpan).toHaveBeenCalledWith(
      'voice_realtime_turn',
      expect.objectContaining({
        attributes: expect.objectContaining({
          'voice.session_id': 'session-5',
          'voice.mode': 'realtime',
        }),
      }),
    );

    // Clean up
    completeRealtimeVoiceTurn(ctx);
  });

  test('has rootSpan and otelContext', () => {
    const ctx = startRealtimeVoiceTurn('session-6');
    expect(ctx.rootSpan).toBeDefined();
    expect(ctx.otelContext).toBeDefined();

    completeRealtimeVoiceTurn(ctx);
  });

  test('turnStartTime is set', () => {
    const before = Date.now();
    const ctx = startRealtimeVoiceTurn('session-7');
    const after = Date.now();
    expect(ctx.turnStartTime).toBeGreaterThanOrEqual(before);
    expect(ctx.turnStartTime).toBeLessThanOrEqual(after);

    completeRealtimeVoiceTurn(ctx);
  });

  test('successive calls produce different IDs', () => {
    const ctx1 = startRealtimeVoiceTurn('session-unique-1');
    completeRealtimeVoiceTurn(ctx1);
    const ctx2 = startRealtimeVoiceTurn('session-unique-2');
    completeRealtimeVoiceTurn(ctx2);
    expect(ctx1.turnId).not.toBe(ctx2.turnId);
    expect(ctx1.traceId).not.toBe(ctx2.traceId);
  });
});

// =============================================================================
// getActiveRealtimeVoiceTurn
// =============================================================================

describe('getActiveRealtimeVoiceTurn', () => {
  test('returns context for active session', () => {
    const ctx = startRealtimeVoiceTurn('session-active');
    expect(getActiveRealtimeVoiceTurn('session-active')).toBe(ctx);
    completeRealtimeVoiceTurn(ctx);
  });

  test('returns undefined for unknown session', () => {
    expect(getActiveRealtimeVoiceTurn('session-nonexistent')).toBeUndefined();
  });

  test('returns undefined after turn is completed', () => {
    const ctx = startRealtimeVoiceTurn('session-completed');
    completeRealtimeVoiceTurn(ctx);
    expect(getActiveRealtimeVoiceTurn('session-completed')).toBeUndefined();
  });
});

// =============================================================================
// recordRealtimeFirstAudioOut
// =============================================================================

describe('recordRealtimeFirstAudioOut', () => {
  test('sets firstAudioOutTime', () => {
    const ctx = startRealtimeVoiceTurn('session-fao-1');
    expect(ctx.firstAudioOutTime).toBeUndefined();

    recordRealtimeFirstAudioOut(ctx);
    expect(ctx.firstAudioOutTime).toBeDefined();
    expect(typeof ctx.firstAudioOutTime).toBe('number');

    completeRealtimeVoiceTurn(ctx);
  });

  test('sets span attribute voice.realtime.first_audio_out_ms', () => {
    const ctx = startRealtimeVoiceTurn('session-fao-2');
    recordRealtimeFirstAudioOut(ctx);

    expect(mockSetAttribute).toHaveBeenCalledWith(
      'voice.realtime.first_audio_out_ms',
      expect.any(Number),
    );

    completeRealtimeVoiceTurn(ctx);
  });

  test('is idempotent — second call does not overwrite', () => {
    const ctx = startRealtimeVoiceTurn('session-fao-3');
    recordRealtimeFirstAudioOut(ctx);
    const firstTime = ctx.firstAudioOutTime;

    // Clear mock to check it isn't called again
    mockSetAttribute.mockClear();

    recordRealtimeFirstAudioOut(ctx);
    expect(ctx.firstAudioOutTime).toBe(firstTime);
    expect(mockSetAttribute).not.toHaveBeenCalled();

    completeRealtimeVoiceTurn(ctx);
  });
});

// =============================================================================
// recordRealtimeToolCall
// =============================================================================

describe('recordRealtimeToolCall', () => {
  test('increments toolCallCount', () => {
    const ctx = startRealtimeVoiceTurn('session-tc-1');
    expect(ctx.toolCallCount).toBe(0);

    recordRealtimeToolCall(ctx, 'search_flights', 150);
    expect(ctx.toolCallCount).toBe(1);

    recordRealtimeToolCall(ctx, 'get_weather', 200);
    expect(ctx.toolCallCount).toBe(2);

    completeRealtimeVoiceTurn(ctx);
  });

  test('accumulates toolCallLatencyMs', () => {
    const ctx = startRealtimeVoiceTurn('session-tc-2');
    recordRealtimeToolCall(ctx, 'tool_a', 100);
    recordRealtimeToolCall(ctx, 'tool_b', 250);
    expect(ctx.toolCallLatencyMs).toBe(350);

    completeRealtimeVoiceTurn(ctx);
  });

  test('creates and ends a child span', () => {
    const ctx = startRealtimeVoiceTurn('session-tc-3');
    mockStartSpan.mockClear();
    mockSpanEnd.mockClear();

    recordRealtimeToolCall(ctx, 'search_flights', 150);

    // Should have started a child span
    expect(mockStartSpan).toHaveBeenCalledWith(
      'voice_realtime_tool_call',
      expect.objectContaining({
        attributes: expect.objectContaining({
          'voice.turn_id': ctx.turnId,
          'tool.name': 'search_flights',
          'tool.duration_ms': 150,
        }),
      }),
      ctx.otelContext,
    );

    // Child span should be ended immediately
    expect(mockSpanEnd).toHaveBeenCalled();

    completeRealtimeVoiceTurn(ctx);
  });
});

// =============================================================================
// completeRealtimeVoiceTurn
// =============================================================================

describe('completeRealtimeVoiceTurn', () => {
  test('calculates timing breakdown with firstAudioOut', () => {
    const ctx = startRealtimeVoiceTurn('session-ct-1');

    // Simulate some time passing
    recordRealtimeFirstAudioOut(ctx);

    const breakdown = completeRealtimeVoiceTurn(ctx, { inputTokens: 100, outputTokens: 50 });

    expect(breakdown.turnLatency).toBeGreaterThanOrEqual(0);
    expect(breakdown.totalDuration).toBeGreaterThanOrEqual(0);
    expect(breakdown.toolCallOverhead).toBe(0);
    expect(typeof breakdown.audioDurationInMs).toBe('number');
    expect(typeof breakdown.audioDurationOutMs).toBe('number');
  });

  test('turnLatency is 0 when no firstAudioOut', () => {
    const ctx = startRealtimeVoiceTurn('session-ct-2');
    const breakdown = completeRealtimeVoiceTurn(ctx);
    expect(breakdown.turnLatency).toBe(0);
  });

  test('includes tool call overhead in breakdown', () => {
    const ctx = startRealtimeVoiceTurn('session-ct-3');
    recordRealtimeToolCall(ctx, 'tool_a', 100);
    recordRealtimeToolCall(ctx, 'tool_b', 200);

    const breakdown = completeRealtimeVoiceTurn(ctx);
    expect(breakdown.toolCallOverhead).toBe(300);
  });

  test('sets span attributes', () => {
    const ctx = startRealtimeVoiceTurn('session-ct-4');
    mockSetAttributes.mockClear();
    mockSetStatus.mockClear();

    completeRealtimeVoiceTurn(ctx, { inputTokens: 150, outputTokens: 75 });

    expect(mockSetAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'voice.realtime.turn_latency_ms': expect.any(Number),
        'voice.realtime.total_duration_ms': expect.any(Number),
        'voice.realtime.tool_call_count': 0,
        'voice.realtime.tool_call_overhead_ms': 0,
        'voice.realtime.input_tokens': 150,
        'voice.realtime.output_tokens': 75,
        'voice.success': true,
      }),
    );
  });

  test('sets span status to OK', () => {
    const ctx = startRealtimeVoiceTurn('session-ct-5');
    mockSetStatus.mockClear();

    completeRealtimeVoiceTurn(ctx);
    expect(mockSetStatus).toHaveBeenCalledWith({ code: 1 }); // SpanStatusCode.OK
  });

  test('ends the root span', () => {
    const ctx = startRealtimeVoiceTurn('session-ct-6');
    mockSpanEnd.mockClear();

    completeRealtimeVoiceTurn(ctx);
    expect(mockSpanEnd).toHaveBeenCalled();
  });

  test('removes from active turns map', () => {
    const ctx = startRealtimeVoiceTurn('session-ct-7');
    expect(getActiveRealtimeVoiceTurn('session-ct-7')).toBeDefined();

    completeRealtimeVoiceTurn(ctx);
    expect(getActiveRealtimeVoiceTurn('session-ct-7')).toBeUndefined();
  });

  test('usage tokens default to 0 when not provided', () => {
    const ctx = startRealtimeVoiceTurn('session-ct-8');
    mockSetAttributes.mockClear();

    completeRealtimeVoiceTurn(ctx);

    expect(mockSetAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'voice.realtime.input_tokens': 0,
        'voice.realtime.output_tokens': 0,
      }),
    );
  });

  test('sets status to completed', () => {
    const ctx = startRealtimeVoiceTurn('session-ct-9');
    expect(ctx.status).toBe('active');

    completeRealtimeVoiceTurn(ctx);
    expect(ctx.status).toBe('completed');
  });

  test('records inputTokens and outputTokens on context', () => {
    const ctx = startRealtimeVoiceTurn('session-ct-10');
    completeRealtimeVoiceTurn(ctx, { inputTokens: 42, outputTokens: 17 });
    expect(ctx.inputTokens).toBe(42);
    expect(ctx.outputTokens).toBe(17);
  });
});

// =============================================================================
// failRealtimeVoiceTurn
// =============================================================================

describe('failRealtimeVoiceTurn', () => {
  test('sets status to error', () => {
    const ctx = startRealtimeVoiceTurn('session-fail-1');
    failRealtimeVoiceTurn(ctx, 'barge_in');
    expect(ctx.status).toBe('error');
  });

  test('stores error message from string', () => {
    const ctx = startRealtimeVoiceTurn('session-fail-2');
    failRealtimeVoiceTurn(ctx, 'session_stopped');
    expect(ctx.error).toBe('session_stopped');
  });

  test('stores error message from Error object', () => {
    const ctx = startRealtimeVoiceTurn('session-fail-3');
    failRealtimeVoiceTurn(ctx, new Error('connection lost'));
    expect(ctx.error).toBe('connection lost');
  });

  test('sets turnEndTime', () => {
    const ctx = startRealtimeVoiceTurn('session-fail-4');
    failRealtimeVoiceTurn(ctx, 'test');
    expect(ctx.turnEndTime).toBeDefined();
    expect(typeof ctx.turnEndTime).toBe('number');
  });

  test('sets span attributes with duration and error', () => {
    const ctx = startRealtimeVoiceTurn('session-fail-5');
    mockSetAttributes.mockClear();

    failRealtimeVoiceTurn(ctx, 'barge_in');

    expect(mockSetAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'voice.realtime.total_duration_ms': expect.any(Number),
        'voice.success': false,
        'voice.error': 'barge_in',
      }),
    );
  });

  test('sets span status to ERROR', () => {
    const ctx = startRealtimeVoiceTurn('session-fail-6');
    mockSetStatus.mockClear();

    failRealtimeVoiceTurn(ctx, 'test error');
    expect(mockSetStatus).toHaveBeenCalledWith({
      code: 2, // SpanStatusCode.ERROR
      message: 'test error',
    });
  });

  test('ends the root span', () => {
    const ctx = startRealtimeVoiceTurn('session-fail-7');
    mockSpanEnd.mockClear();

    failRealtimeVoiceTurn(ctx, 'test');
    expect(mockSpanEnd).toHaveBeenCalled();
  });

  test('removes from active turns map', () => {
    const ctx = startRealtimeVoiceTurn('session-fail-8');
    expect(getActiveRealtimeVoiceTurn('session-fail-8')).toBeDefined();

    failRealtimeVoiceTurn(ctx, 'test');
    expect(getActiveRealtimeVoiceTurn('session-fail-8')).toBeUndefined();
  });
});

// =============================================================================
// createRealtimeTimingReportEvent
// =============================================================================

describe('createRealtimeTimingReportEvent', () => {
  test('returns event with correct type', () => {
    const ctx = startRealtimeVoiceTurn('session-report-1');
    const breakdown: RealtimeVoiceTimingBreakdown = {
      turnLatency: 150,
      totalDuration: 500,
      toolCallOverhead: 100,
      audioDurationInMs: 2000,
      audioDurationOutMs: 3000,
    };
    completeRealtimeVoiceTurn(ctx, { inputTokens: 10, outputTokens: 20 });

    const event = createRealtimeTimingReportEvent(ctx, breakdown);
    expect(event.type).toBe('voice_realtime_turn_end');
  });

  test('includes durationMs from breakdown', () => {
    const ctx = startRealtimeVoiceTurn('session-report-2');
    const breakdown: RealtimeVoiceTimingBreakdown = {
      turnLatency: 100,
      totalDuration: 400,
      toolCallOverhead: 50,
      audioDurationInMs: 0,
      audioDurationOutMs: 0,
    };
    completeRealtimeVoiceTurn(ctx);

    const event = createRealtimeTimingReportEvent(ctx, breakdown);
    expect(event.durationMs).toBe(400);
  });

  test('includes timing data in event data', () => {
    const ctx = startRealtimeVoiceTurn('session-report-3');
    const breakdown: RealtimeVoiceTimingBreakdown = {
      turnLatency: 120,
      totalDuration: 600,
      toolCallOverhead: 80,
      audioDurationInMs: 1500,
      audioDurationOutMs: 2500,
    };
    completeRealtimeVoiceTurn(ctx, { inputTokens: 50, outputTokens: 30 });

    const event = createRealtimeTimingReportEvent(ctx, breakdown);
    expect(event.data.timing).toEqual({
      turnLatency: 120,
      totalDuration: 600,
      toolCallOverhead: 80,
    });
  });

  test('includes metrics data in event data', () => {
    const ctx = startRealtimeVoiceTurn('session-report-4');
    recordRealtimeToolCall(ctx, 'tool_a', 50);
    const breakdown: RealtimeVoiceTimingBreakdown = {
      turnLatency: 100,
      totalDuration: 300,
      toolCallOverhead: 50,
      audioDurationInMs: 1000,
      audioDurationOutMs: 2000,
    };
    completeRealtimeVoiceTurn(ctx, { inputTokens: 75, outputTokens: 40 });

    const event = createRealtimeTimingReportEvent(ctx, breakdown);
    expect(event.data.metrics).toEqual({
      inputTokens: 75,
      outputTokens: 40,
      toolCallCount: 1,
      audioDurationInMs: 1000,
      audioDurationOutMs: 2000,
    });
  });

  test('includes turnId, traceId, and spanId', () => {
    const ctx = startRealtimeVoiceTurn('session-report-5');
    const breakdown: RealtimeVoiceTimingBreakdown = {
      turnLatency: 0,
      totalDuration: 100,
      toolCallOverhead: 0,
      audioDurationInMs: 0,
      audioDurationOutMs: 0,
    };
    completeRealtimeVoiceTurn(ctx);

    const event = createRealtimeTimingReportEvent(ctx, breakdown);
    expect(event.data.turnId).toBe(ctx.turnId);
    expect(event.data.traceId).toBe(ctx.traceId);
    expect(event.spanId).toBe(ctx.spanId);
  });

  test('includes status and error fields', () => {
    const ctx = startRealtimeVoiceTurn('session-report-6');
    failRealtimeVoiceTurn(ctx, 'connection_lost');
    const breakdown: RealtimeVoiceTimingBreakdown = {
      turnLatency: 0,
      totalDuration: 50,
      toolCallOverhead: 0,
      audioDurationInMs: 0,
      audioDurationOutMs: 0,
    };

    const event = createRealtimeTimingReportEvent(ctx, breakdown);
    expect(event.data.status).toBe('error');
    expect(event.data.error).toBe('connection_lost');
  });

  test('has a timestamp', () => {
    const ctx = startRealtimeVoiceTurn('session-report-7');
    const breakdown: RealtimeVoiceTimingBreakdown = {
      turnLatency: 0,
      totalDuration: 0,
      toolCallOverhead: 0,
      audioDurationInMs: 0,
      audioDurationOutMs: 0,
    };
    completeRealtimeVoiceTurn(ctx);

    const event = createRealtimeTimingReportEvent(ctx, breakdown);
    expect(event.timestamp).toBeInstanceOf(Date);
  });
});
