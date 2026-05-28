/**
 * Canonical TraceEventType definitions for the ABL platform.
 *
 * Shared-kernel owns the complete event inventory. Observatory re-exports the
 * canonical event types/constants and layers typed payload models on top.
 */
import type { TraceEventType } from '@agent-platform/shared-kernel';

export {
  ALL_TRACE_EVENT_TYPES,
  RUNTIME_EVENT_TYPES,
  TRACE_EVENT_GROUPS,
  TRACE_EVENT_REGISTRY,
} from '@agent-platform/shared-kernel';
export type {
  A2ATraceEventType,
  AgentTraceEventType,
  AttachmentTraceEventType,
  ChannelTraceEventType,
  CoreTraceEventType,
  DelegationTraceEventType,
  DSLTraceEventType,
  EngineTraceEventType,
  ErrorHandlerTraceEventType,
  ExtendedTraceEventType,
  ExtractionTraceEventType,
  FanOutTraceEventType,
  FlowTraceEventType,
  GuardrailTraceEventType,
  MemoryTraceEventType,
  RuntimeEventType,
  SessionTraceEventType,
  SpanTraceEventType,
  StatusTraceEventType,
  SuspensionTraceEventType,
  ToolTraceEventType,
  TraceEventDomain,
  TraceEventRegistryEntry,
  VoiceTraceEventType,
} from '@agent-platform/shared-kernel';
export type { TraceEventType } from '@agent-platform/shared-kernel';

/**
 * Event severity levels
 */
export type TraceSeverity = 'debug' | 'info' | 'warn' | 'error';

/**
 * Extended trace event with hierarchical span support
 */
export interface ExtendedTraceEvent {
  /** Unique event identifier */
  id: string;

  /** Event type */
  type: TraceEventType;

  /** When the event occurred */
  timestamp: Date;

  /** Duration in milliseconds (for events with start/end) */
  durationMs?: number;

  // === Hierarchical Tracing (OpenTelemetry-compatible) ===

  /** Trace ID - groups all events in a request/session */
  traceId: string;

  /** Span ID - unique identifier for this span */
  spanId: string;

  /** Parent span ID - for hierarchical nesting */
  parentSpanId?: string;

  // === Context ===

  /** Session identifier */
  sessionId: string;

  /** Current agent name */
  agentName: string;

  /** Current flow step (for scripted mode) */
  stepName?: string;

  // === Payload ===

  /** Event-specific data */
  data: TraceEventData;

  /** Optional metadata */
  metadata?: TraceEventMetadata;
}

/**
 * Event metadata
 */
export interface TraceEventMetadata {
  /** Severity level */
  severity?: TraceSeverity;

  /** Tags for filtering */
  tags?: string[];

  /** Source file/line for debugging */
  source?: {
    file?: string;
    line?: number;
  };
}

/**
 * Type-safe event data by event type
 */
export type TraceEventData =
  | LLMCallData
  | ToolCallData
  | DecisionData
  | ConstraintCheckData
  | HandoffData
  | EscalationData
  | ErrorData
  | SessionStartData
  | SessionEndData
  | AgentEnterData
  | AgentExitData
  | FlowStepEnterData
  | FlowStepExitData
  | FlowTransitionData
  | EntityExtractionData
  | DelegateStartData
  | DelegateCompleteData
  | AttachmentUploadData
  | AttachmentScanData
  | AttachmentProcessData
  | AttachmentIndexData
  | AttachmentDeleteData
  | Record<string, unknown>;

// === Event-specific data types ===

