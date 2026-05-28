/**
 * Interactions Tab — Constants
 *
 * Step type configuration, semantic intent mappings, event labels,
 * and display thresholds.
 */

import type { SemanticIntent } from '@agent-platform/design-tokens';
import type { InteractionStepType } from './types';

export interface StepConfig {
  intent: SemanticIntent;
  label: string;
}

export const STEP_CONFIG: Record<InteractionStepType, StepConfig> = {
  user_input: { intent: 'info', label: 'USER INPUT' },
  input_guard: { intent: 'success', label: 'INPUT GUARD' },
  llm_call: { intent: 'purple', label: 'LLM CALL' },
  gather: { intent: 'info', label: 'GATHER' },
  flow_transition: { intent: 'warning', label: 'TRANSITION' },
  flow_graph: { intent: 'warning', label: 'FLOW' },
  tool_call: { intent: 'success', label: 'TOOL CALL' },
  parallel_tools: { intent: 'info', label: 'PARALLEL' },
  retry: { intent: 'warning', label: 'RETRY' },
  output_guard: { intent: 'success', label: 'OUTPUT GUARD' },
  agent_response: { intent: 'purple', label: 'RESPONSE' },
  memory_diff: { intent: 'info', label: 'MEMORY' },
  decision: { intent: 'warning', label: 'DECISION' },
  error: { intent: 'error', label: 'ERROR' },
};

// =============================================================================
// EVENT → STEP MAPPING
// =============================================================================

