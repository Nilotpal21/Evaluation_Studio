/**
 * Distributed Voice Trace Manager
 *
 * Production-grade distributed tracing for voice pipeline that integrates
 * with the platform's TraceStore infrastructure.
 *
 * Trace hierarchy:
 *   voice_turn (root span)
 *   ├── voice_stt (Deepgram STT - external API)
 *   │   └── deepgram_api (external call span)
 *   ├── voice_llm (Agent processing)
 *   │   └── llm_call (Anthropic API - uses existing trace)
 *   └── voice_tts (ElevenLabs TTS - external API)
 *       └── elevenlabs_api (external call span)
 *
 * Supports:
 * - Trace context propagation (client → server → external APIs)
 * - HLC timestamps for distributed ordering
 * - Integration with TraceStore for persistence
 * - OTEL span export for production observability
 */

import { randomUUID } from 'crypto';
import { trace, context, SpanStatusCode, type Span, type Context } from '@opentelemetry/api';
import { createLogger } from '@abl/compiler/platform';
import type { Tracer as PlatformTracer } from '@agent-platform/shared-observability/tracing';

const log = createLogger('voice-trace');

// =============================================================================
// TYPES
// =============================================================================

/** Voice pipeline mode */
export type VoiceTraceMode = 'pipeline' | 'realtime';

/** Extended trace event types for voice — canonical source: @agent-platform/shared-kernel */
export type { VoiceTraceEventType } from '@agent-platform/shared-kernel';
import type { VoiceTraceEventType } from '@agent-platform/shared-kernel';

/** Trace context passed from client */
export interface ClientTraceContext {
  traceId?: string;
  spanId?: string;
  clientTimestamp?: number;
}

/** Voice turn trace context */
export interface VoiceTurnContext {
  // Identifiers
  turnId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sessionId: string;

  // OTEL spans
  rootSpan: Span;
  otelContext: Context;

  // Timing (all in epoch ms)
  clientStartTime?: number; // When client detected speech end
  serverReceiveTime: number; // When server received utterance
  sttStartTime?: number;
  sttEndTime?: number;
  llmStartTime?: number;
  llmEndTime?: number;
  ttsStartTime?: number;
  ttsFirstChunkTime?: number;
  ttsEndTime?: number;
  serverCompleteTime?: number; // When server finished processing
  clientAudioStartTime?: number; // When client started playing audio

  // Metrics
  utterance?: string;
  response?: string;
  sttConfidence?: number;
  sttProvider?: string;
  llmModel?: string;
  llmTokensIn?: number;
  llmTokensOut?: number;
  ttsProvider?: string;
  ttsBytes?: number;
  ttsChunks?: number;

  // Child spans
  sttSpan?: Span;
  llmSpan?: Span;
  ttsSpan?: Span;

  // Platform Tracer (coexists with OTEL spans)
  platformTracer?: PlatformTracer;

  // Status
  status: 'active' | 'completed' | 'error';
  error?: string;
}

/** Timing breakdown for analysis */
export interface VoiceTimingBreakdown {
  // End-to-end
  totalLatency: number; // Client speech end → client audio start
  serverProcessingTime: number; // Server receive → server complete

  // Per-phase
  networkToServer?: number; // Client → server (if client timestamp provided)
  sttLatency: number; // STT processing
  llmLatency: number; // LLM processing
  ttsLatency: number; // TTS total
  ttsFirstChunkLatency: number; // TTS time to first audio
  networkToClient?: number; // Server → client (if client timestamp provided)

  // Overhead
  overhead: number; // Time not accounted for in phases
}

/** Trace event for persistence */
export interface VoiceTraceEvent {
  type: VoiceTraceEventType;
  timestamp: Date;
  durationMs?: number;
  data: Record<string, unknown>;
  spanId?: string;
  parentSpanId?: string;
  sequence?: string;
}

// =============================================================================
// OTEL SETUP
// =============================================================================

