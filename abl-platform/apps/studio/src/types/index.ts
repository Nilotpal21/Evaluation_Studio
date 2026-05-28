/**
 * Frontend Types
 *
 * Mirrors backend types for type safety
 */

import type { TestContextPayload, ContextInjection, ToolMockConfig } from './test-context';
import type { DecisionKind } from '../lib/event-types';
import type {
  ActionSet,
  MessageContentEnvelope,
  MessageRole,
  ResponseProvenance,
  RichContent,
  VoiceConfig,
} from '@agent-platform/web-sdk';
import type { ContentBlock } from '@abl/compiler/platform/llm/types.js';
export type { DecisionKind };

// =============================================================================
// AGENT TYPES
// =============================================================================

export interface AgentInfo {
  id: string;
  name: string;
  filePath?: string;
  type: 'agent' | 'supervisor';
  mode: 'reasoning' | 'scripted';
  toolCount: number;
  gatherFieldCount: number;
  isSupervisor: boolean;
}

export interface AgentDetails extends AgentInfo {
  dsl: string;
  ir?: unknown;
  errors?: string[];
  suggestedTests?: TestCase[];
}

// =============================================================================
// SESSION TYPES
// =============================================================================

export interface CsatData {
  provider: string;
  userId: string;
  botId: string;
  channel: string;
  surveyType: 'csat' | 'nps' | 'likeDislike';
  conversationId: string;
  orgId: string;
}

export interface SessionMessage {
  id: string;
  role: MessageRole;
  content: string;
  rawContent?: ContentBlock[];
  contentEnvelope?: MessageContentEnvelope;
  timestamp: Date;
  traceIds: string[];
  csatData?: CsatData;
  metadata?: {
    tokensIn?: number;
    tokensOut?: number;
    latencyMs?: number;
    isLlmGenerated?: boolean;
    responseProvenance?: ResponseProvenance;
    action?: ConstructAction;
    toolName?: string;
    agentName?: string;
    handoffFrom?: string;
    handoffTo?: string;
    localization?: Record<string, unknown>;
    attachmentFilenames?: string[];
    attachmentIds?: string[];
    attachmentMimeTypes?: string[];
    /** True when this thought card was created from a reason-only fallback (enableThinking off) */
    isReasoningFallback?: boolean;
    /** True when this thought card represents a scripted flow step */
    isStepThought?: boolean;
    /** The type of scripted step (respond, collect, set, call, condition, etc.) */
    stepType?: string;
    /** The name of the scripted step */
    stepName?: string;
    /** ID of the parent LLM call for thought-to-prompt correlation */
    llmCallId?: string;
    /** True when this message was reconstructed from trace events (not persisted to MongoDB) */
    synthetic?: boolean;
    /** True when the response text was truncated from traces (llm_call 2000 char limit) */
    truncated?: boolean;
  };
}

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

import type {
  TraceEvent as BaseTraceEvent,
  TraceEventType,
  ExtendedTraceEventType,
} from '@agent-platform/shared-kernel';
export type { TraceEventType, ExtendedTraceEventType };

export interface TraceEvent extends Omit<BaseTraceEvent, 'type'> {
  id: string;
  sessionId: string;
  traceId?: string;
  tenantId?: string;
  projectId?: string;
  type: ExtendedTraceEventType;
  /** Decision kind — only present when type === 'decision' */
  decisionKind?: DecisionKind;
}

export interface TraceExplorerRow {
  traceId: string;
  spanId: string;
  sessionId: string;
  agentName: string | null;
  environment: string | null;
  channel: string | null;
  type: string;
  status: 'ok' | 'error';
  startedAt: string;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  eventCount: number;
  errorCount: number;
  warningCount?: number;
  warnings?: Array<{
    code: string;
    message: string;
    severity: 'warning';
  }>;
  operatorDiagnostics?: Array<{
    code: string;
    customerMessage: string;
    operatorHint: string;
    traceId: string;
    severity: 'info' | 'warning' | 'error';
    category: 'llm' | 'tool' | 'runtime';
    agentName: string | null;
    toolName: string | null;
    recommendedAction: string | null;
  }>;
  preview: string;
}

