/**
 * WebSocket Event Types and Utilities
 */

import type {
  ClientMessage,
  ServerMessage,
  AgentDetails,
  AgentState,
  ConstructAction,
  ResumedConversationMessage,
  TraceEventWithId,
  HandoffProgress,
  VoiceSessionCapabilities,
} from '../types/index.js';
import type {
  LiveSessionDiscoveryResult,
  JoinResult,
  Participant,
  TranscriptItem,
} from '../services/omnichannel/types.js';
import type { ResponseMessageMetadata } from '../services/channel/response-provenance.js';
import type { PersistedMessageLocalizationOwnershipV1 } from '../services/session/persisted-message-content.js';
import {
  AUTH_JIT_REQUIRED_CODE,
  AUTH_PREFLIGHT_REQUIRED_CODE,
  AUTH_PREFLIGHT_SATISFIED_CODE,
} from '../services/auth-profile/auth-contract.js';
import { validateActionSubmitEnvelope } from './action-submit-envelope.js';

// =============================================================================
// MESSAGE PARSING
// =============================================================================

/**
 * Parse a client message from raw WebSocket data
 */
export function parseClientMessage(data: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(data);

    // Validate message type
    if (!parsed.type) {
      return null;
    }

    // Validate specific message types
    switch (parsed.type) {
      case 'load_agent':
        if (
          typeof parsed.agentPath !== 'string' ||
          typeof parsed.projectId !== 'string' ||
          parsed.projectId.trim().length === 0
        )
          return null;
        return {
          type: 'load_agent',
          agentPath: parsed.agentPath,
          projectId: parsed.projectId.trim(),
          deploymentId: typeof parsed.deploymentId === 'string' ? parsed.deploymentId : undefined,
          environment: typeof parsed.environment === 'string' ? parsed.environment : undefined,
          versionId: typeof parsed.versionId === 'string' ? parsed.versionId : undefined,
          ...(parsed.callerData &&
          typeof parsed.callerData === 'object' &&
          !Array.isArray(parsed.callerData)
            ? { callerData: parsed.callerData as Record<string, unknown> }
            : {}),
        };

      case 'send_message':
        if (typeof parsed.sessionId !== 'string' || typeof parsed.text !== 'string') return null;
        return {
          type: 'send_message',
          sessionId: parsed.sessionId,
          text: parsed.text,
          ...(typeof parsed.messageId === 'string' && parsed.messageId.length > 0
            ? { messageId: parsed.messageId }
            : {}),
          ...(Array.isArray(parsed.attachmentIds) &&
          parsed.attachmentIds.length > 0 &&
          parsed.attachmentIds.every((id: unknown) => typeof id === 'string' && id.length > 0)
            ? { attachmentIds: parsed.attachmentIds as string[] }
            : {}),
        };

      case 'ensure_session_persisted':
        if (
          typeof parsed.sessionId !== 'string' ||
          parsed.sessionId.length === 0 ||
          typeof parsed.requestId !== 'string' ||
          parsed.requestId.length === 0
        )
          return null;
        return {
          type: 'ensure_session_persisted',
          sessionId: parsed.sessionId,
          requestId: parsed.requestId,
        };

      case 'run_test':
        if (typeof parsed.sessionId !== 'string' || typeof parsed.testId !== 'string') return null;
        return { type: 'run_test', sessionId: parsed.sessionId, testId: parsed.testId };

      case 'get_state':
        if (typeof parsed.sessionId !== 'string') return null;
        return { type: 'get_state', sessionId: parsed.sessionId };

      case 'subscribe_session':
        if (typeof parsed.sessionId !== 'string') return null;
        return { type: 'subscribe_session', sessionId: parsed.sessionId };

      case 'unsubscribe_session':
        if (typeof parsed.sessionId !== 'string') return null;
        return { type: 'unsubscribe_session', sessionId: parsed.sessionId };

      case 'resume_session':
        if (typeof parsed.sessionId !== 'string') return null;
        return {
          type: 'resume_session',
          sessionId: parsed.sessionId,
          lastSeenTraceEventId:
            typeof parsed.lastSeenTraceEventId === 'string' &&
            parsed.lastSeenTraceEventId.length > 0
              ? parsed.lastSeenTraceEventId
              : undefined,
        };

      case 'list_sessions':
        return { type: 'list_sessions' };

      // Test context messages
      case 'load_agent_with_context':
        if (
          typeof parsed.agentPath !== 'string' ||
          typeof parsed.projectId !== 'string' ||
          parsed.projectId.trim().length === 0 ||
          !parsed.context ||
          typeof parsed.context !== 'object'
        )
          return null;
        return {
          type: 'load_agent_with_context',
          agentPath: parsed.agentPath,
          projectId: parsed.projectId.trim(),
          context: parsed.context,
        };

      case 'inject_context':
        if (
          typeof parsed.sessionId !== 'string' ||
          !parsed.injection ||
          typeof parsed.injection !== 'object'
        )
          return null;
        return {
          type: 'inject_context',
          sessionId: parsed.sessionId,
          injection: parsed.injection,
        };

      case 'set_tool_mocks':
        if (typeof parsed.sessionId !== 'string' || !Array.isArray(parsed.mocks)) return null;
        return {
          type: 'set_tool_mocks',
          sessionId: parsed.sessionId,
          mocks: parsed.mocks,
        };

      case 'clear_tool_mocks':
        if (typeof parsed.sessionId !== 'string') return null;
        return { type: 'clear_tool_mocks', sessionId: parsed.sessionId };

      case 'cancel_execution':
        return {
          type: 'cancel_execution',
          executionId: typeof parsed.executionId === 'string' ? parsed.executionId : undefined,
        };

      case 'action_submit':
        if (typeof parsed.sessionId !== 'string') return null;
        const actionEnvelope = validateActionSubmitEnvelope({
          actionId: parsed.actionId,
          value: parsed.value,
          formData: parsed.formData,
          formDataPresent: Object.prototype.hasOwnProperty.call(parsed, 'formData'),
          renderId: parsed.renderId,
        });
        if (!actionEnvelope.ok) return null;
        return {
          type: 'action_submit',
          sessionId: parsed.sessionId,
          ...actionEnvelope.value,
        };

      case 'consent_satisfy':
        if (typeof parsed.sessionId !== 'string' || typeof parsed.authProfileRef !== 'string')
          return null;
        return {
          type: 'consent_satisfy',
          sessionId: parsed.sessionId,
          authProfileRef: parsed.authProfileRef,
          requirementKey:
            typeof parsed.requirementKey === 'string' ? parsed.requirementKey : undefined,
        };

      case 'auth_response':
        if (
          typeof parsed.toolCallId !== 'string' ||
          (parsed.status !== 'completed' && parsed.status !== 'cancelled')
        )
          return null;
        return {
          type: 'auth_response',
          toolCallId: parsed.toolCallId,
          status: parsed.status,
        };

      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Serialize a server message for sending
 */
export function serializeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

// =============================================================================
// MESSAGE CREATORS
// =============================================================================

export const ServerMessages = {
  typingStart(sessionId: string): ServerMessage {
    return { type: 'typing_start', sessionId };
  },

  agentLoaded(sessionId: string, agent: AgentDetails, traceId?: string): ServerMessage {
    return { type: 'agent_loaded', sessionId, agent, ...(traceId && { traceId }) };
  },

  agentLoadError(error: string): ServerMessage {
    return { type: 'agent_load_error', error };
  },

  responseStart(sessionId: string, messageId: string, executionId?: string): ServerMessage {
    return { type: 'response_start', sessionId, messageId, ...(executionId && { executionId }) };
  },

  responseChunk(
    sessionId: string,
    messageId: string,
    chunk: string,
    richContent?: import('@abl/compiler').RichContentIR,
    actions?: import('@abl/compiler').ActionSetIR,
  ): ServerMessage {
    return {
      type: 'response_chunk',
      sessionId,
      messageId,
      chunk,
      ...(richContent !== undefined ? { richContent } : {}),
      ...(actions !== undefined ? { actions } : {}),
    };
  },

  responseEnd(
    sessionId: string,
    messageId: string,
    fullText: string,
    voiceConfig?: import('@abl/compiler').VoiceConfigIR,
    richContent?: import('@abl/compiler').RichContentIR,
    actions?: import('@abl/compiler').ActionSetIR,
    executionId?: string,
    metadata?: ResponseMessageMetadata,
    localization?: PersistedMessageLocalizationOwnershipV1,
    citations?: import('../types/index.js').Citation[],
  ): ServerMessage {
    return {
      type: 'response_end',
      sessionId,
      messageId,
      fullText,
      voiceConfig,
      richContent,
      actions,
      ...(executionId && { executionId }),
      ...(metadata ? { metadata } : {}),
      ...(localization ? { localization } : {}),
      ...(citations?.length ? { citations } : {}),
    };
  },

  traceEvent(sessionId: string, event: TraceEventWithId): ServerMessage {
    return { type: 'trace_event', sessionId, event };
  },

  stateUpdate(sessionId: string, state: AgentState, updates: Partial<AgentState>): ServerMessage {
    return { type: 'state_update', sessionId, state, updates };
  },

  actionTaken(sessionId: string, action: ConstructAction): ServerMessage {
    return { type: 'action_taken', sessionId, action };
  },

  sessionPersisted(sessionId: string, requestId: string, persisted: boolean): ServerMessage {
    return { type: 'session_persisted', sessionId, requestId, persisted };
  },

  sessionPersistFailed(
    sessionId: string,
    requestId: string,
    error: { code: string; message: string },
  ): ServerMessage {
    return { type: 'session_persist_failed', sessionId, requestId, error };
  },

  error(message: string, code?: number, retryAfterMs?: number): ServerMessage {
    return {
      type: 'error',
      message,
      ...(code !== undefined && { code }),
      ...(retryAfterMs !== undefined && { retryAfterMs }),
    };
  },

  /**
   * Feedback capture ack (ABLP-1068). Constructed from the feedback service
   * result and the inbound transport fields (messageId + optional
   * actionRenderId). See LLD §2.3.
   */
  feedbackAck(
    messageId: string,
    actionRenderId: string | undefined,
    result: { ok: true; feedbackId: string } | { ok: false; code: string; message: string },
  ): ServerMessage {
    if (result.ok) {
      return {
        type: 'feedback.ack',
        messageId,
        success: true,
        feedbackId: result.feedbackId,
        ...(actionRenderId ? { actionRenderId } : {}),
      };
    }
    return {
      type: 'feedback.ack',
      messageId,
      success: false,
      ...(actionRenderId ? { actionRenderId } : {}),
      error: { code: result.code, message: result.message },
    };
  },

  info(message: string, configured: boolean): ServerMessage {
    return { type: 'info', message, configured };
  },

  sessionResumed(
    sessionId: string,
    state: AgentState,
    conversationHistory: ResumedConversationMessage[],
    agent?: AgentDetails,
  ): ServerMessage {
    return { type: 'session_resumed', sessionId, state, conversationHistory, agent };
  },

  toolWarnings(sessionId: string, warnings: string[]): ServerMessage {
    return { type: 'tool_warnings', sessionId, warnings };
  },

  sessionHealth(
    sessionId: string,
    health: Array<{ category: string; severity: string; code: string; message: string }>,
  ): ServerMessage {
    return { type: 'session_health', sessionId, health };
  },

  // Test context responses
  contextInjected(sessionId: string, updatedValues: Record<string, unknown>): ServerMessage {
    return { type: 'context_injected', sessionId, updatedValues };
  },

  toolMockSet(sessionId: string, mockCount: number): ServerMessage {
    return { type: 'tool_mock_set', sessionId, mockCount };
  },

  contextInjectionError(
    sessionId: string,
    error: { code: string; message: string },
  ): ServerMessage {
    return { type: 'context_injection_error', sessionId, error };
  },

  // Execution lifecycle events
  executionQueued(executionId: string, position: number, estimatedWaitMs?: number): ServerMessage {
    return { type: 'execution_queued', executionId, position, estimatedWaitMs };
  },

  executionStarted(executionId: string, agentName: string): ServerMessage {
    return { type: 'execution_started', executionId, agentName };
  },

  executionCancelled(
    executionId: string,
    reason: 'preempted' | 'timeout' | 'client_cancel',
  ): ServerMessage {
    return { type: 'execution_cancelled', executionId, reason };
  },

  executionRejected(reason: 'queue_full', queueDepth: number, retryAfterMs: number): ServerMessage {
    return {
      type: 'execution_rejected',
      reason,
      message: 'Agent is currently processing multiple messages. Please wait.',
      queueDepth,
      retryAfterMs,
    };
  },

  handoffProgress(sessionId: string, progress: HandoffProgress): ServerMessage {
    return { type: 'handoff_progress', sessionId, progress };
  },

  agentSwitch(
    sessionId: string,
    agentName: string,
    mode: string,
    previousAgent?: string,
    agentDisplayName?: string,
  ): ServerMessage {
    return {
      type: 'agent_switch',
      sessionId,
      agentName,
      agentDisplayName,
      previousAgent,
      mode,
    };
  },

  statusUpdate(
    sessionId: string,
    text: string,
    operation: string,
    index: number,
    executionId?: string,
  ): ServerMessage {
    return {
      type: 'status_update',
      sessionId,
      text,
      operation,
      transient: true,
      index,
      ...(executionId && { executionId }),
    };
  },

  statusClear(sessionId: string): ServerMessage {
    return { type: 'status_clear', sessionId };
  },

  // Auth preflight consent events (Phase 4)
  authRequired(
    sessionId: string,
    pending: import('../types/index.js').AuthRequirement[],
    satisfied: import('../types/index.js').AuthRequirement[],
  ): ServerMessage {
    return {
      type: 'auth_required',
      sessionId,
      code: AUTH_PREFLIGHT_REQUIRED_CODE,
      pending,
      satisfied,
    };
  },

  authGateUpdated(
    sessionId: string,
    pending: import('../types/index.js').AuthRequirement[],
    satisfied: import('../types/index.js').AuthRequirement[],
  ): ServerMessage {
    return {
      type: 'auth_gate_updated',
      sessionId,
      code: AUTH_PREFLIGHT_REQUIRED_CODE,
      pending,
      satisfied,
    };
  },

  authGateSatisfied(sessionId: string): ServerMessage {
    return { type: 'auth_gate_satisfied', sessionId, code: AUTH_PREFLIGHT_SATISFIED_CODE };
  },

  messageQueued(sessionId: string, reason: string): ServerMessage {
    return {
      type: 'message_queued',
      sessionId,
      reason,
      code: AUTH_PREFLIGHT_REQUIRED_CODE,
    };
  },

  // SDK session lifecycle
  sessionStart(
    sessionId: string,
    projectId: string,
    permissions: { chat: boolean; voice: boolean },
    traceId?: string,
  ): ServerMessage {
    return {
      type: 'session_start',
      sessionId,
      projectId,
      permissions,
      ...(traceId && { traceId }),
    };
  },

  sessionEnded(sessionId: string): ServerMessage {
    return { type: 'session_ended', sessionId };
  },

  action(sessionId: string, action: ConstructAction): ServerMessage {
    return { type: 'action', sessionId, action };
  },

  // Voice
  voiceToken(token: string, identity: string): ServerMessage {
    return { type: 'voice_token', token, identity };
  },

  voiceError(message: string): ServerMessage {
    return { type: 'voice_error', message };
  },

  voiceStarted(
    sessionId: string,
    voiceMode: string,
    capabilities?: VoiceSessionCapabilities,
  ): ServerMessage {
    return { type: 'voice_started', sessionId, voiceMode, ...(capabilities && { capabilities }) };
  },

  voiceStopped(sessionId: string): ServerMessage {
    return { type: 'voice_stopped', sessionId };
  },

  voiceBargeInAck(): ServerMessage {
    return { type: 'voice_barge_in_ack' };
  },

  voiceRealtimeAudio(audio: string, format: string): ServerMessage {
    return { type: 'voice_realtime_audio', audio, format };
  },

  voiceRealtimeTranscript(text: string, isFinal: boolean, role: string): ServerMessage {
    return { type: 'voice_realtime_transcript', text, isFinal, role };
  },

  // Omnichannel live sessions
  liveSessionNotFound(): ServerMessage {
    return { type: 'live_session_not_found' };
  },

  liveSessionDiscovered(discovery: LiveSessionDiscoveryResult): ServerMessage {
    return { type: 'live_session_discovered', ...discovery };
  },

  liveSessionJoinError(error: NonNullable<JoinResult['error']>): ServerMessage {
    return { type: 'live_session_join_error', success: false, error };
  },

  liveSessionJoined(
    sessionId: string,
    participantId: string,
    result: Pick<JoinResult, 'backfill' | 'participants'>,
  ): ServerMessage {
    return {
      type: 'live_session_joined',
      sessionId,
      participantId,
      backfill: result.backfill,
      participants: result.participants,
    };
  },

  transcriptBackfill(sessionId: string, items: Array<Record<string, unknown>>): ServerMessage {
    return { type: 'transcript_backfill', sessionId, items };
  },

  transcriptItem(item: TranscriptItem): ServerMessage {
    return { type: 'transcript_item', ...item };
  },

  participantEvent(
    eventType: 'participant_attached' | 'participant_detached',
    sessionId: string,
    participant: Participant,
  ): ServerMessage {
    return { type: eventType, sessionId, participant };
  },

  // JIT auth challenge (Phase 5)
  authChallenge(
    sessionId: string,
    params: {
      toolCallId: string;
      authType: string;
      authUrl?: string;
      profileId: string;
      profileName: string;
      prompt: string;
      timeoutMs: number;
    },
  ): ServerMessage {
    return {
      type: 'auth_challenge',
      sessionId,
      code: AUTH_JIT_REQUIRED_CODE,
      ...params,
    };
  },
};