const tracer = trace.getTracer('voice-pipeline', '1.0.0');

// =============================================================================
// VOICE TURN MANAGER
// =============================================================================

/** Active voice turns by session */
const activeVoiceTurns = new Map<string, VoiceTurnContext>();

/**
 * Start tracking a voice turn.
 * Call this when silence is detected and processing begins.
 */
export function startVoiceTurn(
  sessionId: string,
  utterance: string,
  clientContext?: ClientTraceContext,
  platformTracer?: PlatformTracer,
): VoiceTurnContext {
  const turnId = randomUUID();
  const traceId = clientContext?.traceId || randomUUID();
  const spanId = randomUUID();
  const now = Date.now();

  // Create OTEL root span for this voice turn
  const rootSpan = tracer.startSpan('voice_turn', {
    attributes: {
      'voice.turn_id': turnId,
      'voice.session_id': sessionId,
      'voice.utterance': utterance.substring(0, 500),
      'voice.utterance_length': utterance.length,
      'trace.id': traceId,
    },
  });

  const otelContext = trace.setSpan(context.active(), rootSpan);

  const turnContext: VoiceTurnContext = {
    turnId,
    traceId,
    spanId,
    parentSpanId: clientContext?.spanId,
    sessionId,
    rootSpan,
    otelContext,
    clientStartTime: clientContext?.clientTimestamp,
    serverReceiveTime: now,
    utterance,
    platformTracer,
    status: 'active',
  };

  activeVoiceTurns.set(sessionId, turnContext);

  // Emit platform trace event if tracer available
  platformTracer?.emit({
    type: 'voice_turn_start',
    data: { turnId, traceId, sessionId, utteranceLength: utterance.length },
  });

  log.info('Voice turn started', {
    turnId,
    traceId,
    sessionId,
    clientLatency: clientContext?.clientTimestamp ? now - clientContext.clientTimestamp : undefined,
  });

  return turnContext;
}

/**
 * Get the active voice turn for a session
 */
export function getActiveVoiceTurn(sessionId: string): VoiceTurnContext | undefined {
  return activeVoiceTurns.get(sessionId);
}

// =============================================================================
// PHASE TRACKING
// =============================================================================

/**
 * Start STT phase tracking
 */
export function startSTTPhase(ctx: VoiceTurnContext, provider = 'deepgram'): void {
  ctx.sttStartTime = Date.now();
  ctx.sttProvider = provider;

  ctx.sttSpan = tracer.startSpan(
    'voice_stt',
    {
      attributes: {
        'stt.provider': provider,
        'voice.turn_id': ctx.turnId,
      },
    },
    ctx.otelContext,
  );
}

/**
 * Complete STT phase
 */
export function completeSTTPhase(
  ctx: VoiceTurnContext,
  result: { transcript: string; confidence: number; durationMs?: number },
): void {
  ctx.sttEndTime = Date.now();
  ctx.sttConfidence = result.confidence;

  const duration = result.durationMs || ctx.sttEndTime - (ctx.sttStartTime || ctx.sttEndTime);

  if (ctx.sttSpan) {
    ctx.sttSpan.setAttributes({
      'stt.duration_ms': duration,
      'stt.confidence': result.confidence,
      'stt.transcript_length': result.transcript.length,
    });
    ctx.sttSpan.end();
  }

  ctx.platformTracer?.emit({
    type: 'voice_stt',
    data: { turnId: ctx.turnId, provider: ctx.sttProvider, confidence: result.confidence },
    durationMs: duration,
  });

  log.debug('STT phase complete', {
    turnId: ctx.turnId,
    duration,
    confidence: result.confidence,
  });
}

/**
 * Start LLM phase tracking
 */
export function startLLMPhase(ctx: VoiceTurnContext, model?: string): void {
  ctx.llmStartTime = Date.now();
  ctx.llmModel = model;

  ctx.llmSpan = tracer.startSpan(
    'voice_llm',
    {
      attributes: {
        'llm.model': model || 'unknown',
        'voice.turn_id': ctx.turnId,
      },
    },
    ctx.otelContext,
  );
}

