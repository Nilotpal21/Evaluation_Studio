/**
 * Trace Event Registry
 *
 * Shared-kernel owns the canonical cross-package trace event contract.
 * Runtime, Observatory, Studio, and downstream tooling should consume this
 * inventory instead of maintaining local unions.
 */

export const CORE_TRACE_EVENT_TYPES = [
  'llm_call',
  'tool_call',
  'decision',
  'constraint_check',
  'handoff',
  'escalation',
  'error',
] as const;
export type CoreTraceEventType = (typeof CORE_TRACE_EVENT_TYPES)[number];

export const SESSION_TRACE_EVENT_TYPES = [
  'session_start',
  'session_end',
  'session_ended',
  'session_created',
  'session_updated',
  'session_resolution',
  'turn_start',
  'turn_end',
  'user_message',
  'agent_response',
] as const;
export type SessionTraceEventType = (typeof SESSION_TRACE_EVENT_TYPES)[number];

export const AGENT_TRACE_EVENT_TYPES = [
  'agent_enter',
  'agent_exit',
  'agent_lifecycle',
  'agent_switch',
  'profile_resolution',
  'agent_error_handled',
  'behavior_profile_applied',
  'hook_executed',
  'escalation_triggered',
  'escalation_resolved',
  'itsm_ticket_created',
] as const;
export type AgentTraceEventType = (typeof AGENT_TRACE_EVENT_TYPES)[number];

export const FLOW_TRACE_EVENT_TYPES = [
  'flow_step_enter',
  'flow_step_exit',
  'flow_transition',
  'step_thought',
  'action_handler_executed',
] as const;
export type FlowTraceEventType = (typeof FLOW_TRACE_EVENT_TYPES)[number];

export const DELEGATION_TRACE_EVENT_TYPES = ['delegate_start', 'delegate_complete'] as const;
export type DelegationTraceEventType = (typeof DELEGATION_TRACE_EVENT_TYPES)[number];

export const DSL_TRACE_EVENT_TYPES = [
  'dsl_collect',
  'dsl_prompt',
  'dsl_respond',
  'dsl_set',
  'dsl_on_input',
  'dsl_call',
  'dsl_on_start',
  'dsl_await_attachment',
] as const;
export type DSLTraceEventType = (typeof DSL_TRACE_EVENT_TYPES)[number];

export const ENGINE_TRACE_EVENT_TYPES = [
  'completion_check',
  'engine_decision',
  'routing_capabilities_resolved',
  'deterministic_routing',
  'deterministic_handoff',
  'handoff_condition_check',
  'handoff_return_handler',
  'resume_intent',
  'thread_resume',
  'thread_return',
  'return_to_parent',
  'data_stored',
  'digression',
  'sub_intent',
  'correction',
  'correction_invalidation',
  'constraint_violation',
  'validation_fail_open',
  'pipeline_intent_bridge',
  'pipeline_tiered_action',
  'pipeline_out_of_scope_decline',
  'warning',
] as const;
export type EngineTraceEventType = (typeof ENGINE_TRACE_EVENT_TYPES)[number];

export const TOOL_TRACE_EVENT_TYPES = [
  'tool.resolution.start',
  'tool.resolution.complete',
  'tool.compilation.per_tool',
  'tool.compilation.complete',
  'tool.compilation.timeout',
  'tool.validation.pass',
  'tool.validation.fail',
  'tool.stale.detected',
  'tool_thought',
  'tool_error',
  'tool_result',
  'tool_call_start',
  'tool_call_error',
  'tool_call_retry',
  'tool_auth_resolved',
] as const;
export type ToolTraceEventType = (typeof TOOL_TRACE_EVENT_TYPES)[number];

export const AUTH_PROFILE_TRACE_EVENT_TYPES = [
  'mcp.auth_resolved',
  'mcp.auth_refreshed',
  'tool_test.auth_resolved',
] as const;
export type AuthProfileTraceEventType = (typeof AUTH_PROFILE_TRACE_EVENT_TYPES)[number];

