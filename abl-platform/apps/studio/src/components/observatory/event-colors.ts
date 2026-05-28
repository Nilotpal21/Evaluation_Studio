/**
 * Centralized event color constants for debug panel components.
 * Used by SpanTree and WaterfallPanel to prevent duplication.
 * All colors use semantic design tokens that work in both light and dark themes.
 */

/** Color config for timeline dot indicators (small colored dots) */
export const EVENT_DOT_COLORS: Record<string, string> = {
  llm_call: 'bg-accent',
  tool_call: 'bg-orange',
  tool_call_start: 'bg-orange',
  tool_result: 'bg-orange',
  tool_thought: 'bg-purple',
  attachment_process: 'bg-info',
  attachment_upload: 'bg-success',
  attachment_preprocess: 'bg-accent',
  decision: 'bg-purple',
  handoff: 'bg-info',
  escalation: 'bg-error',
  error: 'bg-error',
  agent_enter: 'bg-success',
  agent_exit: 'bg-success',
  flow_step_enter: 'bg-accent',
  flow_step_exit: 'bg-accent',
  flow_transition: 'bg-accent',
  step_thought: 'bg-purple',
  span_end: 'bg-success-muted',
  // Constraint
  constraint_check: 'bg-warning',
  // Guardrail events
  guardrail_check: 'bg-error',
  guardrail_violation: 'bg-error',
  guardrail_warning: 'bg-warning',
  guardrail_fix: 'bg-warning',
  guardrail_reask: 'bg-warning',
  guardrail_pipeline_complete: 'bg-success',
  guardrail_cost: 'bg-warning',
  guardrail_circuit_breaker: 'bg-error',
  guardrail_cache_hit: 'bg-success',
  guardrail_cache_miss: 'bg-warning',
  guardrail_provider_error: 'bg-error',
  guardrail_tool_blocked: 'bg-error',
  guardrail_tool_output_blocked: 'bg-error',
  guardrail_handoff_blocked: 'bg-error',
  guardrail_pipeline_error: 'bg-error',
  guardrail_input_blocked: 'bg-error',
  guardrail_output_blocked: 'bg-error',
  // Voice events
  voice_turn_start: 'bg-purple',
  voice_turn_end: 'bg-purple',
  voice_stt: 'bg-purple',
  voice_llm: 'bg-purple',
  voice_tts: 'bg-purple',
  voice_tts_quality: 'bg-purple',
  voice_asr_quality: 'bg-purple',
  voice_asr_cascade: 'bg-purple',
  voice_external_api: 'bg-purple',
  voice_barge_in: 'bg-purple',
  voice_silence_detected: 'bg-purple',
  voice_realtime_turn_start: 'bg-purple',
  voice_realtime_turn_end: 'bg-purple',
  voice_realtime_tool_call: 'bg-purple',
  voice_realtime_connection: 'bg-purple',
  voice_realtime_interruption: 'bg-purple',
  // Fan-out events
  fan_out_start: 'bg-info',
  fan_out_task_start: 'bg-info',
  fan_out_task_complete: 'bg-info',
  fan_out_complete: 'bg-info',
  fan_out_child_created: 'bg-info',
  fan_out_child_completed: 'bg-info',
  // Extraction events
  entity_extraction: 'bg-success',
  extraction_tier_selected: 'bg-success',
  extraction_attempt: 'bg-success',
  extraction_fallback: 'bg-warning',
  extraction_parse_fallback: 'bg-warning',
  // Delegate events
  delegate_start: 'bg-purple',
  delegate_complete: 'bg-purple',
  // ABL Construct events
  dsl_collect: 'bg-success',
  dsl_prompt: 'bg-info',
  dsl_respond: 'bg-info',
  dsl_set: 'bg-purple',
  dsl_on_input: 'bg-error',
  dsl_call: 'bg-orange',
  // Engine decision & runtime events
  completion_check: 'bg-warning',
  engine_decision: 'bg-background-muted',
  handoff_condition_check: 'bg-warning',
  status_update: 'bg-info',
  status_clear: 'bg-info',
  thread_return: 'bg-purple',
  constraint_violation: 'bg-error',
  user_message: 'bg-accent',
  warning: 'bg-warning',
  digression: 'bg-error',
  sub_intent: 'bg-error',
  correction: 'bg-info',
  data_stored: 'bg-success',
  // Inference events (accent/blue)
  inference_start: 'bg-accent',
  inference_complete: 'bg-accent',
  inference_error: 'bg-accent',
  inference_stream_start: 'bg-accent',
  inference_stream_chunk: 'bg-accent',
  inference_stream_end: 'bg-accent',
  // Lookup events (info/teal)
  lookup_start: 'bg-info',
  lookup_complete: 'bg-info',
  lookup_error: 'bg-info',
  lookup_cache_hit: 'bg-info',
  // Multi-intent events (purple)
  multi_intent_detected: 'bg-purple',
  multi_intent_resolved: 'bg-purple',
  multi_intent_switch: 'bg-purple',
  // Agent lifecycle events
  agent_response: 'bg-success',
  agent_switch: 'bg-info',
  handoff_progress: 'bg-info',
  // Session events (muted/gray — typically filtered)
  session_start: 'bg-background-muted',
  session_end: 'bg-background-muted',
  session_ended: 'bg-background-muted',
  session_resolution: 'bg-background-muted',
  session_created: 'bg-background-muted',
  session_updated: 'bg-background-muted',
};