export const EVENT_TO_STEP: Record<string, InteractionStepType> = {
  // ── User Input ──
  user_message: 'user_input',
  delegated_message: 'user_input',
  fan_out_message: 'user_input',
  'message.user.received': 'user_input',

  // ── LLM ──
  llm_call: 'llm_call',
  'llm.call.completed': 'llm_call',
  'llm.call.failed': 'llm_call',
  inference_start: 'llm_call',
  inference_complete: 'llm_call',
  inference_error: 'llm_call',
  inference_stream_start: 'llm_call',
  inference_stream_end: 'llm_call',

  // ── Tool Calls ──
  tool_call_start: 'tool_call',
  tool_call: 'tool_call',
  tool_result: 'tool_call',
  tool_thought: 'decision',
  'tool.call.completed': 'tool_call',
  'tool.call.failed': 'tool_call',
  dsl_call: 'tool_call',

  // ── Guardrails ──
  guardrail_check: 'input_guard',
  guardrail_violation: 'input_guard',
  guardrail_warning: 'input_guard',
  guardrail_fix: 'input_guard',
  guardrail_reask: 'input_guard',
  guardrail_pipeline_complete: 'input_guard',
  guardrail_pipeline_error: 'input_guard',
  guardrail_input_blocked: 'input_guard',
  guardrail_output_blocked: 'output_guard',
  guardrail_tool_blocked: 'input_guard',
  guardrail_tool_output_blocked: 'output_guard',
  guardrail_handoff_blocked: 'input_guard',
  guardrail_cost: 'input_guard',
  guardrail_circuit_breaker: 'input_guard',
  guardrail_cache_hit: 'input_guard',
  guardrail_cache_miss: 'input_guard',
  guardrail_provider_error: 'input_guard',
  // PII
  pii_plaintext_dispensed: 'input_guard',
  pii_audit_missing_tenant: 'input_guard',
  pii_pattern_override_suppressed_original: 'input_guard',

  // ── Flow / Transitions ──
  flow_step_enter: 'flow_transition',
  flow_step_exit: 'flow_transition',
  flow_transition: 'flow_transition',
  step_thought: 'decision',
  'flow.step.entered': 'flow_transition',
  'flow.step.exited': 'flow_transition',
  'flow.transition': 'flow_transition',

  // ── Gather / Extraction ──
  dsl_collect: 'gather',
  entity_extraction: 'gather',
  extraction_tier_selected: 'gather',
  extraction_attempt: 'gather',
  extraction_fallback: 'gather',
  extraction_parse_fallback: 'gather',
  extraction_strategy_resolved: 'gather',
  gather_field_activation: 'gather',
  gather_complete_reason: 'gather',
  dsl_on_input: 'gather',
  dsl_await_attachment: 'gather',
  constraint_backtrack: 'gather',
  constraint_backtrack_limit: 'gather',
  constraint_directive: 'gather',
  constraint_mini_collect: 'gather',

  // ── Decisions ──
  decision: 'decision',
  handoff: 'decision',
  'agent.decision': 'decision',
  'agent.handoff': 'decision',
  routing_capabilities_resolved: 'decision',
  handoff_condition_check: 'decision',
  handoff_return_handler: 'decision',
  resume_intent: 'decision',
  thread_resume: 'decision',
  deterministic_routing: 'decision',
  deterministic_handoff: 'decision',
  return_to_parent: 'decision',
  engine_decision: 'decision',
  completion_check: 'decision',
  correction: 'decision',
  correction_invalidation: 'decision',
  digression: 'decision',
  sub_intent: 'decision',
  pipeline_intent_bridge: 'decision',
  pipeline_tiered_action: 'decision',
  pipeline_out_of_scope_decline: 'decision',
  escalation: 'decision',
  constraint_check: 'decision',
  validation_fail_open: 'decision',
  status_update: 'decision',
  status_clear: 'decision',
  'execution.queued': 'decision',
  'execution.started': 'decision',
  'execution.completed': 'decision',
  'execution.cancelled': 'decision',
  queue_backpressure: 'error',

  // ── Agent Response ──
  agent_response: 'agent_response',
  dsl_respond: 'agent_response',
  dsl_prompt: 'agent_response',

  // ── Errors / Warnings ──
  error: 'error',
  'system.error': 'error',
  constraint_violation: 'error',
  warning: 'error',
  agent_error_handled: 'error',
  tool_call_error: 'tool_call',
  'execution.failed': 'error',

  // ── Hooks / Actions ──
  hook_executed: 'tool_call',
  action_handler_executed: 'tool_call',

  // ── Escalation Lifecycle ──
  escalation_triggered: 'decision',
  escalation_resolved: 'decision',
  itsm_ticket_created: 'decision',

  // ── Voice ──
  voice_session_start: 'decision',
  voice_session_end: 'decision',
  voice_turn: 'decision',
  voice_stt: 'decision',
  voice_tts: 'decision',
  voice_realtime_tool_call: 'tool_call',
  voice_barge_in: 'decision',
  voice_asr_quality: 'decision',
  voice_tts_quality: 'decision',
  voice_asr_cascade: 'decision',
  voice_config_resolved: 'decision',
  behavior_profile_applied: 'decision',

  // ── Parallel Execution ──
  fan_out_start: 'parallel_tools',
  fan_out_task_start: 'parallel_tools',
  fan_out_task_complete: 'parallel_tools',
  fan_out_complete: 'parallel_tools',
  fan_out_child_created: 'parallel_tools',
  fan_out_child_completed: 'parallel_tools',

  // ── Memory ──
  data_stored: 'memory_diff',
  dsl_set: 'memory_diff',
  memory_init: 'memory_diff',
  memory_remember: 'memory_diff',
  memory_dedup_skipped: 'memory_diff',
  memory_recall: 'memory_diff',
  memory_error: 'memory_diff',
  memory_preferences: 'memory_diff',
  memory_trigger_evaluated: 'memory_diff',
  memory_recall_result: 'memory_diff',
  memory_unavailable: 'memory_diff',
  preference_detected: 'memory_diff',

  // ── Agent Assist ──
  'agent_assist.received': 'decision',
  'agent_assist.binding_resolved': 'decision',
  'agent_assist.delegated': 'decision',
  'agent_assist.translated_response': 'decision',
  'agent_assist.error': 'decision',
  'agent_assist.callback_scheduled': 'decision',
  'agent_assist.callback_delivered': 'decision',
  'agent_assist.callback_failed': 'decision',
};

// =============================================================================
// HUMAN-READABLE EVENT LABELS
// =============================================================================