export interface LLMCallData {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  prompt?: string;
  response?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ToolCallData {
  toolName: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  success: boolean;
  errorMessage?: string;
  toolType?: string;
  authType?: string;
  endpoint?: string;
  mcpServer?: string;
  sandboxRuntime?: string;
  lambdaFunction?: string;
  retryCount?: number;
  circuitBreakerState?: string;
}

export interface DecisionData {
  decisionKind: 'routing' | 'action' | 'response' | 'flow';
  options?: string[];
  chosen: string;
  reasoning?: string;
  confidence?: number;
}

export interface ConstraintCheckData {
  constraintName: string;
  constraintType: string;
  passed: boolean;
  value?: unknown;
  message?: string;
}

export interface HandoffData {
  fromAgent: string;
  toAgent: string;
  reason: string;
  context?: Record<string, unknown>;
}

export interface EscalationData {
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  context?: Record<string, unknown>;
}

export interface ErrorData {
  errorType: string;
  message: string;
  stack?: string;
  recoverable: boolean;
}

export interface SessionStartData {
  userId?: string;
  channel?: string;
  initialContext?: Record<string, unknown>;
}

export interface SessionEndData {
  reason: 'completed' | 'timeout' | 'error' | 'user_exit';
  totalDurationMs: number;
  totalTurns: number;
}

export interface AgentEnterData {
  mode: 'scripted' | 'reasoning';
  trigger: 'routing' | 'handoff' | 'delegate' | 'initial';
  inputMessage?: string;
}

export interface AgentExitData {
  mode: 'scripted' | 'reasoning';
  result: 'complete' | 'handoff' | 'escalate' | 'error';
  response?: string;
  nextAgent?: string;
}

export interface FlowStepEnterData {
  stepId: string;
  stepType: 'respond' | 'wait_input' | 'if' | 'goto' | 'action' | 'signal';
}

export interface FlowStepExitData {
  stepId: string;
  outcome: 'success' | 'condition_false' | 'error';
}

export interface FlowTransitionData {
  fromStep: string;
  toStep: string;
  trigger: 'sequential' | 'goto' | 'intent_match' | 'condition';
  matchedIntent?: string;
  condition?: string;
}

export interface EntityExtractionData {
  entities: Array<{
    name: string;
    value: unknown;
    source: 'input' | 'llm' | 'tool';
    confidence?: number;
  }>;
  rawInput: string;
}

export interface DelegateStartData {
  targetAgent: string;
  delegationType: 'sync' | 'async';
  input: Record<string, unknown>;
}

export interface DelegateCompleteData {
  targetAgent: string;
  success: boolean;
  result?: unknown;
  errorMessage?: string;
}

// === Attachment lifecycle data types ===

export interface AttachmentUploadData {
  attachmentId: string;
  tenantId: string;
  projectId: string;
  sessionId: string;
  filename: string;
  mimeType: string;
  category: string;
  sizeBytes: number;
  storageProvider: string;
  deduplicated: boolean;
}

export interface AttachmentScanData {
  attachmentId: string;
  tenantId: string;
  scanStatus: 'clean' | 'infected' | 'error';
  engine: string;
  threats?: string[];
}

export interface AttachmentProcessData {
  attachmentId: string;
  tenantId: string;
  category: string;
  processingEngine: string;
  processingStatus: 'completed' | 'failed' | 'skipped';
  processingError?: string;
  outputKeys?: string[];
}

export interface AttachmentIndexData {
  attachmentId: string;
  tenantId: string;
  searchIndexId: string;
  searchDocumentId: string;
  embeddingStatus: 'completed' | 'failed';
}

export interface AttachmentDeleteData {
  attachmentId: string;
  tenantId: string;
  reason: 'explicit' | 'session_cascade' | 'ttl_expiry' | 'infected';
  storageKeysDeleted: number;
}

/**
 * Helper to create a trace event with defaults
 */
export function createTraceEvent(
  partial: Partial<ExtendedTraceEvent> &
    Pick<ExtendedTraceEvent, 'type' | 'traceId' | 'sessionId' | 'agentName' | 'data'>,
): ExtendedTraceEvent {
  return {
    id: partial.id ?? generateEventId(),
    timestamp: partial.timestamp ?? new Date(),
    spanId: partial.spanId ?? generateSpanId(),
    ...partial,
  };
}

/**
 * Generate a unique event ID
 */
export function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Generate a unique span ID (W3C Trace Context compatible)
 */
export function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate a trace ID (W3C Trace Context compatible)
 */
export function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
