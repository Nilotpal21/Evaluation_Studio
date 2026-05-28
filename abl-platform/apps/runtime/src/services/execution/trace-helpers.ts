/**
 * Trace Helpers — Verbosity-aware trace event emission.
 *
 * Trace verbosity levels (cumulative):
 * - minimal: errors, escalations, completion
 * - standard: above + step transitions, tool calls, constraint checks
 * - verbose: above + all decision traces (extraction, memory, gather, corrections)
 * - debug: above + LLM prompts/responses, raw extraction data
 */

export const VERBOSITY_LEVELS = { minimal: 0, standard: 1, verbose: 2, debug: 3 } as const;

export type TraceVerbosity = keyof typeof VERBOSITY_LEVELS;

export type DecisionKind =
  | 'handoff'
  | 'delegation'
  | 'flow_transition'
  | 'field_validation'
  | 'escalation'
  | 'completion'
  | 'constraint_check'
  | 'guardrail_check'
  | 'gather_extraction'
  | 'correction'
  | 'data_mutation'
  | 'await_attachment';

/**
 * Map each trace event type to the minimum verbosity level required to emit it.
 *
 * CONTRACT: Every key here must exist in RUNTIME_EVENT_TYPES
 * (packages/shared-kernel/src/constants/trace-event-registry.ts).
 * A contract test in shared-kernel verifies sync.
 */
const EVENT_VERBOSITY: Record<string, number> = {
  // minimal (always emitted)
  error: 0,
  escalation: 0,
  completion_check: 0,
  warning: 0,
  decision: 1,
  // standard
  flow_step_enter: 1,
  flow_step_exit: 1,
  flow_transition: 1,
  step_thought: 1,
  tool_call: 1,
  tool_thought: 1,
  constraint_check: 1,
  constraint_violation: 1,
  handoff: 1,
  dsl_collect: 1,
  dsl_prompt: 1,
  dsl_respond: 1,
  dsl_set: 1,
  dsl_on_input: 1,
  dsl_call: 1,
  dsl_await_attachment: 1,
  correction: 1,
  user_message: 1,
  turn_start: 1,
  turn_end: 1,
  session_resolution: 1,
  status_update: 1,
  status_clear: 1,
  memory_init: 1,
  memory_remember: 1,
  memory_recall: 1,
  memory_error: 1,
  memory_preferences: 1,
  memory_dedup_skipped: 1,
  agent_enter: 1,
  agent_exit: 1,
  delegate_start: 1,
  delegate_complete: 1,
  routing_capabilities_resolved: 1,
  handoff_condition_check: 1,
  handoff_return_handler: 1,
  resume_intent: 1,
  thread_resume: 1,
  thread_return: 1,
  return_to_parent: 1,
  data_stored: 1,
  digression: 1,
  sub_intent: 1,
  pipeline_intent_bridge: 1,
  pipeline_tiered_action: 1,
  pipeline_out_of_scope_decline: 1,
  // verbose (decision traces)
  extraction_strategy_resolved: 2,
  extraction_attempt: 2,
  extraction_parse_fallback: 2,
  extraction_fallback: 2,
  memory_trigger_evaluated: 2,
  memory_recall_result: 2,
  memory_unavailable: 2,
  preference_detected: 2,
  constraint_backtrack: 2,
  constraint_backtrack_limit: 2,
  constraint_directive: 2,
  constraint_mini_collect: 2,
  gather_field_activation: 2,
  gather_complete_reason: 2,
  correction_invalidation: 2,
  validation_fail_open: 2,
  // debug (everything)
  llm_call: 3,
  engine_decision: 3,
};

/**
 * Check whether a trace event should be emitted at the given verbosity level.
 */
export function shouldEmitTrace(
  eventType: string,
  verbosity: TraceVerbosity = 'standard',
): boolean {
  const requiredLevel = EVENT_VERBOSITY[eventType] ?? 1; // default to standard
  return VERBOSITY_LEVELS[verbosity] >= requiredLevel;
}

/**
 * Emit a decision trace event, respecting verbosity settings.
 * No-ops if onTraceEvent is undefined or verbosity is too low.
 */
/** Map each decision kind to its minimum verbosity level */
export const DECISION_KIND_VERBOSITY: Record<DecisionKind, number> = {
  // standard (1)
  handoff: 1,
  delegation: 1,
  flow_transition: 1,
  field_validation: 1,
  escalation: 1,
  completion: 1,
  constraint_check: 1,
  guardrail_check: 1,
  // verbose (2)
  gather_extraction: 2,
  correction: 2,
  data_mutation: 2,
  await_attachment: 2,
};

/**
 * Check whether a decision of the given kind should be emitted at the given verbosity level.
 */
export function shouldEmitDecision(
  decisionKind: DecisionKind,
  verbosity: TraceVerbosity = 'standard',
): boolean {
  const requiredLevel = DECISION_KIND_VERBOSITY[decisionKind] ?? 1;
  return VERBOSITY_LEVELS[verbosity] >= requiredLevel;
}