export const EVENT_LABELS: Record<string, string> = {
  // ── User Input ──
  user_message: 'User Message',
  delegated_message: 'Delegated Input',
  fan_out_message: 'Fan-Out Input',
  'message.user.received': 'User Message Received',

  // ── LLM ──
  llm_call: 'LLM Call',
  'llm.call.completed': 'LLM Call Completed',
  'llm.call.failed': 'LLM Call Failed',
  inference_start: 'Inference Started',
  inference_complete: 'Inference Complete',
  inference_error: 'Inference Error',
  inference_stream_start: 'Stream Started',
  inference_stream_end: 'Stream Ended',
  engine_decision: 'Engine Decision',

  // ── Tool Calls ──
  tool_call_start: 'Tool Call Started',
  tool_call: 'Tool Call',
  tool_result: 'Tool Result',
  tool_thought: 'Tool Thought',
  'tool.call.completed': 'Tool Call Completed',
  'tool.call.failed': 'Tool Call Failed',
  dsl_call: 'DSL Action Call',

  // ── Guardrails ──
  guardrail_check: 'Guardrail Check',
  guardrail_violation: 'Guardrail Violation',
  guardrail_warning: 'Guardrail Warning',
  guardrail_fix: 'Guardrail Auto-Fix',
  guardrail_reask: 'Guardrail Re-Ask',
  guardrail_pipeline_complete: 'Guardrail Pipeline Complete',
  guardrail_pipeline_error: 'Guardrail Pipeline Error',
  guardrail_input_blocked: 'Input Blocked',
  guardrail_output_blocked: 'Output Blocked',
  guardrail_tool_blocked: 'Tool Blocked',
  guardrail_tool_output_blocked: 'Tool Output Blocked',
  guardrail_handoff_blocked: 'Handoff Blocked',
  guardrail_cost: 'Guardrail Cost Check',
  guardrail_circuit_breaker: 'Circuit Breaker Tripped',
  guardrail_cache_hit: 'Guardrail Cache Hit',
  guardrail_cache_miss: 'Guardrail Cache Miss',
  guardrail_provider_error: 'Guardrail Provider Error',
  // PII
  pii_plaintext_dispensed: 'PII Token Dispensed',
  pii_audit_missing_tenant: 'PII Audit: Missing Tenant',
  pii_pattern_override_suppressed_original: 'PII Pattern Override',

  // ── Flow / Transitions ──
  flow_step_enter: 'Flow Step Entered',
  flow_step_exit: 'Flow Step Exited',
  flow_transition: 'Flow Transition',
  step_thought: 'Step Thought',
  'flow.step.entered': 'Flow Step Entered',
  'flow.step.exited': 'Flow Step Exited',
  'flow.transition': 'Flow Transition',

  // ── Gather / Extraction ──
  dsl_collect: 'Field Collection',
  entity_extraction: 'Entity Extraction',
  extraction_tier_selected: 'Extraction Tier Selected',
  extraction_attempt: 'Extraction Attempt',
  extraction_fallback: 'Extraction Fallback',
  extraction_parse_fallback: 'Parse Fallback',
  extraction_strategy_resolved: 'Extraction Strategy Resolved',
  gather_field_activation: 'Field Activated',
  gather_complete_reason: 'Gather Complete',
  dsl_on_input: 'Input Received',
  dsl_await_attachment: 'Awaiting Attachment',
  constraint_backtrack: 'Field Backtrack',
  constraint_backtrack_limit: 'Backtrack Limit Reached',
  constraint_directive: 'Constraint Directive',
  constraint_mini_collect: 'Mini-Collect',

  // ── Decisions ──
  decision: 'Decision',
  handoff: 'Handoff',
  'agent.decision': 'Agent Decision',
  'agent.handoff': 'Agent Handoff',
  routing_capabilities_resolved: 'Routing Capabilities',
  handoff_condition_check: 'Handoff Condition Check',
  deterministic_routing: 'Deterministic Routing',
  deterministic_handoff: 'Deterministic Handoff',
  completion_check: 'Completion Check',
  correction: 'Self-Correction',
  correction_invalidation: 'Correction Invalidated',
  digression: 'Digression Detected',
  sub_intent: 'Sub-Intent Recognized',
  pipeline_intent_bridge: 'Intent Bridged',
  pipeline_tiered_action: 'Tiered Action',
  pipeline_out_of_scope_decline: 'Out of Scope Declined',
  escalation: 'Escalated',
  constraint_check: 'Constraint Check',
  validation_fail_open: 'Validation Fail-Open',
  status_update: 'Status Update',
  status_clear: 'Status Clear',
  'execution.queued': 'Execution Queued',
  'execution.started': 'Execution Started',
  'execution.completed': 'Execution Completed',
  'execution.failed': 'Execution Failed',
  'execution.cancelled': 'Execution Cancelled',
  queue_backpressure: 'Queue Backpressure',

  // ── Agent Response ──
  agent_response: 'Agent Response',
  dsl_respond: 'DSL Response',
  dsl_prompt: 'DSL Prompt',

  // ── Memory ──
  data_stored: 'Data Stored',
  dsl_set: 'Variable Set',
  memory_init: 'Memory Initialized',
  memory_remember: 'Memory Stored',
  memory_dedup_skipped: 'Memory Write Deduplicated',
  memory_recall: 'Memory Recalled',
  memory_error: 'Memory Error',
  memory_preferences: 'Preferences Stored',
  memory_trigger_evaluated: 'Memory Trigger Evaluated',
  memory_recall_result: 'Memory Recall Result',
  memory_unavailable: 'Memory Unavailable',
  preference_detected: 'Preference Detected',

  // ── Agent Assist ──
  'agent_assist.received': 'Agent Assist Received',
  'agent_assist.binding_resolved': 'Agent Assist Binding Resolved',
  'agent_assist.delegated': 'Agent Assist Delegated',
  'agent_assist.translated_response': 'Agent Assist Translated Response',
  'agent_assist.error': 'Agent Assist Error',
  'agent_assist.callback_scheduled': 'Agent Assist Callback Scheduled',
  'agent_assist.callback_delivered': 'Agent Assist Callback Delivered',
  'agent_assist.callback_failed': 'Agent Assist Callback Failed',

  // ── Errors / Warnings ──
  error: 'Error',
  'system.error': 'System Error',
  constraint_violation: 'Constraint Violation',
  warning: 'Warning',
  agent_error_handled: 'Handled Error',
  tool_call_error: 'Tool Error',

  // ── Hooks / Actions ──
  hook_executed: 'Hook Executed',
  action_handler_executed: 'Action Handler Executed',

  // ── Escalation Lifecycle ──
  escalation_triggered: 'Escalation Triggered',
  escalation_resolved: 'Escalation Resolved',
  itsm_ticket_created: 'ITSM Ticket Created',

  // ── Voice ──
  voice_session_start: 'Voice Session Started',
  voice_session_end: 'Voice Session Ended',
  voice_turn: 'Voice Turn',
  voice_stt: 'Speech-to-Text',
  voice_tts: 'Text-to-Speech',
  voice_realtime_tool_call: 'Realtime Tool Call',
  voice_barge_in: 'Barge-In Detected',
  voice_asr_quality: 'ASR Quality',
  voice_tts_quality: 'TTS Quality',
  voice_asr_cascade: 'ASR Cascade',
  voice_config_resolved: 'Voice Config Resolved',
  behavior_profile_applied: 'Behavior Profile Applied',

  // ── Parallel Execution ──
  fan_out_start: 'Parallel Start',
  fan_out_task_start: 'Parallel Task Started',
  fan_out_task_complete: 'Parallel Task Complete',
  fan_out_complete: 'Parallel Complete',
  fan_out_child_created: 'Child Task Created',
  fan_out_child_completed: 'Child Task Completed',

  // ── Lifecycle (banners) ──
  agent_enter: 'Agent Entered',
  agent_exit: 'Agent Exited',
  delegate_start: 'Delegation Started',
  delegate_complete: 'Delegation Complete',
  handoff_return_handler: 'Handoff Return Handler',
  resume_intent: 'Resume Intent',
  thread_resume: 'Thread Resumed',
  thread_return: 'Thread Returned',
  return_to_parent: 'Return to Parent',

  // ── Session ──
  session_resolution: 'Session Resolved',
  session_created: 'Session Created',
  session_ended: 'Session Ended',
  session_updated: 'Session Updated',
  turn_start: 'Turn Started',
  turn_end: 'Turn Ended',
};