/**
 * Complete LLM phase
 */
export function completeLLMPhase(
  ctx: VoiceTurnContext,
  result: { response: string; tokensIn?: number; tokensOut?: number; durationMs?: number },
): void {
  ctx.llmEndTime = Date.now();
  ctx.response = result.response;
  ctx.llmTokensIn = result.tokensIn;
  ctx.llmTokensOut = result.tokensOut;

  const duration = result.durationMs || ctx.llmEndTime - (ctx.llmStartTime || ctx.llmEndTime);

  if (ctx.llmSpan) {
    ctx.llmSpan.setAttributes({
      'llm.duration_ms': duration,
      'llm.response_length': result.response.length,
      'llm.tokens_in': result.tokensIn || 0,
      'llm.tokens_out': result.tokensOut || 0,
    });
    ctx.llmSpan.end();
  }

  ctx.platformTracer?.emit({
    type: 'voice_llm',
    data: {
      turnId: ctx.turnId,
      model: ctx.llmModel,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
    },
    durationMs: duration,
  });

  log.debug('LLM phase complete', {
    turnId: ctx.turnId,
    duration,
    responseLength: result.response.length,
  });
}

/**
 * Start TTS phase tracking
 */
export function startTTSPhase(ctx: VoiceTurnContext, provider = 'elevenlabs'): void {
  ctx.ttsStartTime = Date.now();
  ctx.ttsProvider = provider;
  ctx.ttsBytes = 0;
  ctx.ttsChunks = 0;

  ctx.ttsSpan = tracer.startSpan(
    'voice_tts',
    {
      attributes: {
        'tts.provider': provider,
        'voice.turn_id': ctx.turnId,
      },
    },
    ctx.otelContext,
  );
}

/**
 * Record first TTS audio chunk (key latency metric)
 */
export function recordTTSFirstChunk(ctx: VoiceTurnContext, chunkSize: number): void {
  if (!ctx.ttsFirstChunkTime) {
    ctx.ttsFirstChunkTime = Date.now();
    const latency = ctx.ttsFirstChunkTime - (ctx.ttsStartTime || ctx.ttsFirstChunkTime);

    if (ctx.ttsSpan) {
      ctx.ttsSpan.setAttribute('tts.first_chunk_latency_ms', latency);
    }

    log.debug('TTS first chunk', {
      turnId: ctx.turnId,
      latency,
      chunkSize,
    });
  }

  ctx.ttsChunks = (ctx.ttsChunks || 0) + 1;
  ctx.ttsBytes = (ctx.ttsBytes || 0) + chunkSize;
}

/**
 * Complete TTS phase
 */
export function completeTTSPhase(ctx: VoiceTurnContext): void {
  ctx.ttsEndTime = Date.now();

  const duration = ctx.ttsEndTime - (ctx.ttsStartTime || ctx.ttsEndTime);

  if (ctx.ttsSpan) {
    ctx.ttsSpan.setAttributes({
      'tts.duration_ms': duration,
      'tts.total_bytes': ctx.ttsBytes || 0,
      'tts.total_chunks': ctx.ttsChunks || 0,
      'tts.first_chunk_latency_ms': ctx.ttsFirstChunkTime
        ? ctx.ttsFirstChunkTime - (ctx.ttsStartTime || 0)
        : 0,
    });
    ctx.ttsSpan.end();
  }

  ctx.platformTracer?.emit({
    type: 'voice_tts',
    data: {
      turnId: ctx.turnId,
      provider: ctx.ttsProvider,
      bytes: ctx.ttsBytes,
      chunks: ctx.ttsChunks,
    },
    durationMs: duration,
  });

  log.debug('TTS phase complete', {
    turnId: ctx.turnId,
    duration,
    bytes: ctx.ttsBytes,
    chunks: ctx.ttsChunks,
  });
}

