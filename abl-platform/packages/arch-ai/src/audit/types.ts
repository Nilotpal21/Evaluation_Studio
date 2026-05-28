/**
 * Arch AI Audit Log Types
 *
 * Event categories with typed detail payloads.
 * Used by AuditLogEmitter and API endpoints.
 */

export type AuditLogCategory =
  | 'llm_call'
  | 'tool_execution'
  | 'phase_transition'
  | 'user_action'
  | 'build_event'
  | 'editor_mode_event'
  | 'error'
  | 'system_event';

export type AuditLogSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface AuditLogTokens {
  input: number;
  output: number;
  total: number;
  estimatedCost: number;
}

export type AuditSpanKind = 'phase' | 'turn' | 'llm_call' | 'tool_call';

export interface AuditLogEntry {
  category: AuditLogCategory;
  severity: AuditLogSeverity;
  summary: string;
  detail: Record<string, unknown>;
  specialist?: string;
  phase?: string;
  durationMs?: number;
  tokens?: AuditLogTokens;
  projectId?: string;
  turnId?: string;
  parentEventId?: string;
  phaseLabel?: string;
  retryOf?: string;
  retryIndex?: number;
  nestingDepth?: number;
  spanKind?: AuditSpanKind;
}

export interface AuditEmitterContext {
  tenantId: string;
  userId: string;
  sessionId: string;
}

// ─── Detail Payload Types (per category) ────────────────────────────────

export interface LLMCallDetail {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  finishReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop' | 'length' | 'unknown';
  specialist: string;
  stepIndex: number;
  totalSteps?: number;
}

export interface ToolExecutionDetail {
  toolCallId: string;
  toolName: string;
  inputSummary: string;
  resultStatus: 'success' | 'error';
  durationMs: number;
  retryCount: number;
  agentName?: string;
}

export interface PhaseTransitionDetail {
  from: string;
  to: string;
  trigger: 'auto' | 'user_action' | 'gate_pass';
  durationInPreviousPhaseMs?: number;
  messageCountInPhase?: number;
}

export interface UserActionDetail {
  action:
    | 'message_sent'
    | 'gate_approved'
    | 'gate_rejected'
    | 'agent_reviewed'
    | 'file_uploaded'
    | 'file_removed'
    | 'backtrack_requested'
    | 'topology_approved'
    | 'build_started'
    | 'project_created'
    | 'session_archived'
    | 'quality_gate_overridden';
  detail?: string;
}

export interface BuildEventDetail {
  event:
    | 'agent_generation_start'
    | 'agent_compiled'
    | 'agent_enriched'
    | 'agent_error'
    | 'cross_validation_run'
    | 'build_complete'
    | 'compile_fix_round'
    | 'quality_floor_check';
  agentName: string;
  status?: 'pass' | 'warning' | 'error';
  constructsUsed?: string[];
  qualityFloor?: Record<string, boolean>;
  warnings?: string[];
}

export interface ErrorDetail {
  errorCode:
    | 'llm_timeout'
    | 'compile_error'
    | 'rate_limit'
    | 'context_exceeded'
    | 'session_busy'
    | 'invalid_transition'
    | 'tool_error'
    | 'network_error'
    | 'unknown';
  message: string;
  source: 'llm' | 'compiler' | 'tool' | 'session' | 'system';
  recoveryAction?: 'retried' | 'degraded' | 'aborted' | 'user_notified';
}

export interface SystemEventDetail {
  event:
    | 'session_created'
    | 'session_archived'
    | 'session_recovered'
    | 'config_changed'
    | 'model_changed'
    | 'credential_source_changed'
    | 'file_context_evicted'
    | 'file_context_included'
    | 'stuck_session_cleanup';
  detail?: string;
  previousValue?: unknown;
  newValue?: unknown;
}

export const AUDIT_LOG_CATEGORIES: readonly AuditLogCategory[] = [
  'llm_call',
  'tool_execution',
  'phase_transition',
  'user_action',
  'build_event',
  'editor_mode_event',
  'error',
  'system_event',
] as const;

export const AUDIT_LOG_SEVERITIES: readonly AuditLogSeverity[] = [
  'info',
  'warning',
  'error',
  'critical',
] as const;
