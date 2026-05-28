/**
 * Voice Trace Platform Tracer Integration Tests
 *
 * Verifies that platformTracer.emit() is called at each voice pipeline phase,
 * graceful no-op when platformTracer is undefined, OTEL spans still function
 * independently, and error paths emit voice_turn_end with error data.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock OTEL API before importing voice-trace
// vi.mock factories are hoisted, so we cannot reference top-level `const` inside them.
// Instead, use vi.hoisted() to create mocks that are available at hoist-time.
const { mockSpanEnd, mockSetAttributes, mockSetAttribute, mockSetStatus, mockStartSpan } =
  vi.hoisted(() => {
    const mockSpanEnd = vi.fn();
    const mockSetAttributes = vi.fn();
    const mockSetAttribute = vi.fn();
    const mockSetStatus = vi.fn();
    const mockStartSpan = vi.fn(() => ({
      end: mockSpanEnd,
      setAttributes: mockSetAttributes,
      setAttribute: mockSetAttribute,
      setStatus: mockSetStatus,
    }));
    return { mockSpanEnd, mockSetAttributes, mockSetAttribute, mockSetStatus, mockStartSpan };
  });

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startSpan: mockStartSpan,
    }),
    setSpan: vi.fn((_span: unknown, ctx: unknown) => ctx),
  },
  context: {
    active: () => ({}),
  },
  metrics: {
    getMeter: () => ({
      createCounter: () => ({ add: vi.fn() }),
    }),
  },
  SpanStatusCode: {
    OK: 1,
    ERROR: 2,
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  startVoiceTurn,
  startSTTPhase,
  completeSTTPhase,
  startLLMPhase,
  completeLLMPhase,
  startTTSPhase,
  completeTTSPhase,
  completeVoiceTurn,
  failVoiceTurn,
  startRealtimeVoiceTurn,
  recordRealtimeToolCall,
  completeRealtimeVoiceTurn,
  failRealtimeVoiceTurn,
} from '../../observability/voice-trace.js';
import type { Tracer } from '@agent-platform/shared-observability/tracing';

function createMockPlatformTracer(): Tracer & {
  emitCalls: Array<{ type: string; data: Record<string, unknown>; durationMs?: number }>;
} {
  const emitCalls: Array<{ type: string; data: Record<string, unknown>; durationMs?: number }> = [];
  return {
    emitCalls,
    emit: vi.fn((event: { type: string; data: Record<string, unknown>; durationMs?: number }) => {
      emitCalls.push(event);
    }),
    startSpan: vi.fn(),
    withSpan: vi.fn(),
    runSync: vi.fn(),
    run: vi.fn(),
    activeSpan: vi.fn(() => null),
    continueFrom: vi.fn(),
  } as unknown as Tracer & {
    emitCalls: Array<{ type: string; data: Record<string, unknown>; durationMs?: number }>;
  };
}

describe('Voice Trace Platform Tracer Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('pipeline mode — platformTracer.emit() called at each phase', () => {
    it('emits voice_turn_start on startVoiceTurn', () => {
      const tracer = createMockPlatformTracer();
      const ctx = startVoiceTurn('session-1', 'hello world', undefined, tracer);

      expect(tracer.emit).toHaveBeenCalledOnce();
      expect(tracer.emitCalls[0].type).toBe('voice_turn_start');
      expect(tracer.emitCalls[0].data).toMatchObject({
        turnId: ctx.turnId,
        sessionId: 'session-1',
      });
    });

    it('emits voice_stt on completeSTTPhase', () => {
      const tracer = createMockPlatformTracer();
      const ctx = startVoiceTurn('session-stt', 'test', undefined, tracer);
      startSTTPhase(ctx, 'deepgram');
      completeSTTPhase(ctx, { transcript: 'hello', confidence: 0.95 });

      const sttEvent = tracer.emitCalls.find((e) => e.type === 'voice_stt');
      expect(sttEvent).toBeDefined();
      expect(sttEvent!.data).toMatchObject({
        turnId: ctx.turnId,
        provider: 'deepgram',
        confidence: 0.95,
      });
      expect(typeof sttEvent!.durationMs).toBe('number');
    });

    it('emits voice_llm on completeLLMPhase', () => {
      const tracer = createMockPlatformTracer();
      const ctx = startVoiceTurn('session-llm', 'test', undefined, tracer);
      startLLMPhase(ctx, 'claude-3');
      completeLLMPhase(ctx, { response: 'Hi there', tokensIn: 10, tokensOut: 5 });

      const llmEvent = tracer.emitCalls.find((e) => e.type === 'voice_llm');
      expect(llmEvent).toBeDefined();
      expect(llmEvent!.data).toMatchObject({
        turnId: ctx.turnId,
        model: 'claude-3',
        tokensIn: 10,
        tokensOut: 5,
      });
    });

    it('emits voice_tts on completeTTSPhase', () => {
      const tracer = createMockPlatformTracer();
      const ctx = startVoiceTurn('session-tts', 'test', undefined, tracer);
      startTTSPhase(ctx, 'elevenlabs');
      ctx.ttsBytes = 4096;
      ctx.ttsChunks = 3;
      completeTTSPhase(ctx);

      const ttsEvent = tracer.emitCalls.find((e) => e.type === 'voice_tts');
      expect(ttsEvent).toBeDefined();
      expect(ttsEvent!.data).toMatchObject({
        turnId: ctx.turnId,
        provider: 'elevenlabs',
        bytes: 4096,
        chunks: 3,
      });
    });

    it('emits voice_turn_end on completeVoiceTurn', () => {
      const tracer = createMockPlatformTracer();
      const ctx = startVoiceTurn('session-end', 'test', undefined, tracer);
      startSTTPhase(ctx);
      completeSTTPhase(ctx, { transcript: 'hi', confidence: 0.9 });
      startLLMPhase(ctx);
      completeLLMPhase(ctx, { response: 'hello' });
      startTTSPhase(ctx);
      completeTTSPhase(ctx);
      completeVoiceTurn(ctx);

      const endEvent = tracer.emitCalls.find((e) => e.type === 'voice_turn_end');
      expect(endEvent).toBeDefined();
      expect(endEvent!.data).toMatchObject({
        turnId: ctx.turnId,
        status: 'completed',
      });
      expect(typeof endEvent!.durationMs).toBe('number');
    });
  });

  describe('graceful when platformTracer is undefined', () => {
    it('startVoiceTurn works without platformTracer', () => {
      const ctx = startVoiceTurn('session-no-tracer', 'hello');
      expect(ctx).toBeDefined();
      expect(ctx.turnId).toBeDefined();
      expect(ctx.platformTracer).toBeUndefined();
    });

    it('full pipeline works without platformTracer — no errors', () => {
      const ctx = startVoiceTurn('session-no-tracer-2', 'test');
      startSTTPhase(ctx);
      completeSTTPhase(ctx, { transcript: 'hi', confidence: 0.9 });
      startLLMPhase(ctx);
      completeLLMPhase(ctx, { response: 'hello' });
      startTTSPhase(ctx);
      completeTTSPhase(ctx);
      const breakdown = completeVoiceTurn(ctx);

      expect(breakdown).toBeDefined();
      expect(breakdown.totalLatency).toBeGreaterThanOrEqual(0);
    });

    it('failVoiceTurn works without platformTracer', () => {
      const ctx = startVoiceTurn('session-fail-no-tracer', 'test');
      expect(() => failVoiceTurn(ctx, new Error('test error'))).not.toThrow();
    });
  });

  describe('OTEL spans function independently of platformTracer', () => {
    it('creates OTEL root span on startVoiceTurn', () => {
      startVoiceTurn('session-otel', 'hello');
      expect(mockStartSpan).toHaveBeenCalledWith(
        'voice_turn',
        expect.objectContaining({
          attributes: expect.objectContaining({
            'voice.session_id': 'session-otel',
          }),
        }),
      );
    });

    it('creates OTEL child spans for STT/LLM/TTS phases', () => {
      const ctx = startVoiceTurn('session-otel-children', 'test');
      mockStartSpan.mockClear();

      startSTTPhase(ctx, 'deepgram');
      expect(mockStartSpan).toHaveBeenCalledWith(
        'voice_stt',
        expect.objectContaining({
          attributes: expect.objectContaining({ 'stt.provider': 'deepgram' }),
        }),
        expect.anything(),
      );

      mockStartSpan.mockClear();
      startLLMPhase(ctx, 'gpt-4');
      expect(mockStartSpan).toHaveBeenCalledWith(
        'voice_llm',
        expect.objectContaining({
          attributes: expect.objectContaining({ 'llm.model': 'gpt-4' }),
        }),
        expect.anything(),
      );

      mockStartSpan.mockClear();
      startTTSPhase(ctx, 'elevenlabs');
      expect(mockStartSpan).toHaveBeenCalledWith(
        'voice_tts',
        expect.objectContaining({
          attributes: expect.objectContaining({ 'tts.provider': 'elevenlabs' }),
        }),
        expect.anything(),
      );
    });

    it('ends OTEL root span on completeVoiceTurn', () => {
      const ctx = startVoiceTurn('session-otel-end', 'test');
      completeVoiceTurn(ctx);
      // rootSpan.end() should have been called
      expect(mockSpanEnd).toHaveBeenCalled();
      expect(mockSetStatus).toHaveBeenCalledWith(
        expect.objectContaining({ code: 1 }), // SpanStatusCode.OK
      );
    });
  });

  describe('error paths emit voice_turn_end with error data', () => {
    it('failVoiceTurn emits voice_turn_end with error status via platformTracer', () => {
      const tracer = createMockPlatformTracer();
      const ctx = startVoiceTurn('session-error', 'test', undefined, tracer);
      failVoiceTurn(ctx, new Error('STT timeout'));

      const endEvent = tracer.emitCalls.find((e) => e.type === 'voice_turn_end');
      expect(endEvent).toBeDefined();
      expect(endEvent!.data).toMatchObject({
        turnId: ctx.turnId,
        status: 'error',
        error: 'STT timeout',
      });
    });

    it('failVoiceTurn with string error', () => {
      const tracer = createMockPlatformTracer();
      const ctx = startVoiceTurn('session-error-str', 'test', undefined, tracer);
      failVoiceTurn(ctx, 'network failure');

      const endEvent = tracer.emitCalls.find((e) => e.type === 'voice_turn_end');
      expect(endEvent!.data.error).toBe('network failure');
    });

    it('failVoiceTurn sets OTEL span error status', () => {
      const ctx = startVoiceTurn('session-otel-error', 'test');
      failVoiceTurn(ctx, 'boom');

      expect(mockSetStatus).toHaveBeenCalledWith(
        expect.objectContaining({ code: 2, message: 'boom' }), // SpanStatusCode.ERROR
      );
    });

    it('failVoiceTurn ends open child spans', () => {
      const ctx = startVoiceTurn('session-child-end', 'test');
      startSTTPhase(ctx);
      // Don't complete STT — simulate failure mid-pipeline
      failVoiceTurn(ctx, 'crash');

      // sttSpan.end() and rootSpan.end() should both be called
      // mockSpanEnd is shared across all mock spans, so it should have been called multiple times
      expect(mockSpanEnd.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('realtime mode — platformTracer integration', () => {
    it('emits voice_realtime_turn_start', () => {
      const tracer = createMockPlatformTracer();
      const ctx = startRealtimeVoiceTurn('rt-session-1', tracer);

      expect(tracer.emitCalls[0].type).toBe('voice_realtime_turn_start');
      expect(tracer.emitCalls[0].data).toMatchObject({
        turnId: ctx.turnId,
        sessionId: 'rt-session-1',
      });
    });

    it('emits voice_realtime_tool_call on recordRealtimeToolCall', () => {
      const tracer = createMockPlatformTracer();
      const ctx = startRealtimeVoiceTurn('rt-session-tool', tracer);
      recordRealtimeToolCall(ctx, 'search', 150);

      const toolEvent = tracer.emitCalls.find((e) => e.type === 'voice_realtime_tool_call');
      expect(toolEvent).toBeDefined();
      expect(toolEvent!.data).toMatchObject({ toolName: 'search' });
      expect(toolEvent!.durationMs).toBe(150);
    });

    it('emits voice_realtime_turn_end on complete', () => {
      const tracer = createMockPlatformTracer();
      const ctx = startRealtimeVoiceTurn('rt-session-end', tracer);
      completeRealtimeVoiceTurn(ctx, { inputTokens: 100, outputTokens: 50 });

      const endEvent = tracer.emitCalls.find((e) => e.type === 'voice_realtime_turn_end');
      expect(endEvent).toBeDefined();
      expect(endEvent!.data).toMatchObject({
        status: 'completed',
        inputTokens: 100,
        outputTokens: 50,
      });
    });

    it('emits voice_realtime_turn_end with error on fail', () => {
      const tracer = createMockPlatformTracer();
      const ctx = startRealtimeVoiceTurn('rt-session-fail', tracer);
      failRealtimeVoiceTurn(ctx, 'connection lost');

      const endEvent = tracer.emitCalls.find((e) => e.type === 'voice_realtime_turn_end');
      expect(endEvent).toBeDefined();
      expect(endEvent!.data).toMatchObject({
        status: 'error',
        error: 'connection lost',
      });
    });

    it('works without platformTracer in realtime mode', () => {
      const ctx = startRealtimeVoiceTurn('rt-no-tracer');
      expect(ctx.platformTracer).toBeUndefined();
      expect(() => completeRealtimeVoiceTurn(ctx)).not.toThrow();
    });
  });
});
