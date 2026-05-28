/**
 * Test Server Types
 */

import type {
  LiveSyncState as OmnichannelLiveSyncState,
  Participant as OmnichannelParticipant,
  TranscriptItem as OmnichannelTranscriptItem,
} from '../services/omnichannel/types.js';
import type { ResponseMessageMetadata } from '../services/channel/response-provenance.js';
import type { PersistedMessageLocalizationOwnershipV1 } from '../services/session/persisted-message-content.js';
import type { ContentBlock } from '@abl/compiler/platform/llm/types.js';
import type { PersistedStructuredMessageEnvelopeV2 } from '../services/session/persisted-message-content.js';

// =============================================================================
// AGENT STATE (simplified, standalone)
// =============================================================================

export interface AgentState {
  context: Record<string, unknown>;
  conversationPhase: string;
  gatherProgress: Record<string, unknown>;
  constraintResults: Record<string, boolean>;
  lastToolResults: Record<string, unknown>;
  memory: {
    session: Record<string, unknown>;
    persistentCache: Record<string, unknown>;
    pendingRemembers: unknown[];
  };
  flowState?: {
    currentStep: string;
    stepHistory: string[];
    stepResults: Record<string, unknown>;
    isComplete: boolean;
  };
  errorState?: {
    type: string;
    message: string;
    stack?: string;
    retryCount: number;
  };
  /** Currently active agent (changes on handoff) */
  activeAgent?: {
    name: string;
    mode: string;
    ir?: unknown;
  };
}

// =============================================================================
// TRACE TYPES (extends canonical @agent-platform/shared-kernel TraceEvent)
// =============================================================================

import type { TraceEvent as BaseTraceEvent } from '@agent-platform/shared-kernel';
import type { TraceEventType } from '@agent-platform/shared-kernel';
export type { TraceEventType };

export interface TraceEvent extends Omit<BaseTraceEvent, 'type'> {
  type: TraceEventType;
  // Trace correlation
  traceId?: string;
  tenantId?: string;
  projectId?: string;
  /** Execution context ID for correlating events within a fan-out */
  executionId?: string;
  /** Parent execution ID for parent-child correlation */
  parentExecutionId?: string;
  /** Agent lifecycle run ID shared by enter, decision, tool, and exit events */
  agentRunId?: string;
  /** Decision span ID for atomic runtime decisions */
  decisionId?: string;
  /** Parent decision span ID for nested decisions */
  parentDecisionId?: string;
  /** Immediate cause event ID for reconstructing runtime call stacks */
  causeEventId?: string;
  /** High-level runtime phase used for trace grouping */
  phase?: string;
  /** Machine-readable reason or outcome code for the event */
  reasonCode?: string;
  /** Decision kind — present when type is 'decision', identifies the specific decision type */
  decisionKind?:
    | 'field_validation'
    | 'gather_extraction'
    | 'flow_transition'
    | 'correction'
    | 'data_mutation'
    | 'handoff'
    | 'delegation'
    | 'constraint_check'
    | 'escalation'
    | 'guardrail_check'
    | 'completion';
}

// =============================================================================
// ACTION TYPES (simplified, standalone)
// =============================================================================

export type ConstructAction =
  | { type: 'continue'; data?: Record<string, unknown> }
  | { type: 'respond'; message: string; continueProcessing?: boolean }
  | {
      type: 'escalate';
      reason: string;
      priority: 'low' | 'medium' | 'high' | 'critical';
      context?: Record<string, unknown>;
    }
  | {
      type: 'handoff';
      target: string;
      context: Record<string, unknown>;
      returnExpected: boolean;
      summary?: string;
    }
  | { type: 'delegate'; agent: string; input: Record<string, unknown>; useResult: string }
  | { type: 'complete'; message?: string; store?: Record<string, unknown> }
  | { type: 'retry'; delay: number; target?: string }
  | { type: 'block'; reason: string; constraint?: string }
  | { type: 'collect'; fields: string[]; prompts: Record<string, string> };

// =============================================================================
// AGENT DISCOVERY
// =============================================================================

export interface AgentInfo {
  /** Unique identifier (agent name) */
  id: string;
  /** Agent name */
  name: string;
  /** Full file path (empty for database-loaded agents) */
  filePath?: string;
  /** Agent type */
  type: 'agent' | 'supervisor';
  /** Execution mode */
  mode: 'reasoning' | 'scripted';
  /** Number of tools */
  toolCount: number;
  /** Number of gather fields */
  gatherFieldCount: number;
  /** Whether this is a main supervisor */
  isSupervisor: boolean;
}

