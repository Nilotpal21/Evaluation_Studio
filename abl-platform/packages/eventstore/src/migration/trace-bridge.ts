/**
 * Trace Event Bridge - converts runtime trace events to platform events.
 *
 * Used by voice and other channels to emit trace events (STT, TTS, barge-in, etc.)
 * directly to EventStore as platform events.
 */

import { ulid } from 'ulid';
import { estimateCost } from '@agent-platform/shared';
import type { IEventEmitter } from '../interfaces/event-emitter.js';
import type { PlatformEvent } from '../schema/platform-event.js';

export interface TraceEventInput {
  /** Trace event type (e.g., 'voice_stt', 'voice_tts', 'llm_call') */
  type: string;
  /** Session ID */
  sessionId: string;
  /** Tenant ID */
  tenantId: string;
  /** Project ID */
  projectId: string;
  /** Agent name */
  agentName?: string;
  /** Event timestamp */
  timestamp?: Date;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Whether the event represents an error */
  hasError?: boolean;
  /** Span ID (for trace correlation) */
  spanId?: string;
  /** Parent span ID */
  parentSpanId?: string;
  /** Event-specific data payload */
  data: Record<string, unknown>;
  /** Custom dimensions from session — propagated to ClickHouse Map column */
  custom_dimensions?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * TraceEvent - ClickHouse trace event structure (snake_case fields).
 * Used by mapTraceEventToPlatformEvent() to convert trace table rows to platform events.
 */
export interface TraceEvent {
  event_type: string;
  session_id: string;
  tenant_id: string;
  project_id?: string;
  agent_name?: string;
  timestamp: Date;
  duration_ms?: number;
  data: Record<string, unknown>;
  /** Custom dimensions from session — propagated to ClickHouse Map column */
  custom_dimensions?: Record<string, string>;
  [key: string]: unknown;
}

// ─── Per-type data transformers ───────────────────────────────────────────────
// Each transformer maps raw trace data to the Zod schema's expected shape.

function mapLLMCallData(
  data: Record<string, unknown>,
  durationMs?: number,
): {
  platformType: string;
  mappedData: Record<string, unknown>;
  hasError: boolean;
} {
  // Determine success: llm_call events from logLLMCall() are always successful.
  // Only mark as failed if data explicitly has error info.
  const hasError = Boolean(data.error || data.errorType || data.error_type);

  if (hasError) {
    return {
      platformType: 'llm.call.failed',
      hasError: true,
      mappedData: {
        model: data.model || 'unknown',
        provider: data.provider || 'unknown',
        error_type: data.errorType || data.error_type || 'unknown',
        error_message: data.error || data.errorMessage || data.error_message || 'Unknown error',
        latency_ms: data.latencyMs ?? data.latency_ms ?? durationMs ?? 0,
        retry_attempt: data.retryAttempt ?? data.retry_attempt,
      },
    };
  }

  // Extract token counts — reasoning executor nests them under `usage: { inputTokens, outputTokens }`,
  // while legacy traceEmitter.logLLMCall() puts them flat as tokensIn/tokensOut/totalTokens.
  const usage = (typeof data.usage === 'object' && data.usage !== null ? data.usage : {}) as Record<
    string,
    unknown
  >;
  const inputTokens = (data.tokensIn ??
    data.input_tokens ??
    usage.inputTokens ??
    usage.input_tokens ??
    0) as number;
  const outputTokens = (data.tokensOut ??
    data.output_tokens ??
    usage.outputTokens ??
    usage.output_tokens ??
    0) as number;
  const totalTokens = (data.totalTokens ??
    data.total_tokens ??
    usage.totalTokens ??
    usage.total_tokens ??
    inputTokens + outputTokens) as number;

  // Resolve tool_call_count — executor emits `hasToolCalls: boolean` and/or `toolCallCount: number`
  let toolCallCount: number | undefined = (data.toolCallCount ?? data.tool_call_count) as
    | number
    | undefined;
  if (toolCallCount == null && data.hasToolCalls != null) {
    // Convert boolean → 0/1 as a lower-bound indicator
    toolCallCount = data.hasToolCalls ? 1 : 0;
  }

  const result = {
    platformType: 'llm.call.completed',
    hasError: false,
    mappedData: {
      model: data.model || 'unknown',
      provider: data.provider || 'unknown',
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      estimated_cost: (data.cost ?? data.estimated_cost ?? null) as number | null,
      latency_ms: data.latencyMs ?? data.latency_ms ?? durationMs ?? 0,
      streaming_used: data.streaming ?? data.streaming_used ?? false,
      tool_call_count: toolCallCount,
    } as Record<string, unknown>,
  };

  // Operation type — reasoning vs extraction vs validation
  const operationType = data.operationType ?? data.operation_type;
  if (operationType) result.mappedData.operation_type = operationType;

  // Industry-standard optional fields (Helicone, OpenLLMetry, Portkey)
  const ttft = data.timeToFirstTokenMs ?? data.time_to_first_token_ms;
  if (ttft != null) result.mappedData.time_to_first_token_ms = ttft;

  const cacheCreation = data.cacheCreationTokens ?? data.cache_creation_tokens;
  if (cacheCreation != null) result.mappedData.cache_creation_tokens = cacheCreation;

  const cacheRead = data.cacheReadTokens ?? data.cache_read_tokens;
  if (cacheRead != null) result.mappedData.cache_read_tokens = cacheRead;

  // Finish reason — executor emits `stopReason`, legacy uses `finishReason`/`finish_reason`.
  // Vercel AI SDK returns hyphenated values (e.g. 'tool-calls'), Anthropic native uses
  // 'end_turn'/'tool_use' — normalize to the schema enum: stop|length|tool_calls|content_filter|error
  const rawFinishReason = String(
    data.finishReason ?? data.finish_reason ?? data.stopReason ?? data.stop_reason ?? '',
  );
  if (rawFinishReason) {
    const FINISH_REASON_MAP: Record<string, string> = {
      'tool-calls': 'tool_calls',
      tool_use: 'tool_calls',
      end_turn: 'stop',
      'end-turn': 'stop',
      stop_sequence: 'stop',
      max_tokens: 'length',
      'max-tokens': 'length',
    };
    result.mappedData.finish_reason = FINISH_REASON_MAP[rawFinishReason] ?? rawFinishReason;
  }

  // Model resolution source — useful for debugging model config issues
  const source = data.source ?? data.model_source;
  if (source) result.mappedData.model_source = source;

  // Auto-estimate cost if not provided and we have token counts + model
  if (result.mappedData.estimated_cost == null || result.mappedData.estimated_cost === 0) {
    const modelStr = String(result.mappedData.model || '');
    if (modelStr !== 'unknown' && (inputTokens > 0 || outputTokens > 0)) {
      result.mappedData.estimated_cost = estimateCost(modelStr, inputTokens, outputTokens);
    } else {
      result.mappedData.estimated_cost = 0;
    }
  }

  return result;
}

function mapToolCallData(
  data: Record<string, unknown>,
  durationMs?: number,
): {
  platformType: string;
  mappedData: Record<string, unknown>;
  hasError: boolean;
} {
  const toolName = data.toolName || data.tool_name || data.name || 'unknown';
  const latencyMs =
    data.latencyMs ?? data.latency_ms ?? data.durationMs ?? data.duration_ms ?? durationMs ?? 0;
  const toolType = data.toolType || data.tool_type;
  const success = data.success !== false && !data.error;

  if (success) {
    const mapped: Record<string, unknown> = {
      tool_name: toolName,
      latency_ms: latencyMs,
      success: true,
    };
    if (toolType) mapped.tool_type = toolType;
    return {
      platformType: 'tool.call.completed',
      hasError: false,
      mappedData: mapped,
    };
  }

  const mapped: Record<string, unknown> = {
    tool_name: toolName,
    latency_ms: latencyMs,
    success: false,
    error_type: data.errorType || data.error_type || 'tool_error',
    error_message: data.error || data.errorMessage || data.error_message || 'Unknown error',
  };
  if (toolType) mapped.tool_type = toolType;
  return {
    platformType: 'tool.call.failed',
    hasError: true,
    mappedData: mapped,
  };
}

function mapAgentEnteredData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    mode: data.mode || 'reasoning',
    trigger: data.trigger || 'user_message',
  };
}

