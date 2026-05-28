/**
 * LiveKit Trace Hooks
 *
 * Maps LiveKit agent pipeline events to the platform's voice-trace functions
 * for unified observability across both WS and LiveKit voice pipelines.
 */

import { createLogger } from '@abl/compiler/platform';
import {
  startVoiceTurn,
  startSTTPhase,
  completeSTTPhase,
  startLLMPhase,
  completeLLMPhase,
  startTTSPhase,
  recordTTSFirstChunk,
  completeTTSPhase,
  completeVoiceTurn,
  failVoiceTurn,
  createTimingReportEvent,
  type VoiceTurnContext,
} from '../../../observability/voice-trace.js';

const log = createLogger('livekit-trace');

// =============================================================================
// TRACE HOOK HELPERS
// =============================================================================

/**
 * Start a traced voice turn for a LiveKit session.
 */
export function traceLiveKitTurnStart(sessionId: string, utterance: string): VoiceTurnContext {
  return startVoiceTurn(sessionId, utterance, {
    traceId: undefined,
    spanId: undefined,
    clientTimestamp: Date.now(),
  });
}

/**
 * Trace STT completion from LiveKit's Deepgram plugin.
 */
export function traceLiveKitSTT(
  ctx: VoiceTurnContext,
  transcript: string,
  confidence: number,
  durationMs: number,
): void {
  startSTTPhase(ctx, 'deepgram');
  completeSTTPhase(ctx, { transcript, confidence, durationMs });
}

/**
 * Trace LLM (RuntimeExecutor) start.
 */
export function traceLiveKitLLMStart(ctx: VoiceTurnContext): void {
  startLLMPhase(ctx, 'runtime-executor');
}

/**
 * Trace LLM (RuntimeExecutor) completion.
 */
export function traceLiveKitLLMEnd(
  ctx: VoiceTurnContext,
  response: string,
  durationMs?: number,
): void {
  completeLLMPhase(ctx, { response, durationMs });
}

/**
 * Trace TTS start from LiveKit's ElevenLabs plugin.
 */
export function traceLiveKitTTSStart(ctx: VoiceTurnContext): void {
  startTTSPhase(ctx, 'elevenlabs');
}

/**
 * Record first TTS audio chunk.
 */
export function traceLiveKitTTSFirstChunk(ctx: VoiceTurnContext, chunkSize: number): void {
  recordTTSFirstChunk(ctx, chunkSize);
}

/**
 * Trace TTS completion.
 */
export function traceLiveKitTTSEnd(ctx: VoiceTurnContext): void {
  completeTTSPhase(ctx);
}

/**
 * Complete a voice turn and return the timing breakdown.
 */
export function traceLiveKitTurnComplete(ctx: VoiceTurnContext) {
  const breakdown = completeVoiceTurn(ctx);
  const report = createTimingReportEvent(ctx, breakdown);

  log.info('LiveKit voice turn complete', {
    turnId: ctx.turnId,
    totalLatency: breakdown.totalLatency,
    stt: breakdown.sttLatency,
    llm: breakdown.llmLatency,
    tts: breakdown.ttsLatency,
  });

  return { breakdown, report };
}

/**
 * Mark a voice turn as failed.
 */
export function traceLiveKitTurnFailed(ctx: VoiceTurnContext, error: Error | string): void {
  failVoiceTurn(ctx, error);
}