export interface AgentDetails extends AgentInfo {
  /** Agent identity declared inside the DSL, when available. Runtime identity stays record-backed. */
  declaredName?: string;
  /** Raw ABL content */
  dsl: string;
  /** Compiled IR (if successful) */
  ir?: unknown;
  /** Parse/compile errors */
  errors?: string[];
  /** Suggested test cases */
  suggestedTests?: TestCase[];
}

// =============================================================================
// TEST SESSIONS
// =============================================================================

export interface TestSession {
  /** Session ID */
  id: string;
  /** Loaded agent info */
  agent: AgentDetails;
  /** Current agent state */
  state: AgentState;
  /** Conversation messages */
  messages: SessionMessage[];
  /** All trace events */
  traceEvents: TraceEvent[];
  /** Creation timestamp */
  createdAt: Date;
  /** Last activity timestamp */
  lastActivityAt: Date;
}

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  /** Associated trace events for this message */
  traceIds: string[];
  /** Metadata */
  metadata?: {
    tokensIn?: number;
    tokensOut?: number;
    latencyMs?: number;
    action?: ConstructAction;
    agentName?: string;
  };
}

export interface ResumedConversationMessage {
  id?: string;
  role: string;
  content: string;
  rawContent?: ContentBlock[];
  contentEnvelope?: PersistedStructuredMessageEnvelopeV2;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// TEST CASES
// =============================================================================

export interface TestCase {
  id: string;
  name: string;
  description: string;
  category: 'happy_path' | 'edge_case' | 'constraint' | 'handoff' | 'error';
  /** Input messages to send */
  inputs: string[];
  /** Expected behaviors/assertions */
  expectations?: TestExpectation[];
}

export interface TestExpectation {
  type: 'action' | 'response_contains' | 'state_contains' | 'trace_event';
  value: string;
}

// =============================================================================
// WEBSOCKET EVENTS
// =============================================================================

/** Client -> Server messages */
export type ClientMessage =
  | {
      type: 'load_agent';
      agentPath: string;
      projectId: string;
      deploymentId?: string;
      environment?: string;
      versionId?: string;
      /** Arbitrary end-user data from the client app (e.g., customerId, planName).
       *  Merged into callerContext and exposed in the session namespace so ABL agents
       *  can reference them as session.<key>. */
      callerData?: Record<string, unknown>;
    }
  | {
      type: 'send_message';
      sessionId: string;
      text: string;
      attachmentIds?: string[];
      messageId?: string;
    }
  | { type: 'ensure_session_persisted'; sessionId: string; requestId: string }
  | { type: 'run_test'; sessionId: string; testId: string }
  | { type: 'get_state'; sessionId: string }
  // Session resumption (reconnect after disconnect)
  | { type: 'resume_session'; sessionId: string; lastSeenTraceEventId?: string }
  // Trace subscription (for MCP debug and external observers)
  | { type: 'subscribe_session'; sessionId: string }
  | { type: 'unsubscribe_session'; sessionId: string }
  | { type: 'list_sessions' }
  // Test context (debug sessions only)
  | {
      type: 'load_agent_with_context';
      agentPath: string;
      projectId: string;
      context: import('./test-context.js').TestContextPayload;
    }
  | {
      type: 'inject_context';
      sessionId: string;
      injection: import('./test-context.js').ContextInjection;
    }
  | {
      type: 'set_tool_mocks';
      sessionId: string;
      mocks: import('./test-context.js').ToolMockConfig[];
    }
  | { type: 'clear_tool_mocks'; sessionId: string }
  | { type: 'cancel_execution'; executionId?: string }
  | { type: 'fork_session'; sessionId: string; threadIndex?: number }
  | {
      type: 'action_submit';
      sessionId: string;
      actionId: string;
      value?: string;
      formData?: Record<string, unknown>;
      renderId?: string;
    }
  // Auth consent (Phase 4)
  | { type: 'consent_satisfy'; sessionId: string; authProfileRef: string; requirementKey?: string }
  // JIT auth response (Phase 5)
  | { type: 'auth_response'; toolCallId: string; status: 'completed' | 'cancelled' };

/** Citation reference in a search-powered answer */
export interface Citation {
  /** 1-based index matching [N] in the response text */
  index: number;
  /** Document title */
  title: string;
  /** User-navigable URL for connector/crawled sources; JWT download URL for uploads */
  url: string;
  /** Source type: connector (SharePoint, etc.), upload, or crawled */
  sourceType: 'connector' | 'upload' | 'crawled';
  /** Original document ID */
  documentId: string;
  /** Page number within the document (from chunk metadata). When present, URL includes #page=N */
  pageNumber?: number;
}

/** Server -> Client messages */
export type ServerMessage =
  | { type: 'agent_loaded'; sessionId: string; agent: AgentDetails }
  | { type: 'agent_load_error'; error: string }
  | { type: 'response_start'; sessionId: string; messageId: string; executionId?: string }
  | {
      type: 'response_chunk';
      sessionId: string;
      messageId: string;
      chunk: string;
      richContent?: import('@abl/compiler').RichContentIR;
      actions?: import('@abl/compiler').ActionSetIR;
    }
  | {
      type: 'response_end';
      sessionId: string;
      messageId: string;
      fullText: string;
      voiceConfig?: import('@abl/compiler').VoiceConfigIR;
      richContent?: import('@abl/compiler').RichContentIR;
      actions?: import('@abl/compiler').ActionSetIR;
      executionId?: string;
      metadata?: ResponseMessageMetadata;
      localization?: PersistedMessageLocalizationOwnershipV1;
      citations?: Citation[];
    }
  | { type: 'trace_event'; sessionId: string; event: TraceEventWithId }
  | { type: 'state_update'; sessionId: string; state: AgentState; updates: Partial<AgentState> }
  | { type: 'action_taken'; sessionId: string; action: ConstructAction }
  | { type: 'session_reset'; sessionId: string }
  | {
      type: 'session_persisted';
      sessionId: string;
      requestId: string;
      persisted: boolean;
    }
  | {
      type: 'session_persist_failed';
      sessionId: string;
      requestId: string;
      error: { code: string; message: string };
    }
  | { type: 'error'; message: string; retryAfterMs?: number; code?: number }
  // Feedback capture (ABLP-1068) — server-side acknowledgement of a
  // feedback.submit message. Asymmetric with ClientMessage by design: the SDK
  // handler parses incoming feedback via the loose SDKIncomingMessage shape
  // and narrows with Zod (services/feedback/types.ts), so feedback.submit is
  // intentionally NOT in ClientMessage. See LLD D-22.
  | {
      type: 'feedback.ack';
      messageId: string;
      success: boolean;
      feedbackId?: string;
      actionRenderId?: string;
      error?: { code: string; message: string };
    }
  | { type: 'session_forked'; sessionId: string; parentSessionId: string; forkPoint: number }
  | { type: 'info'; message: string; configured: boolean }
  // Trace subscription responses
  | {
      type: 'trace_replay';
      sessionId: string;
      events: TraceEventWithId[];
      totalBuffered: number;
      source?: 'subscribe' | 'resume';
      afterEventId?: string;
      snapshotRequired?: boolean;
    }
  | { type: 'subscribed'; sessionId: string; eventCount: number }
  | { type: 'unsubscribed'; sessionId: string }
  | {
      type: 'session_list';
      sessions: Array<{
        sessionId: string;
        agentName?: string;
        eventCount: number;
        lastActivity: Date;
      }>;
    }
  | { type: 'typing_start'; sessionId: string }
  | { type: 'session_ended'; sessionId: string }
  | { type: 'session_expired'; sessionId: string; reason: string; reasonCode?: string }
  | {
      type: 'session_resumed';
      sessionId: string;
      state: AgentState;
      conversationHistory: ResumedConversationMessage[];
      agent?: AgentDetails;
    }
  | { type: 'tool_warnings'; sessionId: string; warnings: string[] }
  | {
      type: 'session_health';
      sessionId: string;
      health: Array<{ category: string; severity: string; code: string; message: string }>;
    }
  // Test context responses
  | { type: 'context_injected'; sessionId: string; updatedValues: Record<string, unknown> }
  | { type: 'tool_mock_set'; sessionId: string; mockCount: number }
  | {
      type: 'context_injection_error';
      sessionId: string;
      error: { code: string; message: string };
    }
  // Execution lifecycle events
  | {
      type: 'execution_queued';
      executionId: string;
      position: number;
      estimatedWaitMs?: number;
    }
  | { type: 'execution_started'; executionId: string; agentName: string }
  | {
      type: 'execution_cancelled';
      executionId: string;
      reason: 'preempted' | 'timeout' | 'client_cancel';
    }
  | {
      type: 'execution_rejected';
      reason: 'queue_full';
      message: string;
      queueDepth: number;
      retryAfterMs: number;
    }
  | {
      type: 'handoff_progress';
      sessionId: string;
      progress: HandoffProgress;
    }
  | {
      type: 'agent_switch';
      sessionId: string;
      agentName: string;
      agentDisplayName?: string;
      previousAgent?: string;
      mode: string;
    }
  | {
      type: 'status_update';
      sessionId: string;
      text: string;
      operation: string;
      transient: true;
      index: number;
      executionId?: string;
    }
  | { type: 'status_clear'; sessionId: string }
  // Auth preflight consent events (Phase 4)
  | {
      type: 'auth_required';
      sessionId: string;
      code: 'AUTH_PREFLIGHT_REQUIRED';
      pending: AuthRequirement[];
      satisfied: AuthRequirement[];
    }
  | {
      type: 'auth_gate_updated';
      sessionId: string;
      code: 'AUTH_PREFLIGHT_REQUIRED';
      pending: AuthRequirement[];
      satisfied: AuthRequirement[];
    }
  | {
      type: 'auth_gate_satisfied';
      sessionId: string;
      code: 'AUTH_PREFLIGHT_SATISFIED';
    }
  // JIT auth challenge (Phase 5)
  | {
      type: 'auth_challenge';
      sessionId: string;
      code: 'AUTH_JIT_REQUIRED';
      toolCallId: string;
      authType: string;
      authUrl?: string;
      profileId: string;
      profileName: string;
      prompt: string;
      timeoutMs: number;
    }
  | {
      type: 'message_queued';
      sessionId: string;
      reason: string;
      code: 'AUTH_PREFLIGHT_REQUIRED';
    }
  // SDK session lifecycle
  | {
      type: 'session_start';
      sessionId: string;
      projectId: string;
      permissions: { chat: boolean; voice: boolean };
      traceId?: string;
    }
  // SDK action delivery (distinct from action_taken — sent to SDK client to trigger UI action)
  | { type: 'action'; sessionId: string; action: ConstructAction }
  // Voice
  | { type: 'voice_token'; token: string; identity: string }
  | { type: 'voice_error'; message: string }
  | {
      type: 'voice_started';
      sessionId: string;
      voiceMode: string;
      capabilities?: VoiceSessionCapabilities;
    }
  | { type: 'voice_stopped'; sessionId: string }
  | { type: 'voice_barge_in_ack' }
  | { type: 'voice_realtime_audio'; audio: string; format: string }
  | { type: 'voice_realtime_transcript'; text: string; isFinal: boolean; role: string }
  // Omnichannel live sessions
  | { type: 'live_session_not_found' }
  | {
      type: 'live_session_discovered';
      sessionId: string;
      participants: OmnichannelParticipant[];
      liveSyncState: OmnichannelLiveSyncState;
    }
  | {
      type: 'live_session_join_error';
      success: false;
      error: { code: string; message: string };
    }
  | {
      type: 'live_session_joined';
      sessionId: string;
      participantId: string;
      backfill: OmnichannelTranscriptItem[];
      participants: OmnichannelParticipant[];
    }
  | {
      type: 'transcript_backfill';
      sessionId: string;
      items: Array<Record<string, unknown>>;
    }
  | {
      type: 'transcript_item';
      id: string;
      sessionId: string;
      role: 'user' | 'assistant' | 'system';
      content: string;
      channel: string;
      sourceChannel: string;
      inputMode: string;
      sequence: number;
      timestamp: Date;
      final: boolean;
      metadata?: OmnichannelTranscriptItem['metadata'];
    }
  | {
      type: 'participant_attached' | 'participant_detached';
      sessionId: string;
      participant: OmnichannelParticipant;
    };

// =============================================================================
// AUTH PREFLIGHT CONSENT
// =============================================================================

/** Auth requirement sent to client for preflight consent */
export interface AuthRequirement {
  /** Stable requirement identity for mixed connection modes and resolved refs */
  requirementKey?: string;
  /** Connector/provider name */
  connector: string;
  /** Auth profile name reference */
  authProfileRef: string;
  /** Stable auth profile identifier when the runtime resolved one */
  profileId?: string;
  /** Resolved profile environment (null for default fallback profiles) */
  environment?: string | null;
  /** OAuth scopes needed */
  scopes?: string[];
  /** Connection mode */
  connectionMode: 'per_user' | 'shared';
}

// =============================================================================
// HANDOFF PROGRESS
// =============================================================================

export type HandoffProgressPhase =
  | 'started'
  | 'waiting'
  | 'submitted'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'resumed';

export interface HandoffProgress {
  phase: HandoffProgressPhase;
  targetAgent: string;
  taskId?: string;
  async?: boolean;
  error?: string;
  durationMs?: number;
}

export interface VoiceSessionCapabilities {
  localBargeIn: boolean;
  remoteTypedInterrupt: boolean;
  dtmf: boolean;
  returnToParent: boolean;
  activeAgentSync: boolean;
}

export interface TraceEventWithId extends TraceEvent {
  id: string;
  sessionId: string;
  // Correlation
  traceId?: string;
  // Deployment context (enriched by trace emitter when available)
  deploymentId?: string;
  environment?: string;
  agentVersions?: Record<string, number>;
}

// =============================================================================
// TRANSCRIPTS
// =============================================================================

export interface TranscriptExport {
  id: string;
  name: string;
  agentId: string;
  agentName: string;
  createdAt: Date;
  scope?: {
    tenantId: string;
    projectId?: string;
    userId?: string;
    sessionId?: string;
  };
  messages: SessionMessage[];
  traceEvents: TraceEvent[];
  finalState: AgentState;
}