export const EXTRACTION_TRACE_EVENT_TYPES = [
  'entity_extraction',
  'gather_extraction',
  'extraction_tier_selected',
  'extraction_attempt',
  'extraction_fallback',
  'extraction_strategy_resolved',
  'extraction_parse_fallback',
  'gather_field_activation',
  'gather_complete_reason',
  'constraint_backtrack',
  'constraint_backtrack_limit',
  'constraint_directive',
  'constraint_mini_collect',
  'inference_requested',
  'inference_result',
  'inference_confirmation_requested',
  'inference_accepted',
  'inference_rejected',
  'lookup_match',
  'lookup_fuzzy_confirmation_requested',
  'lookup_fuzzy_accepted',
  'lookup_fuzzy_rejected',
  'multi_intent_queue_accepted',
  'multi_intent_queue_declined',
  'multi_intent_queue_surfaced',
  'multi_intent_disambiguate_requested',
  'multi_intent_disambiguate_choice',
  'validation_max_retries',
] as const;
export type ExtractionTraceEventType = (typeof EXTRACTION_TRACE_EVENT_TYPES)[number];

export const FAN_OUT_TRACE_EVENT_TYPES = [
  'fan_out_start',
  'fan_out_task_start',
  'fan_out_task_complete',
  'fan_out_complete',
  'fan_out_child_created',
  'fan_out_child_completed',
] as const;
export type FanOutTraceEventType = (typeof FAN_OUT_TRACE_EVENT_TYPES)[number];

export const GUARDRAIL_TRACE_EVENT_TYPES = [
  'guardrail_check',
  'guardrail_violation',
  'guardrail_warning',
  'guardrail_fix',
  'guardrail_reask',
  'guardrail_reask_succeeded',
  'guardrail_reask_exhausted',
  'guardrail_reask_skipped_streaming',
  'guardrail_pipeline_complete',
  'guardrail_cost',
  'guardrail_circuit_breaker',
  'guardrail_cache_hit',
  'guardrail_cache_miss',
  'guardrail_provider_error',
  'guardrail_tool_blocked',
  'guardrail_tool_output_blocked',
  'guardrail_handoff_blocked',
  'guardrail_pipeline_error',
  'guardrail_input_blocked',
  'guardrail_output_blocked',
  'guardrail_activation_blocked',
  'guardrail_auto_deactivation',
] as const;
export type GuardrailTraceEventType = (typeof GUARDRAIL_TRACE_EVENT_TYPES)[number];

export const ATTACHMENT_TRACE_EVENT_TYPES = [
  'attachment_upload',
  'attachment_scan',
  'attachment_process',
  'attachment_index',
  'attachment_delete',
  'attachment_preprocess',
] as const;
export type AttachmentTraceEventType = (typeof ATTACHMENT_TRACE_EVENT_TYPES)[number];

export const SUSPENSION_TRACE_EVENT_TYPES = [
  'execution_suspended',
  'execution_resumed',
  'execution_resume_failed',
  'callback_received',
  'callback_claimed',
  'callback_expired',
  'barrier_branch_completed',
  'barrier_all_complete',
] as const;
export type SuspensionTraceEventType = (typeof SUSPENSION_TRACE_EVENT_TYPES)[number];

export const EXECUTION_TRACE_EVENT_TYPES = [
  'execution.queued',
  'execution.started',
  'execution.completed',
  'execution.failed',
  'execution.cancelled',
  'queue_backpressure',
] as const;
export type ExecutionTraceEventType = (typeof EXECUTION_TRACE_EVENT_TYPES)[number];

export const VOICE_TRACE_EVENT_TYPES = [
  'voice_session_start',
  'voice_session_end',
  'voice_turn',
  'voice_turn_start',
  'voice_turn_end',
  'voice_stt',
  'voice_llm',
  'voice_tts',
  'voice_tts_quality',
  'voice_asr_quality',
  'voice_asr_cascade',
  'voice_external_api',
  'voice_barge_in',
  'voice_silence_detected',
  'voice_realtime_turn_start',
  'voice_realtime_turn_end',
  'voice_realtime_tool_call',
  'voice_realtime_connection',
  'voice_realtime_interruption',
  'voice_config_resolved',
] as const;
export type VoiceTraceEventType = (typeof VOICE_TRACE_EVENT_TYPES)[number];