// =============================================================================
// LIFECYCLE & SESSION EVENT SETS
// =============================================================================

/** Events rendered as thin inline banners between steps — NOT step cards */
export const LIFECYCLE_EVENTS = new Set([
  'agent_enter',
  'agent_exit',
  'delegate_start',
  'delegate_complete',
  'handoff_return_handler',
  'resume_intent',
  'thread_resume',
  'thread_return',
  'return_to_parent',
]);

/** Events rendered as a session footer — NOT step cards */
export const SESSION_EVENTS = new Set([
  'session_resolution',
  'session_created',
  'session_ended',
  'session_updated',
  'turn_start',
  'turn_end',
]);

// =============================================================================
// STATUS / MODE SETS
// =============================================================================

export const ERROR_EVENT_TYPES = new Set([
  'error',
  'system.error',
  'constraint_violation',
  'guardrail_violation',
  'guardrail_input_blocked',
  'guardrail_output_blocked',
  'guardrail_pipeline_error',
  'tool.call.failed',
  'tool_call_error',
  'execution.failed',
]);

export const WARNING_EVENT_TYPES = new Set([
  'warning',
  'execution.cancelled',
  'queue_backpressure',
  'guardrail_warning',
  'guardrail_cost',
  'extraction_fallback',
  'extraction_parse_fallback',
]);

export const COMPLETED_TOOL_CALL_EVENT_TYPES = new Set([
  'tool_call',
  'tool_call_error',
  'hook_executed',
  'action_handler_executed',
  'voice_realtime_tool_call',
]);

export const SCRIPTED_MODE_EVENTS = new Set([
  'flow_step_enter',
  'flow_step_exit',
  'flow_transition',
  'dsl_collect',
  'dsl_prompt',
  'dsl_respond',
  'dsl_set',
  'dsl_on_input',
  'dsl_call',
  'flow.step.entered',
  'flow.step.exited',
  'flow.transition',
]);