// =============================================================================
// TURN COMPLETION
// =============================================================================

/**
 * Complete a voice turn successfully
 */
export function completeVoiceTurn(
  ctx: VoiceTurnContext,
  clientAudioStartTime?: number,
): VoiceTimingBreakdown {
  ctx.serverCompleteTime = Date.now();
  ctx.clientAudioStartTime = clientAudioStartTime;
  ctx.status = 'completed';

  // Calculate timing breakdown
  const breakdown = calculateTimingBreakdown(ctx);

  // Set final span attributes
  ctx.rootSpan.setAttributes({
    'voice.total_latency_ms': breakdown.totalLatency,
    'voice.server_processing_ms': breakdown.serverProcessingTime,
    'voice.stt_latency_ms': breakdown.sttLatency,
    'voice.llm_latency_ms': breakdown.llmLatency,
    'voice.tts_latency_ms': breakdown.ttsLatency,
    'voice.tts_first_chunk_ms': breakdown.ttsFirstChunkLatency,
    'voice.overhead_ms': breakdown.overhead,
    'voice.success': true,
  });
  ctx.rootSpan.setStatus({ code: SpanStatusCode.OK });
  ctx.rootSpan.end();

  // Clean up
  activeVoiceTurns.delete(ctx.sessionId);

  ctx.platformTracer?.emit({
    type: 'voice_turn_end',
    data: {
      turnId: ctx.turnId,
      status: 'completed',
      sttLatencyMs: breakdown.sttLatency,
      llmLatencyMs: breakdown.llmLatency,
      ttsLatencyMs: breakdown.ttsLatency,
      overheadMs: breakdown.overhead,
    },
    durationMs: breakdown.totalLatency,
  });

  log.info('Voice turn complete', {
    turnId: ctx.turnId,
    traceId: ctx.traceId,
    breakdown,
  });

  return breakdown;
}

/**
 * Mark a voice turn as failed
 */
export function failVoiceTurn(ctx: VoiceTurnContext, error: Error | string): void {
  ctx.serverCompleteTime = Date.now();
  ctx.status = 'error';
  ctx.error = error instanceof Error ? error.message : error;

  // End any open child spans
  ctx.sttSpan?.end();
  ctx.llmSpan?.end();
  ctx.ttsSpan?.end();

  // Mark root span as error
  ctx.rootSpan.setAttributes({
    'voice.success': false,
    'voice.error': ctx.error,
  });
  ctx.rootSpan.setStatus({
    code: SpanStatusCode.ERROR,
    message: ctx.error,
  });
  ctx.rootSpan.end();

  // Clean up
  activeVoiceTurns.delete(ctx.sessionId);

  ctx.platformTracer?.emit({
    type: 'voice_turn_end',
    data: { turnId: ctx.turnId, status: 'error', error: ctx.error },
  });

  log.error('Voice turn failed', {
    turnId: ctx.turnId,
    traceId: ctx.traceId,
    error: ctx.error,
  });
}

// =============================================================================
// TIMING ANALYSIS
// =============================================================================

/**
 * Calculate timing breakdown from context
 */