export const CHANNEL_TRACE_EVENT_TYPES = [
  'channel_message_received',
  'channel_message_sent',
  'channel_response_sent',
  'channel_webhook_delivered',
] as const;
export type ChannelTraceEventType = (typeof CHANNEL_TRACE_EVENT_TYPES)[number];

export const A2A_TRACE_EVENT_TYPES = ['handoff_progress'] as const;
export type A2ATraceEventType = (typeof A2A_TRACE_EVENT_TYPES)[number];

export const STATUS_TRACE_EVENT_TYPES = ['status_update', 'status_clear'] as const;
export type StatusTraceEventType = (typeof STATUS_TRACE_EVENT_TYPES)[number];

export const SPAN_TRACE_EVENT_TYPES = ['span_end'] as const;
export type SpanTraceEventType = (typeof SPAN_TRACE_EVENT_TYPES)[number];

export const MEMORY_TRACE_EVENT_TYPES = [
  'memory_init',
  'memory_remember',
  'memory_recall',
  'memory_error',
  'memory_preferences',
  'memory_dedup_skipped',
  'memory_trigger_evaluated',
  'memory_recall_result',
  'memory_unavailable',
  'preference_detected',
] as const;
export type MemoryTraceEventType = (typeof MEMORY_TRACE_EVENT_TYPES)[number];

export const ERROR_HANDLER_TRACE_EVENT_TYPES = [
  'error_handler_resolved',
  'error_handler_response',
] as const;
export type ErrorHandlerTraceEventType = (typeof ERROR_HANDLER_TRACE_EVENT_TYPES)[number];

export const AGENT_ASSIST_TRACE_EVENT_TYPES = [
  'agent_assist.received',
  'agent_assist.binding_resolved',
  'agent_assist.delegated',
  'agent_assist.translated_response',
  'agent_assist.error',
  'agent_assist.callback_scheduled',
  'agent_assist.callback_delivered',
  'agent_assist.callback_failed',
] as const;
export type AgentAssistTraceEventType = (typeof AGENT_ASSIST_TRACE_EVENT_TYPES)[number];

export const AGENT_TRANSFER_TRACE_EVENT_TYPES = [
  'agent_transfer.transfer_initiated',
  'agent_transfer.agent_connected',
  'agent_transfer.transfer_completed',
  'agent_transfer.transfer_failed',
  'agent_transfer.agent_disconnected',
  'agent_transfer.csat_completed',
  'agent_transfer.acw_completed',
] as const;
export type AgentTransferTraceEventType = (typeof AGENT_TRANSFER_TRACE_EVENT_TYPES)[number];

export const PII_TRACE_EVENT_TYPES = [
  'pii_plaintext_dispensed',
  'pii_audit_missing_tenant',
  'pii_pattern_override_suppressed_original',
  'workflow_unprotected_pii_dispatched',
] as const;
export type PIITraceEventType = (typeof PII_TRACE_EVENT_TYPES)[number];

export const TRACE_EVENT_GROUPS = {
  core: CORE_TRACE_EVENT_TYPES,
  session: SESSION_TRACE_EVENT_TYPES,
  agent: AGENT_TRACE_EVENT_TYPES,
  flow: FLOW_TRACE_EVENT_TYPES,
  delegation: DELEGATION_TRACE_EVENT_TYPES,
  dsl: DSL_TRACE_EVENT_TYPES,
  engine: ENGINE_TRACE_EVENT_TYPES,
  tool: TOOL_TRACE_EVENT_TYPES,
  auth_profile: AUTH_PROFILE_TRACE_EVENT_TYPES,
  extraction: EXTRACTION_TRACE_EVENT_TYPES,
  fan_out: FAN_OUT_TRACE_EVENT_TYPES,
  guardrail: GUARDRAIL_TRACE_EVENT_TYPES,
  attachment: ATTACHMENT_TRACE_EVENT_TYPES,
  suspension: SUSPENSION_TRACE_EVENT_TYPES,
  execution: EXECUTION_TRACE_EVENT_TYPES,
  voice: VOICE_TRACE_EVENT_TYPES,
  channel: CHANNEL_TRACE_EVENT_TYPES,
  a2a: A2A_TRACE_EVENT_TYPES,
  status: STATUS_TRACE_EVENT_TYPES,
  span: SPAN_TRACE_EVENT_TYPES,
  memory: MEMORY_TRACE_EVENT_TYPES,
  error_handler: ERROR_HANDLER_TRACE_EVENT_TYPES,
  agent_assist: AGENT_ASSIST_TRACE_EVENT_TYPES,
  agent_transfer: AGENT_TRANSFER_TRACE_EVENT_TYPES,
  pii: PII_TRACE_EVENT_TYPES,
} as const;

