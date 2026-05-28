/**
 * Voice event schemas.
 *
 * Events related to realtime voice sessions.
 */

import { z } from 'zod';
import { eventRegistry } from '../event-registry.js';
import { EVENT_CATEGORIES } from '../event-categories.js';

// ─── voice.session.started ─────────────────────────────────────────────────

export const VoiceSessionStartedDataSchema = z
  .object({
    voice_provider: z.enum(['twilio', 'korevg', 'livekit']).nullish(),
    voiceProvider: z.enum(['twilio', 'korevg', 'livekit']).nullish(),
    direction: z.enum(['inbound', 'outbound']).nullish(),
    call_sid: z.string().nullish(),
    callSid: z.string().nullish(),
    caller: z.string().nullish(),
    called: z.string().nullish(),
    sip_call_id: z.string().nullish(),
    sipCallId: z.string().nullish(),
    rtp_call_id: z.string().nullish(),
    rtpCallId: z.string().nullish(),
    caller_name: z.string().nullish(),
    callerName: z.string().nullish(),
    originating_sip_ip: z.string().nullish(),
    originatingSipIp: z.string().nullish(),
  })
  .passthrough();

eventRegistry.register('voice.session.started', VoiceSessionStartedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.VOICE,
  containsPII: true, // call_sid, caller, called may be PII
  description: 'Voice session initiated',
});

// ─── voice.session.ended ───────────────────────────────────────────────────

export const VoiceSessionEndedDataSchema = z
  .object({
    call_duration_ms: z.number().nullish(),
    callDurationMs: z.number().nullish(),
    total_turns: z.number().nullish(),
    totalTurns: z.number().nullish(),
    reason: z.enum(['user_hangup', 'agent_hangup', 'timeout', 'error']).nullish(),

    // Homer QoS metrics
    homer_available: z.boolean().nullish(),
    homerAvailable: z.boolean().nullish(),
    inbound_network_mos: z.number().nullish(),
    outbound_network_mos: z.number().nullish(),
    inbound_jitter_ms: z.number().nullish(),
    outbound_jitter_ms: z.number().nullish(),
    inbound_packet_loss: z.number().nullish(),
    outbound_packet_loss: z.number().nullish(),
    inbound_r_factor: z.number().nullish(),
    outbound_r_factor: z.number().nullish(),

    // Voice metrics
    avg_e2e_latency_ms: z.number().nullish(),
    e2e_measured_turns: z.number().nullish(),
    barge_in_count: z.number().nullish(),
    barge_in_rate: z.number().nullish(),
    dtmf_turn_count: z.number().nullish(),
    dtmf_fallback_rate: z.number().nullish(),

    // ASR quality
    overall_asr_score: z.number().nullish(),
    asr_signals: z.any().nullish(),
    cascade_risk_turns: z.number().nullish(),

    // TTS quality
    avg_tts_proxy_mos: z.number().nullish(),
    avg_tts_ttfb_ms: z.number().nullish(),

    // Call activity
    total_talk_time_ms: z.number().nullish(),
    total_silence_ms: z.number().nullish(),
    silence_percent: z.number().nullish(),

    // SIP disconnect
    sip_status_code: z.number().nullish(),
    disconnect_initiator: z.string().nullish(),
    disconnect_method: z.string().nullish(),
    disconnect_reason: z.string().nullish(),

    // Session outcome
    session_outcome: z.string().nullish(),
    sessionOutcome: z.string().nullish(),
  })
  .passthrough();

eventRegistry.register('voice.session.ended', VoiceSessionEndedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.VOICE,
  containsPII: false,
  description: 'Voice session ended with comprehensive metrics',
});

// ─── voice.turn.completed ──────────────────────────────────────────────────

export const VoiceTurnDataSchema = z
  .object({
    turn_number: z.number().nullish(),
    turnNumber: z.number().nullish(),
    utterance_length: z.number().nullish(),
    utteranceLength: z.number().nullish(),
    response_length: z.number().nullish(),
    responseLength: z.number().nullish(),
    timing: z.any().nullish(),
    input_method: z.enum(['speech', 'dtmf']).nullish(),
    inputMethod: z.enum(['speech', 'dtmf']).nullish(),
    barge_in_detected: z.boolean().nullish(),
    bargeInDetected: z.boolean().nullish(),
  })
  .passthrough();

eventRegistry.register('voice.turn.completed', VoiceTurnDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.VOICE,
  containsPII: false,
  description: 'Voice turn completed',
});

// ─── voice.stt.completed ───────────────────────────────────────────────────

export const VoiceSTTDataSchema = z
  .object({
    turn_number: z.number().nullish(),
    turnNumber: z.number().nullish(),
    transcript_length: z.number().nullish(),
    transcriptLength: z.number().nullish(),
    confidence: z.number().nullish(),
    provider: z.string().nullish(),
    language: z.string().nullish(),
    input_method: z.enum(['speech', 'dtmf']).nullish(),
    inputMethod: z.enum(['speech', 'dtmf']).nullish(),
  })
  .passthrough();

eventRegistry.register('voice.stt.completed', VoiceSTTDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.VOICE,
  containsPII: false,
  description: 'Speech-to-text transcription completed',
});

// ─── voice.tts.completed ───────────────────────────────────────────────────