function calculateTimingBreakdown(ctx: VoiceTurnContext): VoiceTimingBreakdown {
  const sttLatency = ctx.sttEndTime && ctx.sttStartTime ? ctx.sttEndTime - ctx.sttStartTime : 0;

  const llmLatency = ctx.llmEndTime && ctx.llmStartTime ? ctx.llmEndTime - ctx.llmStartTime : 0;

  const ttsLatency = ctx.ttsEndTime && ctx.ttsStartTime ? ctx.ttsEndTime - ctx.ttsStartTime : 0;

  const ttsFirstChunkLatency =
    ctx.ttsFirstChunkTime && ctx.ttsStartTime ? ctx.ttsFirstChunkTime - ctx.ttsStartTime : 0;

  const serverProcessingTime = ctx.serverCompleteTime
    ? ctx.serverCompleteTime - ctx.serverReceiveTime
    : 0;

  // Calculate network latencies if client timestamps provided
  const networkToServer = ctx.clientStartTime
    ? ctx.serverReceiveTime - ctx.clientStartTime
    : undefined;

  const networkToClient =
    ctx.clientAudioStartTime && ctx.serverCompleteTime
      ? ctx.clientAudioStartTime - ctx.serverCompleteTime
      : undefined;

  // Total latency (end-to-end if we have client times)
  let totalLatency: number;
  if (ctx.clientStartTime && ctx.clientAudioStartTime) {
    totalLatency = ctx.clientAudioStartTime - ctx.clientStartTime;
  } else if (ctx.clientStartTime && ctx.serverCompleteTime) {
    totalLatency = ctx.serverCompleteTime - ctx.clientStartTime;
  } else {
    totalLatency = serverProcessingTime;
  }

  // Overhead = time not accounted for in measured phases
  const overhead = serverProcessingTime - sttLatency - llmLatency - ttsLatency;

  return {
    totalLatency,
    serverProcessingTime,
    networkToServer,
    sttLatency,
    llmLatency,
    ttsLatency,
    ttsFirstChunkLatency,
    networkToClient,
    overhead: Math.max(0, overhead),
  };
}

// =============================================================================
// TRACE EVENT CREATION
// =============================================================================

/**
 * Create a trace event for persistence in TraceStore
 */
export function createVoiceTraceEvent(
  ctx: VoiceTurnContext,
  type: VoiceTraceEventType,
  data: Record<string, unknown>,
  durationMs?: number,
): VoiceTraceEvent {
  return {
    type,
    timestamp: new Date(),
    durationMs,
    data: {
      ...data,
      turnId: ctx.turnId,
      traceId: ctx.traceId,
    },
    spanId: ctx.spanId,
    parentSpanId: ctx.parentSpanId,
  };
}

/**
 * Create the final timing report event
 */
export function createTimingReportEvent(
  ctx: VoiceTurnContext,
  breakdown: VoiceTimingBreakdown,
): VoiceTraceEvent {
  return createVoiceTraceEvent(
    ctx,
    'voice_turn_end',
    {
      utterance: ctx.utterance,
      response: ctx.response,
      timing: {
        total: breakdown.totalLatency,
        serverProcessing: breakdown.serverProcessingTime,
        networkToServer: breakdown.networkToServer,
        stt: breakdown.sttLatency,
        llm: breakdown.llmLatency,
        tts: breakdown.ttsLatency,
        ttsFirstChunk: breakdown.ttsFirstChunkLatency,
        networkToClient: breakdown.networkToClient,
        overhead: breakdown.overhead,
      },
      metrics: {
        sttConfidence: ctx.sttConfidence,
        sttProvider: ctx.sttProvider,
        llmModel: ctx.llmModel,
        llmTokensIn: ctx.llmTokensIn,
        llmTokensOut: ctx.llmTokensOut,
        ttsProvider: ctx.ttsProvider,
        ttsBytes: ctx.ttsBytes,
        ttsChunks: ctx.ttsChunks,
      },
      status: ctx.status,
      error: ctx.error,
    },
    breakdown.totalLatency,
  );
}

// =============================================================================
// REALTIME VOICE TRACING
// =============================================================================

/** Realtime voice turn context — single-model turn, no separate STT/TTS phases */
export interface RealtimeVoiceTurnContext {
  turnId: string;
  traceId: string;
  spanId: string;
  sessionId: string;

  // OTEL
  rootSpan: Span;
  otelContext: Context;

  // Timing
  turnStartTime: number;
  firstAudioOutTime?: number;
  turnEndTime?: number;

  // Metrics
  audioDurationInMs: number;
  audioDurationOutMs: number;
  toolCallCount: number;
  toolCallLatencyMs: number;
  inputTokens?: number;
  outputTokens?: number;