function mapAgentExitedData(
  data: Record<string, unknown>,
  durationMs?: number,
): Record<string, unknown> {
  return {
    result: data.result || 'completed',
    duration_ms: data.durationMs ?? data.duration_ms ?? durationMs ?? 0,
  };
}

function mapHandoffData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    from_agent: data.fromAgent || data.from_agent || data.agentName || 'unknown',
    to_agent: data.toAgent || data.to_agent || 'unknown',
    return_expected: data.returnExpected ?? data.return_expected ?? false,
    context_fields_passed: data.contextFieldsPassed || data.context_fields_passed,
  };
}

function mapEscalationData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    from_agent: data.fromAgent || data.from_agent || data.agentName || 'unknown',
    reason: data.reason || 'unknown',
    priority: data.priority || 'medium',
    user_message_count: data.userMessageCount ?? data.user_message_count ?? 0,
  };
}

function mapDelegateData(
  data: Record<string, unknown>,
  durationMs?: number,
): Record<string, unknown> {
  return {
    from_agent: data.fromAgent || data.from_agent || 'unknown',
    to_agent: data.targetAgent || data.to_agent || data.toAgent || 'unknown',
    task_summary: data.task || data.task_summary || '',
    success: data.success ?? true,
    duration_ms: data.durationMs ?? data.duration_ms ?? durationMs ?? 0,
  };
}