// Extended trace event with span hierarchy for Observatory
export interface ExtendedTraceEvent {
  id: string;
  type: ExtendedTraceEventType;
  timestamp: Date;
  durationMs?: number;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  turnId?: string;
  executionId?: string;
  parentExecutionId?: string;
  agentRunId?: string;
  decisionId?: string;
  parentDecisionId?: string;
  causeEventId?: string;
  phase?: string;
  reasonCode?: string;
  sessionId: string;
  agentName: string;
  stepName?: string;
  data: Record<string, unknown>;
  metadata?: {
    severity?: 'debug' | 'info' | 'warn' | 'error';
    tags?: string[];
  };
}

// =============================================================================
// OBSERVATORY TYPES
// =============================================================================

export interface Span {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  startTime: Date;
  endTime?: Date;
  durationMs?: number;
  status: 'running' | 'completed' | 'error';
  agentName: string;
  sessionId: string;
  events: ExtendedTraceEvent[];
  attributes: Record<string, unknown>;
}

export interface SpanTreeNode {
  span: Span;
  children: SpanTreeNode[];
  depth: number;
}

export interface AgentFlowNode {
  id: string;
  agentName: string;
  mode: 'scripted' | 'reasoning';
  status: 'idle' | 'active' | 'completed' | 'error';
  enteredAt?: Date;
  exitedAt?: Date;
  turnCount: number;
}

export interface AgentFlowEdge {
  id: string;
  from: string;
  to: string;
  type: 'handoff' | 'delegate' | 'return';
  timestamp: Date;
  label?: string;
}

export type BreakpointType = 'agent' | 'step' | 'event' | 'condition';

export interface Breakpoint {
  id: string;
  type: BreakpointType;
  spec: {
    agentName?: string;
    stepName?: string;
    eventType?: ExtendedTraceEventType;
    condition?: string;
    on?: 'entry' | 'exit' | 'both';
  };
  enabled: boolean;
  hitCount: number;
}

export type DebugState = 'disconnected' | 'connected' | 'running' | 'paused' | 'stepping';

export interface DebugSession {
  id: string;
  name: string;
  currentAgent: string;
  state: DebugState;
  startedAt: Date;
  turnCount: number;
}

// =============================================================================
// STATIC GRAPH TYPES (State Machine Visualization)
// =============================================================================

/**
 * Static graph node types for state machine visualization
 */
export type StaticNodeType =
  | 'entry' // Flow entry point
  | 'step' // Regular flow step
  | 'decision' // ON_INPUT branch point (deterministic)
  | 'llm_decision' // Intent classification (non-deterministic)
  | 'guard' // Constraint check gate (CHECK directive)
  | 'exit'; // Completion/terminal

/**
 * Static graph edge types
 */
export type StaticEdgeType =
  | 'sequential' // Simple THEN
  | 'conditional' // ON_INPUT branch with condition
  | 'success' // ON_SUCCESS path
  | 'failure' // ON_FAILURE path
  | 'error' // ON_FAIL path
  | 'digression'; // Intent-based jump

/**
 * Node in the static execution graph
 */
export interface StaticGraphNode {
  id: string;
  type: StaticNodeType;
  label: string;
  deterministic: boolean;
  step?: {
    collect?: string[];
    prompt?: string;
    call?: string;
    respond?: string;
    check?: string; // Reference to constraint phase
  };
  conditions?: string[]; // For decision nodes
  /** Constraint info for guard nodes */
  constraints?: {
    phaseName: string;
    requirements: Array<{
      condition: string;
      onFail: {
        type: 'respond' | 'escalate' | 'handoff' | 'block';
        message?: string;
      };
    }>;
  };
}

/**
 * Edge in the static execution graph
 */
export interface StaticGraphEdge {
  id: string;
  from: string;
  to: string;
  type: StaticEdgeType;
  label?: string; // Condition text
  isDefault?: boolean; // ELSE branch
}

/**
 * Complete static graph for state machine visualization
 */
