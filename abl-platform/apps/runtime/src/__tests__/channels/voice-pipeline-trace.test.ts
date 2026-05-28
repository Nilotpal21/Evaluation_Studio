/**
 * Voice Pipeline Trace Tests
 *
 * Tests the pipeline (non-realtime) voice tracing functions:
 * - startVoiceTurn / getActiveVoiceTurn
 * - startSTTPhase / completeSTTPhase
 * - startLLMPhase / completeLLMPhase
 * - startTTSPhase / recordTTSFirstChunk / completeTTSPhase
 * - completeVoiceTurn / failVoiceTurn
 * - createVoiceTraceEvent / createTimingReportEvent
 * - calculateTimingBreakdown (indirectly via completeVoiceTurn)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// OTEL mock
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
  startVoiceTurn,
  getActiveVoiceTurn,
  startSTTPhase,
  completeSTTPhase,
  startLLMPhase,
  completeLLMPhase,
  startTTSPhase,
  recordTTSFirstChunk,
  completeTTSPhase,
  completeVoiceTurn,
  failVoiceTurn,
  createVoiceTraceEvent,
  createTimingReportEvent,
  type VoiceTurnContext,
} from '../../observability/voice-trace.js';

// Helper to create a valid context for phase tests
function createTestContext(sessionId = 'sess-pipeline'): VoiceTurnContext {
  return startVoiceTurn(sessionId, 'hello world', {
    traceId: 'trace-test',
    spanId: 'parent-span',
    clientTimestamp: Date.now() - 50,
  });
}

describe('startVoiceTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns context with unique IDs', () => {
    const ctx = startVoiceTurn('sess-1', 'hello');
    expect(ctx.turnId).toBeDefined();
    expect(ctx.traceId).toBeDefined();
    expect(ctx.spanId).toBeDefined();
    expect(ctx.sessionId).toBe('sess-1');
    expect(ctx.status).toBe('active');
  });

  test('uses client-provided traceId when available', () => {
    const ctx = startVoiceTurn('sess-1', 'hello', { traceId: 'client-trace' });
    expect(ctx.traceId).toBe('client-trace');
  });

  test('generates traceId when not provided by client', () => {
    const ctx = startVoiceTurn('sess-1', 'hello');
    expect(ctx.traceId).toBeDefined();
    expect(ctx.traceId).toMatch(/^[0-9a-f-]+$/);
  });

  test('stores client timestamps', () => {
    const now = Date.now();
    const ctx = startVoiceTurn('sess-1', 'hello', {
      clientTimestamp: now,
      spanId: 'parent-span',
    });
    expect(ctx.clientStartTime).toBe(now);
    expect(ctx.parentSpanId).toBe('parent-span');
  });

  test('stores utterance', () => {
    const ctx = startVoiceTurn('sess-1', 'test utterance');
    expect(ctx.utterance).toBe('test utterance');
  });

  test('creates OTEL root span', () => {
    startVoiceTurn('sess-1', 'hello');
    expect(mockStartSpan).toHaveBeenCalledWith(
      'voice_turn',
      expect.objectContaining({
        attributes: expect.objectContaining({
          'voice.session_id': 'sess-1',
        }),
      }),
    );
  });

  test('emits platform trace event when platformTracer provided', () => {
    const platformTracer = { emit: vi.fn(), startSpan: vi.fn(), activeSpan: vi.fn() };
    startVoiceTurn('sess-1', 'hello', undefined, platformTracer as any);
    expect(platformTracer.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'voice_turn_start' }),
    );
  });
});

describe('getActiveVoiceTurn', () => {
  test('returns context for active session', () => {
    const ctx = startVoiceTurn('sess-active', 'hello');
    expect(getActiveVoiceTurn('sess-active')).toBe(ctx);
  });

  test('returns undefined for unknown session', () => {
    expect(getActiveVoiceTurn('unknown')).toBeUndefined();
  });
});

describe('STT phase', () => {
  test('startSTTPhase sets sttStartTime and provider', () => {
    const ctx = createTestContext('sess-stt');
    startSTTPhase(ctx, 'whisper');
    expect(ctx.sttStartTime).toBeDefined();
    expect(ctx.sttProvider).toBe('whisper');
  });

  test('startSTTPhase defaults to deepgram provider', () => {
    const ctx = createTestContext('sess-stt-default');
    startSTTPhase(ctx);
    expect(ctx.sttProvider).toBe('deepgram');
  });

  test('completeSTTPhase sets sttEndTime and confidence', () => {
    const ctx = createTestContext('sess-stt-complete');
    startSTTPhase(ctx);
    completeSTTPhase(ctx, { transcript: 'hello', confidence: 0.95 });
    expect(ctx.sttEndTime).toBeDefined();
    expect(ctx.sttConfidence).toBe(0.95);
  });

  test('completeSTTPhase uses provided durationMs', () => {
    const ctx = createTestContext('sess-stt-dur');
    startSTTPhase(ctx);
    completeSTTPhase(ctx, { transcript: 'hello', confidence: 0.9, durationMs: 200 });
    // Span attributes should reflect the provided duration
    expect(mockSetAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ 'stt.duration_ms': 200 }),
    );
  });

  test('completeSTTPhase ends the STT span', () => {
    const ctx = createTestContext('sess-stt-span');
    startSTTPhase(ctx);
    completeSTTPhase(ctx, { transcript: 'hello', confidence: 0.9 });
    expect(mockSpanEnd).toHaveBeenCalled();
  });

  test('completeSTTPhase emits platform tracer event', () => {
    const platformTracer = { emit: vi.fn(), startSpan: vi.fn(), activeSpan: vi.fn() };
    const ctx = startVoiceTurn('sess-stt-platform', 'hello', undefined, platformTracer as any);
    platformTracer.emit.mockClear();
    startSTTPhase(ctx);
    completeSTTPhase(ctx, { transcript: 'hello', confidence: 0.95 });
    expect(platformTracer.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'voice_stt' }),
    );
  });
});

describe('LLM phase', () => {
  test('startLLMPhase sets llmStartTime and model', () => {
    const ctx = createTestContext('sess-llm');
    startLLMPhase(ctx, 'claude-3');
    expect(ctx.llmStartTime).toBeDefined();
    expect(ctx.llmModel).toBe('claude-3');
  });

  test('startLLMPhase defaults model to unknown', () => {
    const ctx = createTestContext('sess-llm-default');
    startLLMPhase(ctx);
    expect(ctx.llmModel).toBeUndefined();
  });

  test('completeLLMPhase sets response and token counts', () => {
    const ctx = createTestContext('sess-llm-complete');
    startLLMPhase(ctx, 'claude-3');
    completeLLMPhase(ctx, { response: 'Hi there', tokensIn: 10, tokensOut: 5 });
    expect(ctx.llmEndTime).toBeDefined();
    expect(ctx.response).toBe('Hi there');
    expect(ctx.llmTokensIn).toBe(10);
    expect(ctx.llmTokensOut).toBe(5);
  });

  test('completeLLMPhase ends the LLM span', () => {
    const ctx = createTestContext('sess-llm-span');
    startLLMPhase(ctx);
    mockSpanEnd.mockClear();
    completeLLMPhase(ctx, { response: 'resp' });
    expect(mockSpanEnd).toHaveBeenCalled();
  });

  test('completeLLMPhase emits platform tracer event', () => {
    const platformTracer = { emit: vi.fn(), startSpan: vi.fn(), activeSpan: vi.fn() };
    const ctx = startVoiceTurn('sess-llm-platform', 'hello', undefined, platformTracer as any);
    platformTracer.emit.mockClear();
    startLLMPhase(ctx, 'claude');
    completeLLMPhase(ctx, { response: 'resp', tokensIn: 5, tokensOut: 3 });
    expect(platformTracer.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'voice_llm' }),
    );
  });
});

describe('TTS phase', () => {
  test('startTTSPhase sets ttsStartTime and provider', () => {
    const ctx = createTestContext('sess-tts');
    startTTSPhase(ctx, 'elevenlabs');
    expect(ctx.ttsStartTime).toBeDefined();
    expect(ctx.ttsProvider).toBe('elevenlabs');
    expect(ctx.ttsBytes).toBe(0);
    expect(ctx.ttsChunks).toBe(0);
  });

  test('startTTSPhase defaults to elevenlabs provider', () => {
    const ctx = createTestContext('sess-tts-default');
    startTTSPhase(ctx);
    expect(ctx.ttsProvider).toBe('elevenlabs');
  });

  test('recordTTSFirstChunk sets firstChunkTime on first call', () => {
    const ctx = createTestContext('sess-tts-chunk');
    startTTSPhase(ctx);
    recordTTSFirstChunk(ctx, 1024);
    expect(ctx.ttsFirstChunkTime).toBeDefined();
    expect(ctx.ttsChunks).toBe(1);
    expect(ctx.ttsBytes).toBe(1024);
  });

  test('recordTTSFirstChunk is idempotent for firstChunkTime', () => {
    const ctx = createTestContext('sess-tts-idem');
    startTTSPhase(ctx);
    recordTTSFirstChunk(ctx, 1024);
    const firstTime = ctx.ttsFirstChunkTime;
    recordTTSFirstChunk(ctx, 2048);
    expect(ctx.ttsFirstChunkTime).toBe(firstTime);
    expect(ctx.ttsChunks).toBe(2);
    expect(ctx.ttsBytes).toBe(3072);
  });

  test('completeTTSPhase ends the TTS span', () => {
    const ctx = createTestContext('sess-tts-span');
    startTTSPhase(ctx);
    mockSpanEnd.mockClear();
    completeTTSPhase(ctx);
    expect(ctx.ttsEndTime).toBeDefined();
    expect(mockSpanEnd).toHaveBeenCalled();
  });

  test('completeTTSPhase emits platform tracer event', () => {
    const platformTracer = { emit: vi.fn(), startSpan: vi.fn(), activeSpan: vi.fn() };
    const ctx = startVoiceTurn('sess-tts-platform', 'hello', undefined, platformTracer as any);
    platformTracer.emit.mockClear();
    startTTSPhase(ctx);
    completeTTSPhase(ctx);
    expect(platformTracer.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'voice_tts' }),
    );
  });
});

describe('completeVoiceTurn', () => {
  test('returns timing breakdown', () => {
    const ctx = createTestContext('sess-complete');
    startSTTPhase(ctx);
    completeSTTPhase(ctx, { transcript: 'hello', confidence: 0.9 });
    startLLMPhase(ctx, 'claude');
    completeLLMPhase(ctx, { response: 'hi', tokensIn: 5, tokensOut: 3 });
    startTTSPhase(ctx);
    completeTTSPhase(ctx);

    const breakdown = completeVoiceTurn(ctx);

    expect(breakdown.sttLatency).toBeGreaterThanOrEqual(0);
    expect(breakdown.llmLatency).toBeGreaterThanOrEqual(0);
    expect(breakdown.ttsLatency).toBeGreaterThanOrEqual(0);
    expect(breakdown.serverProcessingTime).toBeGreaterThanOrEqual(0);
    expect(breakdown.overhead).toBeGreaterThanOrEqual(0);
  });

  test('sets status to completed', () => {
    const ctx = createTestContext('sess-status');
    completeVoiceTurn(ctx);
    expect(ctx.status).toBe('completed');
  });

  test('ends the root span', () => {
    const ctx = createTestContext('sess-root-span');
    mockSpanEnd.mockClear();
    completeVoiceTurn(ctx);
    expect(mockSpanEnd).toHaveBeenCalled();
  });

  test('calculates totalLatency with client timestamps', () => {
    const now = Date.now();
    const ctx = startVoiceTurn('sess-client-ts', 'hello', {
      traceId: 'trace-1',
      clientTimestamp: now - 200,
    });
    const breakdown = completeVoiceTurn(ctx, now);
    // totalLatency = clientAudioStartTime - clientStartTime = now - (now - 200) = 200
    expect(breakdown.totalLatency).toBe(200);
    expect(breakdown.networkToServer).toBeDefined();
    expect(breakdown.networkToClient).toBeDefined();
  });

  test('calculates totalLatency without clientAudioStartTime', () => {
    const now = Date.now();
    const ctx = startVoiceTurn('sess-no-audio', 'hello', {
      clientTimestamp: now - 100,
    });
    const breakdown = completeVoiceTurn(ctx);
    // Should fall back to serverCompleteTime - clientStartTime
    expect(breakdown.totalLatency).toBeGreaterThanOrEqual(0);
  });

  test('removes session from active turns', () => {
    const ctx = createTestContext('sess-remove');
    completeVoiceTurn(ctx);
    expect(getActiveVoiceTurn('sess-remove')).toBeUndefined();
  });

  test('emits platform tracer event', () => {
    const platformTracer = { emit: vi.fn(), startSpan: vi.fn(), activeSpan: vi.fn() };
    const ctx = startVoiceTurn('sess-complete-pt', 'hello', undefined, platformTracer as any);
    platformTracer.emit.mockClear();
    completeVoiceTurn(ctx);
    expect(platformTracer.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'voice_turn_end' }),
    );
  });
});

describe('failVoiceTurn', () => {
  test('sets status to error with Error object', () => {
    const ctx = createTestContext('sess-fail-err');
    failVoiceTurn(ctx, new Error('timeout'));
    expect(ctx.status).toBe('error');
    expect(ctx.error).toBe('timeout');
  });

  test('sets status to error with string', () => {
    const ctx = createTestContext('sess-fail-str');
    failVoiceTurn(ctx, 'connection lost');
    expect(ctx.status).toBe('error');
    expect(ctx.error).toBe('connection lost');
  });

  test('ends child spans if open', () => {
    const ctx = createTestContext('sess-fail-spans');
    startSTTPhase(ctx);
    startLLMPhase(ctx);
    startTTSPhase(ctx);
    mockSpanEnd.mockClear();
    failVoiceTurn(ctx, 'error');
    // Should end sttSpan, llmSpan, ttsSpan, rootSpan = 4 calls
    expect(mockSpanEnd).toHaveBeenCalledTimes(4);
  });

  test('removes session from active turns', () => {
    const ctx = createTestContext('sess-fail-remove');
    failVoiceTurn(ctx, 'error');
    expect(getActiveVoiceTurn('sess-fail-remove')).toBeUndefined();
  });

  test('emits platform tracer event', () => {
    const platformTracer = { emit: vi.fn(), startSpan: vi.fn(), activeSpan: vi.fn() };
    const ctx = startVoiceTurn('sess-fail-pt', 'hello', undefined, platformTracer as any);
    platformTracer.emit.mockClear();
    failVoiceTurn(ctx, 'error');
    expect(platformTracer.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'voice_turn_end',
        data: expect.objectContaining({ status: 'error' }),
      }),
    );
  });
});

describe('createVoiceTraceEvent', () => {
  test('creates event with correct structure', () => {
    const ctx = createTestContext('sess-create-evt');
    const event = createVoiceTraceEvent(ctx, 'voice_stt', { provider: 'deepgram' }, 150);

    expect(event.type).toBe('voice_stt');
    expect(event.durationMs).toBe(150);
    expect(event.data.turnId).toBe(ctx.turnId);
    expect(event.data.traceId).toBe(ctx.traceId);
    expect(event.data.provider).toBe('deepgram');
    expect(event.spanId).toBe(ctx.spanId);
    expect(event.parentSpanId).toBe(ctx.parentSpanId);
    expect(event.timestamp).toBeInstanceOf(Date);
  });
});

describe('createTimingReportEvent', () => {
  test('creates timing report with all fields', () => {
    const ctx = createTestContext('sess-timing');
    startSTTPhase(ctx);
    completeSTTPhase(ctx, { transcript: 'hello', confidence: 0.95 });
    startLLMPhase(ctx, 'claude');
    completeLLMPhase(ctx, { response: 'hi', tokensIn: 10, tokensOut: 5 });
    startTTSPhase(ctx);
    recordTTSFirstChunk(ctx, 1024);
    completeTTSPhase(ctx);

    const breakdown = completeVoiceTurn(ctx);
    // Need a fresh context for createTimingReportEvent
    const ctx2 = createTestContext('sess-timing-2');
    ctx2.response = 'hi';
    ctx2.sttConfidence = 0.95;
    ctx2.sttProvider = 'deepgram';
    ctx2.llmModel = 'claude';
    ctx2.llmTokensIn = 10;
    ctx2.llmTokensOut = 5;
    ctx2.ttsProvider = 'elevenlabs';
    ctx2.ttsBytes = 1024;
    ctx2.ttsChunks = 1;
    ctx2.status = 'completed';

    const event = createTimingReportEvent(ctx2, breakdown);

    expect(event.type).toBe('voice_turn_end');
    expect(event.durationMs).toBe(breakdown.totalLatency);
    expect(event.data).toHaveProperty('timing');
    expect(event.data).toHaveProperty('metrics');
    expect(event.data).toHaveProperty('status', 'completed');
  });
});