function mapDecisionData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    decision_type: data.decisionType || data.decision_type || 'routing',
    decision: data.decision || 'unknown',
    reasoning: data.reasoning,
  };
}

function mapConstraintData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    constraint_name: data.constraint || data.constraint_name || 'unknown',
    passed: data.passed ?? true,
    violation_type: data.violationType || data.violation_type,
    handler_action: data.handlerAction || data.handler_action,
  };
}

function mapFlowStepEnteredData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    step_name: data.stepName || data.step_name || 'unknown',
    step_type: data.stepType || data.step_type,
  };
}

function mapFlowStepExitedData(
  data: Record<string, unknown>,
  durationMs?: number,
): Record<string, unknown> {
  return {
    step_name: data.stepName || data.step_name || 'unknown',
    duration_ms: data.durationMs ?? data.duration_ms ?? durationMs ?? 0,
  };
}

function mapFlowTransitionData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    from_step: data.fromStep || data.from_step || 'unknown',
    to_step: data.toStep || data.to_step || 'unknown',
    condition: data.condition,
  };
}

function mapSessionCreatedData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    channel: data.channel || data.channelType || 'unknown',
    agent_name: data.agentName || data.agent_name || data.entryAgent || 'unknown',
    deployment_id: data.deploymentId || data.deployment_id || '',
    resolution_method: data.resolutionMethod || data.resolution_method || 'new',
    caller_identity_tier: data.callerIdentityTier || data.caller_identity_tier || 'anonymous',
  };
}

function mapUserMessageData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    content_length: data.contentLength ?? data.content_length ?? 0,
    ...(data.channel != null && { channel: data.channel }),
    ...(data.hasAttachments != null && { has_attachments: data.hasAttachments }),
    ...(data.has_attachments != null && { has_attachments: data.has_attachments }),
    ...(data.attachmentCount != null && { attachment_count: data.attachmentCount }),
    ...(data.attachment_count != null && { attachment_count: data.attachment_count }),
  };
}

function mapAgentResponseData(
  data: Record<string, unknown>,
  durationMs?: number,
): Record<string, unknown> {
  return {
    content_length: data.contentLength ?? data.content_length ?? 0,
    ...(data.channel != null && { channel: data.channel }),
    ...(data.hasRichContent != null && { has_rich_content: data.hasRichContent }),
    ...(data.has_rich_content != null && { has_rich_content: data.has_rich_content }),
    duration_ms: data.durationMs ?? data.duration_ms ?? durationMs ?? 0,
  };
}