/**
 * Emit a decision event via onTraceEvent callback, respecting kind-level verbosity.
 * Replaces appendDecision + shouldLogDecisions pattern.
 * No-ops if onTraceEvent is undefined or verbosity is too low for the given kind.
 */
export function emitDecisionEvent(
  onTraceEvent: ((event: { type: string; data: Record<string, unknown> }) => void) | undefined,
  verbosity: TraceVerbosity | undefined,
  kind: DecisionKind,
  metadata: Record<string, unknown>,
): void {
  if (!onTraceEvent) return;
  if (!shouldEmitDecision(kind, (verbosity ?? 'standard') as TraceVerbosity)) return;
  onTraceEvent({
    type: 'decision',
    data: { decisionKind: kind, ...metadata },
  });
}

/**
 * Extract safe HTTP metadata from an IR tool binding for trace events.
 * Includes method, endpoint, auth type/header info, static header names,
 * and query params — but NEVER actual secrets or token values.
 */
export function buildHttpTraceMeta(binding: {
  method: string;
  endpoint: string;
  auth?: {
    type: string;
    config?: {
      headerName?: string;
      headerPrefix?: string;
      customHeaders?: Record<string, string>;
    };
  };
  headers?: Record<string, string>;
  query_params?: Record<string, string>;
}): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    method: binding.method,
    endpoint: binding.endpoint,
  };

  if (binding.auth) {
    meta.authType = binding.auth.type;
    if (binding.auth.config?.headerName) {
      meta.authHeaderName = binding.auth.config.headerName;
    }
    if (binding.auth.config?.headerPrefix) {
      meta.authHeaderPrefix = binding.auth.config.headerPrefix;
    }
  }

  // Emit static header names (keys only — values may contain secret templates)
  if (binding.headers) {
    meta.headerNames = Object.keys(binding.headers);
  }

  // Emit query param names only (keys only — values may contain API keys, tokens, or PII)
  if (binding.query_params) {
    meta.queryParamNames = Object.keys(binding.query_params);
  }

  return meta;
}

export function emitDecisionTrace(
  onTraceEvent: ((event: { type: string; data: Record<string, unknown> }) => void) | undefined,
  verbosity: 'minimal' | 'standard' | 'verbose' | 'debug' | undefined,
  type: string,
  data: Record<string, unknown>,
): void {
  if (!onTraceEvent) return;
  if (!shouldEmitTrace(type, (verbosity ?? 'standard') as TraceVerbosity)) return;
  onTraceEvent({ type, data });
}

// =============================================================================
// FLOW tool-call trace builders — ABLP-1094
//
// The Debug UI's TOOL CALL card binds Input/Output/RawEvents to a single
// completed `tool_call` event identified by `toolCallId`. The reasoning
// executor emits this shape after every LLM-driven tool call. The FLOW step
// path historically emitted a bare `tool_call` (no toolCallId, no output) and
// a separate `tool_result` (no toolCallId), so the orphan result rendered as
// a second card lower down with no canonical tool name, and the primary card
// stopped at Input. These builders align the FLOW path with the LLM path.
// =============================================================================

export interface FlowToolCallStartInput {
  toolCallId: string;
  toolName: string;
  input: unknown;
  agent: string;
  httpMeta?: Record<string, unknown>;
}

export interface FlowToolCallCompletionInput {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  success: boolean;
  latencyMs: number;
  agent: string;
  error?: string;
  errorCode?: string;
  errorEnvelope?: Record<string, unknown>;
  diagnostic?: Record<string, unknown> | string;
  httpMeta?: Record<string, unknown>;
}

function isActionToolName(toolName: string): boolean {
  return (
    toolName.startsWith('__') ||
    toolName.startsWith('handoff_to_') ||
    toolName.startsWith('delegate_to_')
  );
}

export function buildFlowToolCallStartTraceData(
  input: FlowToolCallStartInput,
): Record<string, unknown> {
  return {
    ...(input.httpMeta ?? {}),
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    tool: input.toolName,
    input: input.input,
    isActionTool: isActionToolName(input.toolName),
    agent: input.agent,
  };
}

export function buildFlowToolCallCompletionTraceData(
  input: FlowToolCallCompletionInput,
): Record<string, unknown> {
  return {
    ...(input.httpMeta ?? {}),
    phase: 'complete',
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    tool: input.toolName,
    input: input.input,
    output: input.output,
    success: input.success,
    latencyMs: input.latencyMs,
    isActionTool: isActionToolName(input.toolName),
    agent: input.agent,
    ...(input.error ? { error: input.error } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(input.errorEnvelope ? { errorEnvelope: input.errorEnvelope } : {}),
    ...(input.diagnostic ? { diagnostic: input.diagnostic } : {}),
  };
}