export type TraceEventDomain = keyof typeof TRACE_EVENT_GROUPS;

export const ALL_TRACE_EVENT_TYPES = [
  ...CORE_TRACE_EVENT_TYPES,
  ...SESSION_TRACE_EVENT_TYPES,
  ...AGENT_TRACE_EVENT_TYPES,
  ...FLOW_TRACE_EVENT_TYPES,
  ...DELEGATION_TRACE_EVENT_TYPES,
  ...DSL_TRACE_EVENT_TYPES,
  ...ENGINE_TRACE_EVENT_TYPES,
  ...TOOL_TRACE_EVENT_TYPES,
  ...AUTH_PROFILE_TRACE_EVENT_TYPES,
  ...EXTRACTION_TRACE_EVENT_TYPES,
  ...FAN_OUT_TRACE_EVENT_TYPES,
  ...GUARDRAIL_TRACE_EVENT_TYPES,
  ...ATTACHMENT_TRACE_EVENT_TYPES,
  ...SUSPENSION_TRACE_EVENT_TYPES,
  ...EXECUTION_TRACE_EVENT_TYPES,
  ...VOICE_TRACE_EVENT_TYPES,
  ...CHANNEL_TRACE_EVENT_TYPES,
  ...A2A_TRACE_EVENT_TYPES,
  ...STATUS_TRACE_EVENT_TYPES,
  ...SPAN_TRACE_EVENT_TYPES,
  ...MEMORY_TRACE_EVENT_TYPES,
  ...ERROR_HANDLER_TRACE_EVENT_TYPES,
  ...AGENT_ASSIST_TRACE_EVENT_TYPES,
  ...AGENT_TRANSFER_TRACE_EVENT_TYPES,
  ...PII_TRACE_EVENT_TYPES,
] as const;

export type TraceEventType = (typeof ALL_TRACE_EVENT_TYPES)[number];
export type ExtendedTraceEventType = TraceEventType;

/**
 * Every event type the runtime can emit directly today.
 *
 * This is a stable subset of the broader canonical trace contract. Observatory
 * and Studio may still understand additional synthetic, persisted, or
 * compatibility events that are not produced by the current runtime emitters.
 */