function mapSessionUpdatedData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    update_source: data.updateSource || data.update_source || 'execution',
    keys_updated: data.keysUpdated || data.keys_updated || [],
    update_count: data.updateCount ?? data.update_count ?? 0,
  };
}

function mapSessionEndedData(
  data: Record<string, unknown>,
  durationMs?: number,
): Record<string, unknown> {
  return {
    reason: data.reason || 'completed',
    total_duration_ms: data.totalDurationMs ?? data.total_duration_ms ?? durationMs ?? 0,
    total_turns: data.totalTurns ?? data.total_turns ?? 0,
    total_llm_calls: data.totalLlmCalls ?? data.total_llm_calls ?? 0,
    total_tool_calls: data.totalToolCalls ?? data.total_tool_calls ?? 0,
    total_tokens: data.totalTokens ?? data.total_tokens,
    estimated_cost: data.estimatedCost ?? data.estimated_cost,
    message_count: data.messageCount ?? data.message_count ?? 0,
  };
}

// ─── Voice Event Mappers ──────────────────────────────────────────────────────

function mapVoiceSessionStartData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    call_sid: data.callSid || data.call_sid || 'unknown',
    caller: data.caller || data.from,
    called: data.called || data.to,
    direction: data.direction || 'inbound',
    voice_provider: data.voiceProvider || data.voice_provider || 'korevg',
    sip_call_id: data.sipCallId || data.sip_call_id,
    rtp_call_id: data.rtpCallId || data.rtp_call_id,
    caller_name: data.callerName || data.caller_name,
    originating_sip_ip: data.originatingSipIp || data.originating_sip_ip,
  };
}

function mapVoiceSessionEndData(
  data: Record<string, unknown>,
  durationMs?: number,
): Record<string, unknown> {
  const hasError = Boolean(data.error || data.errorType);

  return {
    call_duration_ms: data.callDurationMs || data.call_duration_ms || durationMs || 0,
    total_turns: data.totalTurns || data.total_turns || 0,
    reason: hasError ? 'error' : data.reason || 'user_hangup',

    // Homer QoS metrics
    homer_available: data.homerAvailable || data.homer_available || false,
    inbound_network_mos: data.inboundNetworkMos || data.inbound_network_mos,
    outbound_network_mos: data.outboundNetworkMos || data.outbound_network_mos,
    inbound_jitter_ms: data.inboundJitterMs || data.inbound_jitter_ms,
    outbound_jitter_ms: data.outboundJitterMs || data.outbound_jitter_ms,
    inbound_packet_loss: data.inboundPacketLoss || data.inbound_packet_loss,
    outbound_packet_loss: data.outboundPacketLoss || data.outbound_packet_loss,
    inbound_r_factor: data.inboundRFactor || data.inbound_r_factor,
    outbound_r_factor: data.outboundRFactor || data.outbound_r_factor,

    // Voice metrics
    avg_e2e_latency_ms: data.avgE2eLatencyMs || data.avg_e2e_latency_ms,
    e2e_measured_turns: data.e2eMeasuredTurns || data.e2e_measured_turns,
    barge_in_count: data.bargeInCount || data.barge_in_count || 0,
    barge_in_rate: data.bargeInRate || data.barge_in_rate || 0,
    dtmf_turn_count: data.dtmfTurnCount || data.dtmf_turn_count || 0,
    dtmf_fallback_rate: data.dtmfFallbackRate || data.dtmf_fallback_rate || 0,

    // ASR quality
    overall_asr_score: data.overallAsrScore || data.overall_asr_score,
    asr_signals: data.asrSignals || data.asr_signals,
    cascade_risk_turns: data.cascadeRiskTurns || data.cascade_risk_turns,

    // TTS quality
    avg_tts_proxy_mos: data.avgTtsProxyMos || data.avg_tts_proxy_mos,
    avg_tts_ttfb_ms: data.avgTtsTtfb || data.avg_tts_ttfb_ms,

    // Call activity
    total_talk_time_ms: data.totalTalkTimeMs || data.total_talk_time_ms,
    total_silence_ms: data.totalSilenceMs || data.total_silence_ms,
    silence_percent: data.silencePercent || data.silence_percent,

    // SIP disconnect
    sip_status_code: data.sipStatusCode || data.sip_status_code,
    disconnect_initiator:
      data.sipDisconnectInitiator || data.disconnectInitiator || data.disconnect_initiator,
    disconnect_method: data.sipDisconnectMethod || data.disconnectMethod || data.disconnect_method,
    disconnect_reason: data.sipDisconnectReason || data.disconnectReason || data.disconnect_reason,

    // Session outcome
    session_outcome: data.sessionOutcome || data.session_outcome,
  };
}