/** Full event config for EventTimeline cards */
export interface EventColorConfig {
  bgColor: string;
  iconColor: string;
  textColor: string;
}

export const EVENT_CARD_COLORS: Record<string, EventColorConfig> = {
  llm_call: {
    bgColor: 'bg-accent-subtle',
    iconColor: 'text-accent',
    textColor: 'text-accent',
  },
  tool_call: {
    bgColor: 'bg-orange-subtle',
    iconColor: 'text-orange',
    textColor: 'text-orange',
  },
  tool_call_start: {
    bgColor: 'bg-orange-subtle',
    iconColor: 'text-orange',
    textColor: 'text-orange',
  },
  attachment_process: {
    bgColor: 'bg-info-subtle',
    iconColor: 'text-info',
    textColor: 'text-info',
  },
  attachment_upload: {
    bgColor: 'bg-success-subtle',
    iconColor: 'text-success',
    textColor: 'text-success',
  },
  attachment_preprocess: {
    bgColor: 'bg-accent-subtle',
    iconColor: 'text-accent',
    textColor: 'text-accent',
  },
  tool_result: {
    bgColor: 'bg-orange-subtle',
    iconColor: 'text-orange',
    textColor: 'text-orange',
  },
  tool_thought: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  decision: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  handoff: {
    bgColor: 'bg-info-subtle',
    iconColor: 'text-info',
    textColor: 'text-info',
  },
  escalation: {
    bgColor: 'bg-warning-subtle',
    iconColor: 'text-warning',
    textColor: 'text-warning',
  },
  error: {
    bgColor: 'bg-error-subtle',
    iconColor: 'text-error',
    textColor: 'text-error',
  },
  agent_enter: {
    bgColor: 'bg-success-subtle',
    iconColor: 'text-success',
    textColor: 'text-success',
  },
  agent_exit: {
    bgColor: 'bg-success-subtle',
    iconColor: 'text-success',
    textColor: 'text-success',
  },
  flow_step_enter: {
    bgColor: 'bg-accent-subtle',
    iconColor: 'text-accent',
    textColor: 'text-accent',
  },
  flow_step_exit: {
    bgColor: 'bg-accent-subtle',
    iconColor: 'text-accent',
    textColor: 'text-accent',
  },
  flow_transition: {
    bgColor: 'bg-accent-subtle',
    iconColor: 'text-accent',
    textColor: 'text-accent',
  },
  step_thought: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  delegate_start: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  delegate_complete: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  // ABL Construct Events
  dsl_collect: {
    bgColor: 'bg-success-subtle',
    iconColor: 'text-success',
    textColor: 'text-success',
  },
  dsl_prompt: {
    bgColor: 'bg-info-subtle',
    iconColor: 'text-info',
    textColor: 'text-info',
  },
  dsl_respond: {
    bgColor: 'bg-info-subtle',
    iconColor: 'text-info',
    textColor: 'text-info',
  },
  dsl_set: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  dsl_on_input: {
    bgColor: 'bg-error-subtle',
    iconColor: 'text-error',
    textColor: 'text-error',
  },
  dsl_call: {
    bgColor: 'bg-orange-subtle',
    iconColor: 'text-orange',
    textColor: 'text-orange',
  },
  // Engine decision & runtime events
  completion_check: {
    bgColor: 'bg-warning-subtle',
    iconColor: 'text-warning',
    textColor: 'text-warning',
  },
  engine_decision: {
    bgColor: 'bg-background-subtle',
    iconColor: 'text-muted',
    textColor: 'text-muted',
  },
  handoff_condition_check: {
    bgColor: 'bg-warning-subtle',
    iconColor: 'text-warning',
    textColor: 'text-warning',
  },
  status_update: {
    bgColor: 'bg-info-subtle',
    iconColor: 'text-info',
    textColor: 'text-info',
  },
  status_clear: {
    bgColor: 'bg-info-subtle',
    iconColor: 'text-info',
    textColor: 'text-info',
  },
  thread_return: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  constraint_violation: {
    bgColor: 'bg-error-subtle',
    iconColor: 'text-error',
    textColor: 'text-error',
  },
  user_message: {
    bgColor: 'bg-accent-subtle',
    iconColor: 'text-accent',
    textColor: 'text-accent',
  },
  warning: {
    bgColor: 'bg-warning-subtle',
    iconColor: 'text-warning',
    textColor: 'text-warning',
  },
  digression: {
    bgColor: 'bg-error-subtle',
    iconColor: 'text-error',
    textColor: 'text-error',
  },
  sub_intent: {
    bgColor: 'bg-error-subtle',
    iconColor: 'text-error',
    textColor: 'text-error',
  },
  correction: {
    bgColor: 'bg-info-subtle',
    iconColor: 'text-info',
    textColor: 'text-info',
  },
  data_stored: {
    bgColor: 'bg-success-subtle',
    iconColor: 'text-success',
    textColor: 'text-success',
  },
  // Constraint check
  constraint_check: {
    bgColor: 'bg-warning-subtle',
    iconColor: 'text-warning',
    textColor: 'text-warning',
  },
  // Guardrail events
  guardrail_check: {
    bgColor: 'bg-error-subtle',
    iconColor: 'text-error',
    textColor: 'text-error',
  },
  guardrail_violation: {
    bgColor: 'bg-error-subtle',
    iconColor: 'text-error',
    textColor: 'text-error',
  },
  guardrail_warning: {
    bgColor: 'bg-warning-subtle',
    iconColor: 'text-warning',
    textColor: 'text-warning',
  },
  guardrail_fix: {
    bgColor: 'bg-warning-subtle',
    iconColor: 'text-warning',
    textColor: 'text-warning',
  },
  guardrail_reask: {
    bgColor: 'bg-warning-subtle',
    iconColor: 'text-warning',
    textColor: 'text-warning',
  },
  guardrail_pipeline_complete: {
    bgColor: 'bg-success-subtle',
    iconColor: 'text-success',
    textColor: 'text-success',
  },
  guardrail_cost: {
    bgColor: 'bg-warning-subtle',
    iconColor: 'text-warning',
    textColor: 'text-warning',
  },
  guardrail_circuit_breaker: {
    bgColor: 'bg-error-subtle',
    iconColor: 'text-error',
    textColor: 'text-error',
  },
  guardrail_cache_hit: {
    bgColor: 'bg-success-subtle',
    iconColor: 'text-success',
    textColor: 'text-success',
  },
  guardrail_cache_miss: {
    bgColor: 'bg-warning-subtle',
    iconColor: 'text-warning',
    textColor: 'text-warning',
  },
  guardrail_provider_error: {
    bgColor: 'bg-error-subtle',
    iconColor: 'text-error',
    textColor: 'text-error',
  },
  guardrail_tool_blocked: {
    bgColor: 'bg-error-subtle',
    iconColor: 'text-error',
    textColor: 'text-error',
  },
  guardrail_tool_output_blocked: {
    bgColor: 'bg-error-subtle',
    iconColor: 'text-error',
    textColor: 'text-error',
  },
  guardrail_handoff_blocked: {
    bgColor: 'bg-error-subtle',
    iconColor: 'text-error',
    textColor: 'text-error',
  },
  guardrail_pipeline_error: {
    bgColor: 'bg-error-subtle',
    iconColor: 'text-error',
    textColor: 'text-error',
  },
  guardrail_input_blocked: {
    bgColor: 'bg-error-subtle',
    iconColor: 'text-error',
    textColor: 'text-error',
  },
  guardrail_output_blocked: {
    bgColor: 'bg-error-subtle',
    iconColor: 'text-error',
    textColor: 'text-error',
  },
  // Voice events (purple tones)
  voice_turn_start: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  voice_turn_end: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  voice_stt: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  voice_llm: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  voice_tts: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  voice_tts_quality: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  voice_asr_quality: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  voice_asr_cascade: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  voice_external_api: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  voice_barge_in: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  voice_silence_detected: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  voice_realtime_turn_start: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  voice_realtime_turn_end: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  voice_realtime_tool_call: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  voice_realtime_connection: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  voice_realtime_interruption: {
    bgColor: 'bg-purple-subtle',
    iconColor: 'text-purple',
    textColor: 'text-purple',
  },
  // Fan-out events (info/teal tones)
  fan_out_start: {
    bgColor: 'bg-info-subtle',
    iconColor: 'text-info',
    textColor: 'text-info',
  },
  fan_out_task_start: {
    bgColor: 'bg-info-subtle',
    iconColor: 'text-info',
    textColor: 'text-info',
  },
  fan_out_task_complete: {
    bgColor: 'bg-info-subtle',
    iconColor: 'text-info',
    textColor: 'text-info',
  },
  fan_out_complete: {
    bgColor: 'bg-info-subtle',
    iconColor: 'text-info',
    textColor: 'text-info',
  },
  fan_out_child_created: {
    bgColor: 'bg-info-subtle',
    iconColor: 'text-info',
    textColor: 'text-info',
  },
  fan_out_child_completed: {
    bgColor: 'bg-info-subtle',
    iconColor: 'text-info',
    textColor: 'text-info',
  },
  // Extraction events
  entity_extraction: {
    bgColor: 'bg-success-subtle',
    iconColor: 'text-success',
    textColor: 'text-success',
  },
  extraction_tier_selected: {
    bgColor: 'bg-success-subtle',
    iconColor: 'text-success',
    textColor: 'text-success',
  },
  extraction_attempt: {
    bgColor: 'bg-success-subtle',
    iconColor: 'text-success',
    textColor: 'text-success',
  },
  extraction_fallback: {
    bgColor: 'bg-warning-subtle',
    iconColor: 'text-warning',
    textColor: 'text-warning',
  },
  extraction_parse_fallback: {
    bgColor: 'bg-warning-subtle',
    iconColor: 'text-warning',
    textColor: 'text-warning',
  },
};