  // Platform Tracer (coexists with OTEL spans)
  platformTracer?: PlatformTracer;

  // Status
  status: 'active' | 'completed' | 'error' | 'interrupted';
  error?: string;
}

/** Timing breakdown for realtime voice turns */
export interface RealtimeVoiceTimingBreakdown {
  turnLatency: number; // turnStart → firstAudioOut
  totalDuration: number; // turnStart → turnEnd
  toolCallOverhead: number; // Total tool call latency
  audioDurationInMs: number; // Total inbound audio duration
  audioDurationOutMs: number; // Total outbound audio duration
}

/** Active realtime voice turns by session */
const activeRealtimeVoiceTurns = new Map<string, RealtimeVoiceTurnContext>();

/**
 * Start tracking a realtime voice turn.
 */
export function startRealtimeVoiceTurn(
  sessionId: string,
  platformTracer?: PlatformTracer,
): RealtimeVoiceTurnContext {
  const turnId = randomUUID();
  const traceId = randomUUID();
  const spanId = randomUUID();
  const now = Date.now();

  const rootSpan = tracer.startSpan('voice_realtime_turn', {
    attributes: {
      'voice.turn_id': turnId,
      'voice.session_id': sessionId,
      'voice.mode': 'realtime',
    },
  });

  const otelContext = trace.setSpan(context.active(), rootSpan);

  const ctx: RealtimeVoiceTurnContext = {
    turnId,
    traceId,
    spanId,
    sessionId,
    rootSpan,
    otelContext,
    turnStartTime: now,
    audioDurationInMs: 0,
    audioDurationOutMs: 0,
    toolCallCount: 0,
    toolCallLatencyMs: 0,
    platformTracer,
    status: 'active',
  };

  activeRealtimeVoiceTurns.set(sessionId, ctx);

  platformTracer?.emit({
    type: 'voice_realtime_turn_start',
    data: { turnId, traceId, sessionId },
  });

  return ctx;
}

/**
 * Record first audio output for latency tracking.
 */
export function recordRealtimeFirstAudioOut(ctx: RealtimeVoiceTurnContext): void {
  if (!ctx.firstAudioOutTime) {
    ctx.firstAudioOutTime = Date.now();
    const latency = ctx.firstAudioOutTime - ctx.turnStartTime;
    ctx.rootSpan.setAttribute('voice.realtime.first_audio_out_ms', latency);
  }
}

/**
 * Record a tool call in a realtime voice turn.
 */
export function recordRealtimeToolCall(
  ctx: RealtimeVoiceTurnContext,
  toolName: string,
  latencyMs: number,
): void {
  ctx.toolCallCount++;
  ctx.toolCallLatencyMs += latencyMs;

  ctx.platformTracer?.emit({
    type: 'voice_realtime_tool_call',
    data: { turnId: ctx.turnId, toolName },
    durationMs: latencyMs,
  });

  tracer
    .startSpan(
      'voice_realtime_tool_call',
      {
        attributes: {
          'voice.turn_id': ctx.turnId,
          'tool.name': toolName,
          'tool.duration_ms': latencyMs,
        },
      },
      ctx.otelContext,
    )
    .end();
}

/**
 * Complete a realtime voice turn.
 */