function mapVoiceTurnData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    turn_number: data.turn || data.turn_number || 0,
    utterance_length: data.utterance ? String(data.utterance).length : 0,
    response_length: data.response ? String(data.response).length : 0,
    timing: data.timing,
    input_method: data.inputMethod || data.input_method || 'speech',
    barge_in_detected: data.bargeInDetected || data.barge_in_detected || false,
  };
}

function mapVoiceSTTData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    turn_number: data.turn || data.turn_number || 0,
    transcript_length: data.transcript ? String(data.transcript).length : 0,
    confidence: data.confidence || 0,
    provider: data.provider || 'deepgram',
    language: data.language || data.language_code,
    input_method: data.inputMethod || data.input_method || 'speech',
  };
}

function mapVoiceTTSData(
  data: Record<string, unknown>,
  durationMs?: number,
): Record<string, unknown> {
  return {
    turn_number: data.turn || data.turn_number || 0,
    provider: data.provider || 'elevenlabs',
    voice: data.voice,
    chunks: data.chunks || 0,
    first_chunk_ms: data.firstChunkMs || data.first_chunk_ms,
    connection_ms: data.connectionMs || data.connection_ms,
    duration_ms: data.durationMs || data.duration_ms || durationMs || 0,
    streaming: data.streaming ?? true,
    is_greeting: data.isGreeting || data.is_greeting || false,
  };
}

function mapVoiceRealtimeToolCallData(
  data: Record<string, unknown>,
  durationMs?: number,
): Record<string, unknown> {
  return {
    turn_number: data.turn || data.turn_number || 0,
    tool_name: data.toolName || data.tool_name,
    tool_call_id: data.toolCallId || data.tool_call_id || data.callId || data.call_id,
    provider: data.provider,
    duration_ms: data.durationMs || data.duration_ms || durationMs || 0,
    arguments: data.arguments,
  };
}

function mapVoiceBargeInData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    turn_number: data.turn || data.turn_number || 0,
    type: data.type || 'speech',
    agent_speaking_duration_ms: data.agentSpeakingDurationMs || data.agent_speaking_duration_ms,
    barge_in_count: data.bargeInCount || data.barge_in_count || 0,
  };
}

function mapVoiceASRQualityData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    overall_score: data.overallScore || data.overall_score || 0,
    signals: data.signals,
    issues: data.issues,
    total_turns: data.totalTurns || data.total_turns || 0,
    avg_transcript_length: data.avgTranscriptLength || data.avg_transcript_length,
    detector_type: data.detectorType || data.detector_type,
    language: data.language,
    stt_provider: data.sttProvider || data.stt_provider,
  };
}

function mapVoiceTTSQualityData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    turn_number: data.turn || data.turn_number || 0,
    proxy_mos: data.proxyMos || data.proxy_mos,
    tts_total_ttfb: data.ttsTotalTtfb || data.tts_total_ttfb,
    tts_first_chunk_ms: data.ttsFirstChunkMs || data.tts_first_chunk_ms,
    tts_connection_ms: data.ttsConnectionMs || data.tts_connection_ms,
    llm_first_chunk_ms: data.llmFirstChunkMs || data.llm_first_chunk_ms,
    chunk_count: data.chunkCount || data.chunk_count || 0,
    streaming: data.streaming ?? true,
    has_error: data.hasError || data.has_error || false,
    barge_in_on_turn: data.bargeInOnTurn || data.barge_in_on_turn || false,
  };
}