export const RUNTIME_EVENT_TYPES = [
  'error',
  'escalation',
  'completion_check',
  'warning',
  'decision',
  'flow_step_enter',
  'flow_step_exit',
  'flow_transition',
  'step_thought',
  'tool_call',
  'tool_thought',
  'constraint_check',
  'constraint_violation',
  'handoff',
  'dsl_collect',
  'dsl_prompt',
  'dsl_respond',
  'dsl_set',
  'dsl_on_input',
  'dsl_call',
  'dsl_await_attachment',
  'correction',
  'user_message',
  'turn_start',
  'turn_end',
  'session_resolution',
  'status_update',
  'status_clear',
  'memory_init',
  'memory_remember',
  'memory_recall',
  'memory_error',
  'memory_preferences',
  'memory_dedup_skipped',
  'agent_enter',
  'agent_exit',
  'delegate_start',
  'delegate_complete',
  'routing_capabilities_resolved',
  'handoff_condition_check',
  'handoff_return_handler',
  'resume_intent',
  'thread_resume',
  'deterministic_routing',
  'deterministic_handoff',
  'thread_return',
  'return_to_parent',
  'data_stored',
  'digression',
  'sub_intent',
  'pipeline_intent_bridge',
  'pipeline_tiered_action',
  'pipeline_out_of_scope_decline',
  'extraction_strategy_resolved',
  'extraction_attempt',
  'extraction_parse_fallback',
  'extraction_fallback',
  'memory_trigger_evaluated',
  'memory_recall_result',
  'memory_unavailable',
  'preference_detected',
  'constraint_backtrack',
  'constraint_backtrack_limit',
  'constraint_directive',
  'constraint_mini_collect',
  'gather_field_activation',
  'gather_complete_reason',
  'correction_invalidation',
  'validation_fail_open',
  'llm_call',
  'engine_decision',
  'agent_response',
  'entity_extraction',
  'extraction_tier_selected',
  'agent_error_handled',
  'tool_call_start',
  'tool_call_error',
  'hook_executed',
  'action_handler_executed',
  'behavior_profile_applied',
  'fan_out_start',
  'fan_out_task_start',
  'fan_out_task_complete',
  'fan_out_complete',
  'fan_out_child_created',
  'fan_out_child_completed',
  'guardrail_check',
  'guardrail_violation',
  'guardrail_warning',
  'guardrail_fix',
  'guardrail_reask',
  'guardrail_pipeline_complete',
  'guardrail_pipeline_error',
  'guardrail_input_blocked',
  'guardrail_output_blocked',
  'guardrail_tool_blocked',
  'guardrail_tool_output_blocked',
  'guardrail_handoff_blocked',
  'guardrail_cost',
  'guardrail_circuit_breaker',
  'guardrail_cache_hit',
  'guardrail_cache_miss',
  'guardrail_provider_error',
  'escalation_triggered',
  'escalation_resolved',
  'itsm_ticket_created',
  'session_created',
  'session_ended',
  'session_updated',
  'execution.queued',
  'execution.started',
  'execution.completed',
  'execution.failed',
  'execution.cancelled',
  'queue_backpressure',
  'voice_session_start',
  'voice_session_end',
  'voice_turn',
  'voice_stt',
  'voice_tts',
  'voice_barge_in',
  'voice_asr_quality',
  'voice_tts_quality',
  'voice_asr_cascade',
  'voice_config_resolved',
  'agent_assist.received',
  'agent_assist.binding_resolved',
  'agent_assist.delegated',
  'agent_assist.translated_response',
  'agent_assist.error',
  'agent_assist.callback_scheduled',
  'agent_assist.callback_delivered',
  'agent_assist.callback_failed',
  'pii_plaintext_dispensed',
  'pii_audit_missing_tenant',
  'pii_pattern_override_suppressed_original',
] as const satisfies readonly TraceEventType[];

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

export interface TraceEventRegistryEntry {
  domain: TraceEventDomain;
  emittedByRuntime: boolean;
}

const RUNTIME_EVENT_TYPE_SET = new Set<string>(RUNTIME_EVENT_TYPES);

function registryEntriesForDomain<T extends readonly string[]>(
  domain: TraceEventDomain,
  types: T,
): Array<readonly [T[number], TraceEventRegistryEntry]> {
  return types.map((type) => [
    type,
    {
      domain,
      emittedByRuntime: RUNTIME_EVENT_TYPE_SET.has(type),
    },
  ]);
}

export const TRACE_EVENT_REGISTRY = Object.freeze(
  Object.fromEntries([
    ...registryEntriesForDomain('core', CORE_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('session', SESSION_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('agent', AGENT_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('flow', FLOW_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('delegation', DELEGATION_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('dsl', DSL_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('engine', ENGINE_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('tool', TOOL_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('auth_profile', AUTH_PROFILE_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('extraction', EXTRACTION_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('fan_out', FAN_OUT_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('guardrail', GUARDRAIL_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('attachment', ATTACHMENT_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('suspension', SUSPENSION_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('execution', EXECUTION_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('voice', VOICE_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('channel', CHANNEL_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('a2a', A2A_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('status', STATUS_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('span', SPAN_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('memory', MEMORY_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('error_handler', ERROR_HANDLER_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('agent_assist', AGENT_ASSIST_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('agent_transfer', AGENT_TRANSFER_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('pii', PII_TRACE_EVENT_TYPES),
  ]) as Record<TraceEventType, TraceEventRegistryEntry>,
);