export function completeRealtimeVoiceTurn(
  ctx: RealtimeVoiceTurnContext,
  usage?: { inputTokens?: number; outputTokens?: number },
): RealtimeVoiceTimingBreakdown {
  ctx.turnEndTime = Date.now();
  ctx.status = 'completed';
  ctx.inputTokens = usage?.inputTokens;
  ctx.outputTokens = usage?.outputTokens;

  const turnLatency = ctx.firstAudioOutTime ? ctx.firstAudioOutTime - ctx.turnStartTime : 0;
  const totalDuration = ctx.turnEndTime - ctx.turnStartTime;

  const breakdown: RealtimeVoiceTimingBreakdown = {
    turnLatency,
    totalDuration,
    toolCallOverhead: ctx.toolCallLatencyMs,
    audioDurationInMs: ctx.audioDurationInMs,
    audioDurationOutMs: ctx.audioDurationOutMs,
  };

  ctx.rootSpan.setAttributes({
    'voice.realtime.turn_latency_ms': turnLatency,
    'voice.realtime.total_duration_ms': totalDuration,
    'voice.realtime.tool_call_count': ctx.toolCallCount,
    'voice.realtime.tool_call_overhead_ms': ctx.toolCallLatencyMs,
    'voice.realtime.input_tokens': ctx.inputTokens || 0,
    'voice.realtime.output_tokens': ctx.outputTokens || 0,
    'voice.success': true,
  });
  ctx.rootSpan.setStatus({ code: SpanStatusCode.OK });
  ctx.rootSpan.end();

  activeRealtimeVoiceTurns.delete(ctx.sessionId);

  ctx.platformTracer?.emit({
    type: 'voice_realtime_turn_end',
    data: {
      turnId: ctx.turnId,
      status: 'completed',
      turnLatencyMs: turnLatency,
      toolCallCount: ctx.toolCallCount,
      inputTokens: ctx.inputTokens,
      outputTokens: ctx.outputTokens,
    },
    durationMs: totalDuration,
  });

  log.info('Realtime voice turn complete', {
    turnId: ctx.turnId,
    turnLatency,
    totalDuration,
    toolCalls: ctx.toolCallCount,
  });

  return breakdown;
}

/**
 * Fail a realtime voice turn (interrupted or errored).
 */
export function failRealtimeVoiceTurn(ctx: RealtimeVoiceTurnContext, error: Error | string): void {
  ctx.turnEndTime = Date.now();
  ctx.status = 'error';
  ctx.error = typeof error === 'string' ? error : error.message;

  ctx.rootSpan.setAttributes({
    'voice.realtime.total_duration_ms': ctx.turnEndTime - ctx.turnStartTime,
    'voice.success': false,
    'voice.error': ctx.error,
  });
  ctx.rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error });
  ctx.rootSpan.end();

  activeRealtimeVoiceTurns.delete(ctx.sessionId);

  ctx.platformTracer?.emit({
    type: 'voice_realtime_turn_end',
    data: { turnId: ctx.turnId, status: 'error', error: ctx.error },
  });

  log.info('Realtime voice turn failed', {
    turnId: ctx.turnId,
    traceId: ctx.traceId,
    error: ctx.error,
  });
}

/**
 * Create a timing report event for a realtime voice turn.
 */
export function createRealtimeTimingReportEvent(
  ctx: RealtimeVoiceTurnContext,
  breakdown: RealtimeVoiceTimingBreakdown,
): VoiceTraceEvent {
  return {
    type: 'voice_realtime_turn_end',
    timestamp: new Date(),
    durationMs: breakdown.totalDuration,
    data: {
      turnId: ctx.turnId,
      traceId: ctx.traceId,
      timing: {
        turnLatency: breakdown.turnLatency,
        totalDuration: breakdown.totalDuration,
        toolCallOverhead: breakdown.toolCallOverhead,
      },
      metrics: {
        inputTokens: ctx.inputTokens,
        outputTokens: ctx.outputTokens,
        toolCallCount: ctx.toolCallCount,
        audioDurationInMs: breakdown.audioDurationInMs,
        audioDurationOutMs: breakdown.audioDurationOutMs,
      },
      status: ctx.status,
      error: ctx.error,
    },
    spanId: ctx.spanId,
  };
}

/**
 * Get the active realtime voice turn for a session.
 */
export function getActiveRealtimeVoiceTurn(
  sessionId: string,
): RealtimeVoiceTurnContext | undefined {
  return activeRealtimeVoiceTurns.get(sessionId);
}

// =============================================================================
// EXPORTS
// =============================================================================