function mapVoiceASRCascadeData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    turn_index: data.turnIndex || data.turn_index || 0,
    cascade_risk: data.cascadeRisk || data.cascade_risk || 'low',
    risk_score: data.riskScore || data.risk_score || 0,
    contributing_factors: data.contributingFactors || data.contributing_factors,
    network_quality: data.networkQuality || data.network_quality,
    root_cause: data.rootCause || data.root_cause,
    recommendation: data.recommendation,
    transcript: data.transcript,
    agent_response: data.agentResponse || data.agent_response,
    confidence: data.confidence,
    inbound_network_mos: data.inboundNetworkMos || data.inbound_network_mos,
  };
}

// ─── Main mapper ──────────────────────────────────────────────────────────────

/**
 * Map trace event to platform event.
 */
export function mapTraceEventToPlatformEvent(traceEvent: TraceEvent): PlatformEvent | null {
  const data = traceEvent.data;
  const durationMs = traceEvent.duration_ms;
  let platformEventType: string;
  let mappedData: Record<string, unknown>;
  let hasError = false;

  switch (traceEvent.event_type) {
    case 'llm_call': {
      const result = mapLLMCallData(data, durationMs);
      platformEventType = result.platformType;
      mappedData = result.mappedData;
      hasError = result.hasError;
      break;
    }
    case 'tool_call': {
      const result = mapToolCallData(data, durationMs);
      platformEventType = result.platformType;
      mappedData = result.mappedData;
      hasError = result.hasError;
      break;
    }
    case 'agent_enter':
      platformEventType = 'agent.entered';
      mappedData = mapAgentEnteredData(data);
      break;
    case 'agent_exit':
      platformEventType = 'agent.exited';
      mappedData = mapAgentExitedData(data, durationMs);
      break;
    case 'handoff':
      platformEventType = 'agent.handoff';
      mappedData = mapHandoffData(data);
      break;
    case 'escalation':
      platformEventType = 'agent.escalated';
      mappedData = mapEscalationData(data);
      break;
    case 'delegate':
      platformEventType = 'agent.delegated';
      mappedData = mapDelegateData(data, durationMs);
      break;
    case 'decision':
      platformEventType = 'agent.decision';
      mappedData = mapDecisionData(data);
      break;
    case 'constraint_check':
      platformEventType = 'agent.constraint.checked';
      mappedData = mapConstraintData(data);
      break;
    case 'flow_step_enter':
      platformEventType = 'flow.step.entered';
      mappedData = mapFlowStepEnteredData(data);
      break;
    case 'flow_step_exit':
      platformEventType = 'flow.step.exited';
      mappedData = mapFlowStepExitedData(data, durationMs);
      break;
    case 'flow_transition':
      platformEventType = 'flow.transition';
      mappedData = mapFlowTransitionData(data);
      break;
    case 'session_created':
      platformEventType = 'session.started';
      mappedData = mapSessionCreatedData(data);
      break;
    case 'user_message':
      platformEventType = 'message.user.received';
      mappedData = mapUserMessageData(data);
      break;
    case 'agent_response':
      platformEventType = 'message.agent.sent';
      mappedData = mapAgentResponseData(data, durationMs);
      break;
    case 'session_updated':
      platformEventType = 'session.updated';
      mappedData = mapSessionUpdatedData(data);
      break;
    case 'session_ended':
      platformEventType = 'session.ended';
      mappedData = mapSessionEndedData(data, durationMs);
      break;
    // Voice events
    case 'voice_session_start':
      platformEventType = 'voice.session.started';
      mappedData = mapVoiceSessionStartData(data);
      break;
    case 'voice_session_end':
      platformEventType = 'voice.session.ended';
      mappedData = mapVoiceSessionEndData(data, durationMs);
      hasError = Boolean(data.error || data.errorType);
      break;
    case 'voice_turn':
      platformEventType = 'voice.turn.completed';
      mappedData = mapVoiceTurnData(data);
      break;
    case 'voice_stt':
      platformEventType = 'voice.stt.completed';
      mappedData = mapVoiceSTTData(data);
      break;
    case 'voice_tts':
      platformEventType = 'voice.tts.completed';
      mappedData = mapVoiceTTSData(data, durationMs);
      break;
    case 'voice_realtime_tool_call':
      platformEventType = 'voice.realtime.tool_call';
      mappedData = mapVoiceRealtimeToolCallData(data, durationMs);
      break;
    case 'voice_barge_in':
      platformEventType = 'voice.barge_in.detected';
      mappedData = mapVoiceBargeInData(data);
      break;
    case 'voice_asr_quality':
      platformEventType = 'voice.asr_quality.analyzed';
      mappedData = mapVoiceASRQualityData(data);
      break;
    case 'voice_tts_quality':
      platformEventType = 'voice.tts_quality.measured';
      mappedData = mapVoiceTTSQualityData(data);
      hasError = Boolean(data.hasError || data.has_error);
      break;
    case 'voice_asr_cascade':
      platformEventType = 'voice.asr_cascade.detected';
      mappedData = mapVoiceASRCascadeData(data);
      break;
    case 'voice_config_resolved':
      platformEventType = 'agent.voice.config_resolved';
      mappedData = data;
      break;
    default:
      // Unknown trace event type — skip
      return null;
  }

  // Infer category from event_type
  const category = platformEventType.split('.')[0] as PlatformEvent['category'];

  const platformEvent: PlatformEvent = {
    event_id: ulid(),
    event_type: platformEventType,
    category,
    tenant_id: traceEvent.tenant_id,
    project_id: traceEvent.project_id || 'unknown',
    session_id: traceEvent.session_id,
    agent_name: traceEvent.agent_name,
    timestamp: traceEvent.timestamp,
    duration_ms: durationMs,
    has_error: hasError || Boolean(data.error),
    data: mappedData,
    // Propagate custom dimensions for ClickHouse Map column
    ...(traceEvent.custom_dimensions &&
      Object.keys(traceEvent.custom_dimensions).length > 0 && {
        metadata: { custom_dimensions: traceEvent.custom_dimensions },
      }),
  };

  return platformEvent;
}