export interface StaticGraph {
  nodes: StaticGraphNode[];
  edges: StaticGraphEdge[];
  entryPoint: string;
}

/**
 * Execution state for a node in the state machine
 */
export type NodeExecutionState = 'unvisited' | 'active' | 'visited';

// =============================================================================
// APP-LEVEL TYPES (Multi-Agent Visualization)
// =============================================================================

/**
 * App configuration for multi-agent visualization
 */
export interface AppConfig {
  /** App name (e.g., "traveldesk", "saludsa") */
  name: string;

  /** Entry agent - the starting point (typically supervisor) */
  entryAgent: string;

  /** All agents in this app */
  agents: string[];

  /** Inter-agent connections */
  connections: AgentConnection[];
}

/**
 * Connection between agents
 */
export interface AgentConnection {
  from: string;
  to: string;
  type: 'handoff' | 'delegate';
  when?: string;
  returns: boolean;
  label?: string;
}

/**
 * Inter-agent edge for app visualization
 */
export interface InterAgentEdge {
  id: string;
  fromAgent: string;
  fromNode?: string;
  toAgent: string;
  toNode?: string;
  type: 'handoff' | 'delegate';
  label?: string;
  returns: boolean;
}

/**
 * Layout hints for app visualization
 */
export interface AppLayoutHints {
  agentPositions: Record<string, { row: number; col: number }>;
  entryPosition: 'top' | 'left';
  direction: 'horizontal' | 'vertical';
}

/**
 * Combined static graph for app-level visualization
 */
export interface AppStaticGraph {
  app: AppConfig;
  agentGraphs: Record<string, StaticGraph>;
  interAgentEdges: InterAgentEdge[];
  layout: AppLayoutHints;
}

// =============================================================================
// SESSION LIST TYPES (Sidebar)
// =============================================================================

export interface SessionListItem {
  id: string;
  agentId: string;
  agentName: string;
  status: string;
  /** Pre-computed duration in ms (endedAt-startedAt or lastActivityAt-startedAt) */
  durationMs: number;
  messageCount: number;
  traceEventCount: number;
  tokenCount: number;
  estimatedCost: number;
  errorCount: number;
  disposition?: string | null;
  channel?: string;
  environment?: string;
  createdAt: string;
  lastActivityAt: string;
}

// =============================================================================
// ACTION TYPES
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
// TEST TYPES
// =============================================================================

export interface TestCase {
  id: string;
  name: string;
  description: string;
  category: 'happy_path' | 'edge_case' | 'constraint' | 'handoff' | 'error';
  inputs: string[];
  expectations?: TestExpectation[];
}

export interface TestExpectation {
  type: 'action' | 'response_contains' | 'state_contains' | 'trace_event';
  value: string;
}

// =============================================================================
// WEBSOCKET MESSAGE TYPES
// =============================================================================