export const VoiceTTSDataSchema = z
  .object({
    turn_number: z.number().nullish(),
    turnNumber: z.number().nullish(),
    provider: z.string().nullish(),
    voice: z.string().nullish(),
    chunks: z.number().nullish(),
    first_chunk_ms: z.number().nullish(),
    firstChunkMs: z.number().nullish(),
    connection_ms: z.number().nullish(),
    connectionMs: z.number().nullish(),
    duration_ms: z.number().nullish(),
    durationMs: z.number().nullish(),
    streaming: z.boolean().nullish(),
    is_greeting: z.boolean().nullish(),
    isGreeting: z.boolean().nullish(),
  })
  .passthrough();

eventRegistry.register('voice.tts.completed', VoiceTTSDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.VOICE,
  containsPII: false,
  description: 'Text-to-speech synthesis completed',
});

// ─── voice.realtime.tool_call ──────────────────────────────────────────────

export const VoiceRealtimeToolCallDataSchema = z
  .object({
    turn_number: z.number().nullish(),
    turnNumber: z.number().nullish(),
    tool_name: z.string().nullish(),
    toolName: z.string().nullish(),
    tool_call_id: z.string().nullish(),
    toolCallId: z.string().nullish(),
    provider: z.string().nullish(),
    duration_ms: z.number().nullish(),
    durationMs: z.number().nullish(),
  })
  .passthrough();

eventRegistry.register('voice.realtime.tool_call', VoiceRealtimeToolCallDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.VOICE,
  containsPII: false,
  description: 'Realtime voice tool call completed',
});

// ─── voice.barge_in.detected ───────────────────────────────────────────────

export const VoiceBargeInDataSchema = z
  .object({
    turn_number: z.number().nullish(),
    turnNumber: z.number().nullish(),
    type: z.enum(['speech', 'dtmf']).nullish(),
    agent_speaking_duration_ms: z.number().nullish(),
    agentSpeakingDurationMs: z.number().nullish(),
    barge_in_count: z.number().nullish(),
    bargeInCount: z.number().nullish(),
  })
  .passthrough();

eventRegistry.register('voice.barge_in.detected', VoiceBargeInDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.VOICE,
  containsPII: false,
  description: 'User interrupted agent speech (barge-in)',
});

// ─── voice.asr_quality.analyzed ────────────────────────────────────────────

export const VoiceASRQualityDataSchema = z
  .object({
    overall_score: z.number().nullish(),
    overallScore: z.number().nullish(),
    signals: z.any().nullish(),
    issues: z.array(z.any()).nullish(),
    total_turns: z.number().nullish(),
    totalTurns: z.number().nullish(),
    avg_transcript_length: z.number().nullish(),
    avgTranscriptLength: z.number().nullish(),
    detector_type: z.string().nullish(),
    detectorType: z.string().nullish(),
    language: z.string().nullish(),
    stt_provider: z.string().nullish(),
    sttProvider: z.string().nullish(),
  })
  .passthrough();

eventRegistry.register('voice.asr_quality.analyzed', VoiceASRQualityDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.VOICE,
  containsPII: false,
  description: 'ASR quality analysis completed for session',
});

// ─── voice.tts_quality.measured ────────────────────────────────────────────

export const VoiceTTSQualityDataSchema = z
  .object({
    turn_number: z.number().nullish(),
    turnNumber: z.number().nullish(),
    proxy_mos: z.number().nullish(),
    proxyMos: z.number().nullish(),
    tts_total_ttfb: z.number().nullish(),
    ttsTotalTtfb: z.number().nullish(),
    tts_first_chunk_ms: z.number().nullish(),
    ttsFirstChunkMs: z.number().nullish(),
    tts_connection_ms: z.number().nullish(),
    ttsConnectionMs: z.number().nullish(),
    llm_first_chunk_ms: z.number().nullish(),
    llmFirstChunkMs: z.number().nullish(),
    chunk_count: z.number().nullish(),
    chunkCount: z.number().nullish(),
    streaming: z.boolean().nullish(),
    has_error: z.boolean().nullish(),
    hasError: z.boolean().nullish(),
    barge_in_on_turn: z.boolean().nullish(),
    bargeInOnTurn: z.boolean().nullish(),
  })
  .passthrough();

eventRegistry.register('voice.tts_quality.measured', VoiceTTSQualityDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.VOICE,
  containsPII: false,
  description: 'TTS quality metrics measured for turn',
});

// ─── voice.asr_cascade.detected ────────────────────────────────────────────

export const VoiceASRCascadeDataSchema = z
  .object({
    turn_index: z.number().nullish(),
    turnIndex: z.number().nullish(),
    cascade_risk: z.enum(['low', 'medium', 'high']).nullish(),
    cascadeRisk: z.enum(['low', 'medium', 'high']).nullish(),
    risk_score: z.number().nullish(),
    riskScore: z.number().nullish(),
    contributing_factors: z.array(z.string()).nullish(),
    contributingFactors: z.array(z.string()).nullish(),
    network_quality: z.string().nullish(),
    networkQuality: z.string().nullish(),
    root_cause: z.string().nullish(),
    rootCause: z.string().nullish(),
    recommendation: z.string().nullish(),
    transcript: z.string().nullish(),
    agent_response: z.string().nullish(),
    agentResponse: z.string().nullish(),
    confidence: z.number().nullish(),
    inbound_network_mos: z.number().nullish(),
    inboundNetworkMos: z.number().nullish(),
  })
  .passthrough();

eventRegistry.register('voice.asr_cascade.detected', VoiceASRCascadeDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.VOICE,
  containsPII: true, // transcript and agent_response may contain PII
  description: 'ASR cascade risk detected on turn',
});