/**
 * Mapping from trace event types to platform event types.
 * Callers can provide their own mapping or use the defaults.
 */
export interface TraceTypeMappingOptions {
  /** Map of trace type -> platform event type */
  typeMap?: Record<string, string>;
  /** Function to infer category from platform event type */
  inferCategory?: (eventType: string) => string;
}

/** Default category inference: first segment of dotted event type */
function defaultInferCategory(eventType: string): string {
  return eventType.split('.')[0];
}

/**
 * Emit a trace event as a platform event to EventStore.
 *
 * Converts the trace event to a PlatformEvent and emits it via the provided emitter.
 * Fire-and-forget — does not throw on emission failure.
 */
export function emitTraceEventAsAnalytics(
  emitter: IEventEmitter,
  input: TraceEventInput,
  options?: TraceTypeMappingOptions,
): void {
  const typeMap = options?.typeMap ?? {};
  const inferCat = options?.inferCategory ?? defaultInferCategory;

  const platformType = typeMap[input.type] || input.type;
  const category = inferCat(platformType);

  emitter.emit({
    event_id: ulid(),
    event_type: platformType,
    category,
    tenant_id: input.tenantId,
    project_id: input.projectId,
    session_id: input.sessionId,
    agent_name: input.agentName,
    timestamp: input.timestamp ?? new Date(),
    duration_ms: input.durationMs ?? 0,
    has_error: input.hasError ?? false,
    span_id: input.spanId,
    parent_span_id: input.parentSpanId,
    data: input.data,
  });
}