export type ClientMessage =
  | {
      type: 'load_agent';
      agentPath: string;
      projectId: string;
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
  | {
      type: 'action_submit';
      sessionId: string;
      actionId: string;
      value?: string;
      formData?: Record<string, unknown>;
      renderId?: string;
    }
  | { type: 'run_test'; sessionId: string; testId: string }
  | { type: 'get_state'; sessionId: string }
  | { type: 'resume_session'; sessionId: string; lastSeenTraceEventId?: string }
  // Test context
  | {
      type: 'load_agent_with_context';
      agentPath: string;
      projectId: string;
      context: TestContextPayload;
    }
  | { type: 'inject_context'; sessionId: string; injection: ContextInjection }
  | { type: 'set_tool_mocks'; sessionId: string; mocks: ToolMockConfig[] }
  | { type: 'clear_tool_mocks'; sessionId: string }
  // Auth consent (Phase 4)
  | { type: 'consent_satisfy'; sessionId: string; authProfileRef: string; requirementKey?: string }
  // JIT auth response (Phase 5)
  | { type: 'auth_response'; toolCallId: string; status: 'completed' | 'cancelled' };

export type ServerMessage =
  | { type: 'agent_loaded'; sessionId: string; agent: AgentDetails }
  | { type: 'agent_load_error'; error: string }
  | { type: 'response_start'; sessionId: string; messageId: string }
  | { type: 'response_chunk'; sessionId: string; messageId: string; chunk: string }
  | {
      type: 'response_end';
      sessionId: string;
      messageId: string;
      fullText: string;
      voiceConfig?: VoiceConfig | null;
      richContent?: RichContent | null;
      actions?: ActionSet | null;
      localization?: Record<string, unknown> | null;
      sourceChannel?: string;
      metadata?: SessionMessage['metadata'];
      citations?: Array<{
        index: number;
        title: string;
        url: string;
        sourceType: 'connector' | 'upload' | 'crawled';
        documentId?: string;
        pageNumber?: number;
      }>;
    }
  | { type: 'trace_event'; sessionId: string; event: TraceEvent }
  | {
      type: 'trace_replay';
      sessionId: string;
      events: TraceEvent[];
      totalBuffered: number;
      source?: 'subscribe' | 'resume';
      afterEventId?: string;
      snapshotRequired?: boolean;
    }
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
  | {
      type: 'session_resumed';
      sessionId: string;
      state: AgentState;
      agent?: AgentDetails;
      conversationHistory: Array<{
        id?: string;
        role: string;
        content: string;
        rawContent?: ContentBlock[];
        contentEnvelope?: SessionMessage['contentEnvelope'];
        metadata?: SessionMessage['metadata'];
      }>;
    }
  | { type: 'session_expired'; sessionId: string; reason: string; reasonCode?: string }
  | { type: 'error'; message: string }
  | { type: 'info'; message: string; configured: boolean }
  // Test context responses
  | { type: 'context_injected'; sessionId: string; updatedValues: Record<string, unknown> }
  | { type: 'tool_mock_set'; sessionId: string; mockCount: number }
  | {
      type: 'context_injection_error';
      sessionId: string;
      error: { code: string; message: string };
    }
  | {
      type: 'session_health';
      sessionId: string;
      health: Array<{
        category: string;
        severity: string;
        code: string;
        message: string;
      }>;
    }
  | { type: 'tool_warnings'; sessionId: string; warnings: string[] }
  // Auth preflight consent events (Phase 4)
  | {
      type: 'auth_required';
      sessionId: string;
      code?: 'AUTH_PREFLIGHT_REQUIRED';
      pending: Array<{
        requirementKey?: string;
        connector: string;
        authProfileRef: string;
        profileId?: string;
        environment?: string | null;
        scopes?: string[];
        connectionMode: 'per_user' | 'shared';
      }>;
      satisfied: Array<{
        requirementKey?: string;
        connector: string;
        authProfileRef: string;
        profileId?: string;
        environment?: string | null;
        scopes?: string[];
        connectionMode: 'per_user' | 'shared';
      }>;
    }
  | {
      type: 'auth_gate_updated';
      sessionId: string;
      code?: 'AUTH_PREFLIGHT_REQUIRED';
      pending: Array<{
        requirementKey?: string;
        authProfileRef: string;
        connectionMode?: 'per_user' | 'shared';
      }>;
      satisfied: Array<{
        requirementKey?: string;
        authProfileRef: string;
        connectionMode?: 'per_user' | 'shared';
      }>;
    }
  | { type: 'auth_gate_satisfied'; sessionId: string; code?: 'AUTH_PREFLIGHT_SATISFIED' }
  // Status filler messages (transient, not persisted)
  | {
      type: 'status_update';
      sessionId: string;
      text: string;
      operation: string;
      transient: true;
      index: number;
    }
  | { type: 'status_clear'; sessionId: string }
  // JIT auth challenge (Phase 5)
  | {
      type: 'auth_challenge';
      sessionId: string;
      code?: 'AUTH_JIT_REQUIRED';
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
      code?: 'AUTH_PREFLIGHT_REQUIRED';
    }
  // Agent transfer events (inbound from human agent via webhook)
  | {
      type: 'agent_transfer_event';
      sessionId: string;
      event: {
        type: string;
        data?: Record<string, unknown>;
        timestamp?: string;
      };
    };