// Dotted type aliases — ClickHouse returns dotted names; these map to the same
// colors as their underscore equivalents so lookups work even before normalization.
const DOTTED_DOT_ALIASES: Record<string, string> = {
  'llm.call.completed': 'bg-accent',
  'llm.call.failed': 'bg-accent',
  'tool.call.completed': 'bg-orange',
  'tool.call.failed': 'bg-orange',
  'agent.decision': 'bg-purple',
  'agent.entered': 'bg-success',
  'agent.exited': 'bg-success',
  'agent.handoff': 'bg-info',
  'agent.escalated': 'bg-error',
  'agent.delegated': 'bg-purple',
  'agent.delegate.completed': 'bg-purple',
  'agent.constraint.checked': 'bg-warning',
  'flow.step.entered': 'bg-accent',
  'flow.step.exited': 'bg-accent',
  'flow.transition': 'bg-accent',
  'message.user.received': 'bg-accent',
  'system.error': 'bg-error',
};

// Merge dotted aliases into EVENT_DOT_COLORS
for (const [dotted, color] of Object.entries(DOTTED_DOT_ALIASES)) {
  EVENT_DOT_COLORS[dotted] = color;
}

const DOTTED_CARD_ALIASES: Record<string, string> = {
  'llm.call.completed': 'llm_call',
  'llm.call.failed': 'llm_call',
  'tool.call.completed': 'tool_call',
  'tool.call.failed': 'tool_call',
  'agent.decision': 'decision',
  'agent.entered': 'agent_enter',
  'agent.exited': 'agent_exit',
  'agent.handoff': 'handoff',
  'agent.escalated': 'escalation',
  'agent.delegated': 'delegate_start',
  'agent.delegate.completed': 'delegate_complete',
  'agent.constraint.checked': 'constraint_check',
  'flow.step.entered': 'flow_step_enter',
  'flow.step.exited': 'flow_step_exit',
  'flow.transition': 'flow_transition',
  'message.user.received': 'user_message',
  'system.error': 'error',
};

// Merge dotted aliases into EVENT_CARD_COLORS
for (const [dotted, underscore] of Object.entries(DOTTED_CARD_ALIASES)) {
  if (EVENT_CARD_COLORS[underscore]) {
    EVENT_CARD_COLORS[dotted] = EVENT_CARD_COLORS[underscore];
  }
}

export const DEFAULT_EVENT_COLORS: EventColorConfig = {
  bgColor: 'bg-background-subtle',
  iconColor: 'text-muted',
  textColor: 'text-muted',
};

/** Severity badge colors */
export const SEVERITY_COLORS: Record<string, { bg: string; text: string }> = {
  error: { bg: 'bg-error-subtle', text: 'text-error' },
  warn: { bg: 'bg-warning-subtle', text: 'text-warning' },
  info: { bg: 'bg-info-subtle', text: 'text-info' },
  debug: { bg: 'bg-background-elevated', text: 'text-muted' },
};
