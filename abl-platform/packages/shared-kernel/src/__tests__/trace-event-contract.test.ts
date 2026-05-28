/**
 * Trace Event Contract Test
 *
 * Ensures the RUNTIME_EVENT_TYPES registry stays in sync with:
 * - Studio-side EVENT_TO_STEP + LIFECYCLE_EVENTS + SESSION_EVENTS (coverage)
 * - Runtime-side EVENT_VERBOSITY (sync)
 * - No duplicate entries in the registry
 *
 * When this test fails, a new runtime event was added without updating
 * the studio mapping. Fix: add the event to EVENT_TO_STEP (or
 * LIFECYCLE_EVENTS/SESSION_EVENTS) and EVENT_LABELS in
 * apps/studio/src/components/observatory/interactions/constants.ts
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_TRACE_EVENT_TYPES,
  RUNTIME_EVENT_TYPES,
  TRACE_EVENT_REGISTRY,
} from '../constants/trace-event-registry.js';

// ── Studio-side coverage sets (duplicated for cross-package test) ──
// These MUST match the sets exported from
// apps/studio/src/components/observatory/interactions/constants.ts
// If you add an event to EVENT_TO_STEP, LIFECYCLE_EVENTS, or SESSION_EVENTS,
// update the corresponding set below.

/** All event types that map to a step type via EVENT_TO_STEP */
const MAPPED_EVENTS = new Set([
  // User Input
  'user_message',
  // LLM
  'llm_call',
  // Tool Calls
  'tool_call_start',
  'tool_call',
  'dsl_call',
  // Guardrails
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
  // Flow / Transitions
  'flow_step_enter',
  'flow_step_exit',
  'flow_transition',
  'step_thought',
  // Gather / Extraction
  'dsl_collect',
  'entity_extraction',
  'extraction_tier_selected',
  'extraction_attempt',
  'extraction_fallback',
  'extraction_parse_fallback',
  'extraction_strategy_resolved',
  'gather_field_activation',
  'gather_complete_reason',
  'dsl_on_input',
  'dsl_await_attachment',
  'constraint_backtrack',
  'constraint_backtrack_limit',
  'constraint_directive',
  'constraint_mini_collect',
  // Decisions
  'decision',
  'tool_thought',
  'handoff',
  'routing_capabilities_resolved',
  'handoff_condition_check',
  'deterministic_routing',
  'deterministic_handoff',
  'engine_decision',
  'completion_check',
  'correction',
  'correction_invalidation',
  'digression',
  'sub_intent',
  'pipeline_intent_bridge',
  'pipeline_tiered_action',
  'pipeline_out_of_scope_decline',
  'escalation',
  'constraint_check',
  'validation_fail_open',
  'status_update',
  'status_clear',
  'execution.queued',
  'execution.started',
  'execution.completed',
  'execution.cancelled',
  'queue_backpressure',
  // Agent Response
  'agent_response',
  'dsl_respond',
  'dsl_prompt',
  // Errors / Warnings
  'error',
  'constraint_violation',
  'warning',
  'agent_error_handled',
  'tool_call_error',
  'execution.failed',
  // Hooks / Actions
  'hook_executed',
  'action_handler_executed',
  'behavior_profile_applied',
  // Escalation lifecycle
  'escalation_triggered',
  'escalation_resolved',
  'itsm_ticket_created',
  // Voice
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
  // Parallel Execution
  'fan_out_start',
  'fan_out_task_start',
  'fan_out_task_complete',
  'fan_out_complete',
  'fan_out_child_created',
  'fan_out_child_completed',
  // Memory
  'data_stored',
  'dsl_set',
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
  // Agentic Compat
  'agent_assist.received',
  'agent_assist.binding_resolved',
  'agent_assist.delegated',
  'agent_assist.translated_response',
  'agent_assist.error',
  'agent_assist.callback_scheduled',
  'agent_assist.callback_delivered',
  'agent_assist.callback_failed',
  // PII
  'pii_plaintext_dispensed',
  'pii_audit_missing_tenant',
  'pii_pattern_override_suppressed_original',
]);

/** Events rendered as lifecycle banners (not steps) */
const LIFECYCLE_EVENTS = new Set([
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

/** Events rendered as session footer (not steps) */
const SESSION_EVENTS = new Set([
  'session_resolution',
  'session_created',
  'session_ended',
  'session_updated',
  'turn_start',
  'turn_end',
]);

// ── Runtime EVENT_VERBOSITY keys (duplicated for cross-package test) ──
const EVENT_VERBOSITY_KEYS = new Set([
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
]);

describe('Trace Event Contract', () => {
  it('covers every canonical trace event with registry metadata', () => {
    const registryKeys = Object.keys(TRACE_EVENT_REGISTRY).sort();
    const canonicalKeys = [...ALL_TRACE_EVENT_TYPES].sort();

    expect(registryKeys).toEqual(canonicalKeys);
  });

  it('every RUNTIME_EVENT_TYPES entry is part of the canonical trace contract', () => {
    const canonicalTypes = new Set<string>(ALL_TRACE_EVENT_TYPES);
    const unknownRuntimeTypes = RUNTIME_EVENT_TYPES.filter((type) => !canonicalTypes.has(type));

    expect(unknownRuntimeTypes).toEqual([]);
  });

  it('every RUNTIME_EVENT_TYPES entry is covered by studio mapping (EVENT_TO_STEP | LIFECYCLE_EVENTS | SESSION_EVENTS)', () => {
    const allMapped = new Set([...MAPPED_EVENTS, ...LIFECYCLE_EVENTS, ...SESSION_EVENTS]);
    const unmapped = RUNTIME_EVENT_TYPES.filter((t) => !allMapped.has(t));

    expect(unmapped).toEqual([]);
  });

  it('every RUNTIME_EVENT_TYPES entry that appears in EVENT_VERBOSITY is present in the registry', () => {
    const registrySet = new Set<string>(RUNTIME_EVENT_TYPES);
    const missingFromRegistry = [...EVENT_VERBOSITY_KEYS].filter((k) => !registrySet.has(k));

    expect(missingFromRegistry).toEqual([]);
  });

  it('every event in EVENT_TO_STEP has a human-readable label in EVENT_LABELS', () => {
    // EVENT_LABELS must cover every key in EVENT_TO_STEP.
    // Duplicated here for cross-package testing — must match
    // apps/studio/src/components/observatory/interactions/constants.ts EVENT_LABELS.
    const EVENT_LABELS_KEYS = new Set([
      // User Input
      'user_message',
      'message.user.received',
      // LLM
      'llm_call',
      'llm.call.completed',
      'llm.call.failed',
      'inference_start',
      'inference_complete',
      'inference_error',
      'inference_stream_start',
      'inference_stream_end',
      'engine_decision',
      // Tool Calls
      'tool_call_start',
      'tool_call',
      'tool_result',
      'tool_thought',
      'tool.call.completed',
      'tool.call.failed',
      'dsl_call',
      // Guardrails
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
      // Flow
      'flow_step_enter',
      'flow_step_exit',
      'flow_transition',
      'step_thought',
      'flow.step.entered',
      'flow.step.exited',
      'flow.transition',
      // Gather / Extraction
      'dsl_collect',
      'entity_extraction',
      'extraction_tier_selected',
      'extraction_attempt',
      'extraction_fallback',
      'extraction_parse_fallback',
      'extraction_strategy_resolved',
      'gather_field_activation',
      'gather_complete_reason',
      'dsl_on_input',
      'dsl_await_attachment',
      'constraint_backtrack',
      'constraint_backtrack_limit',
      'constraint_directive',
      'constraint_mini_collect',
      // Decisions
      'decision',
      'handoff',
      'agent.decision',
      'agent.handoff',
      'routing_capabilities_resolved',
      'handoff_condition_check',
      'deterministic_routing',
      'deterministic_handoff',
      'completion_check',
      'correction',
      'correction_invalidation',
      'digression',
      'sub_intent',
      'pipeline_intent_bridge',
      'pipeline_tiered_action',
      'pipeline_out_of_scope_decline',
      'escalation',
      'constraint_check',
      'validation_fail_open',
      'status_update',
      'status_clear',
      'execution.queued',
      'execution.started',
      'execution.completed',
      'execution.failed',
      'execution.cancelled',
      'queue_backpressure',
      // Agent Response
      'agent_response',
      'dsl_respond',
      'dsl_prompt',
      // Memory
      'data_stored',
      'dsl_set',
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
      // Errors / Warnings
      'error',
      'system.error',
      'constraint_violation',
      'warning',
      'agent_error_handled',
      'tool_call_error',
      // Hooks / Actions
      'hook_executed',
      'action_handler_executed',
      // Escalation Lifecycle
      'escalation_triggered',
      'escalation_resolved',
      'itsm_ticket_created',
      // Voice
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
      'behavior_profile_applied',
      // Parallel Execution
      'fan_out_start',
      'fan_out_task_start',
      'fan_out_task_complete',
      'fan_out_complete',
      'fan_out_child_created',
      'fan_out_child_completed',
      // Lifecycle (banners)
      'agent_enter',
      'agent_exit',
      'delegate_start',
      'delegate_complete',
      'handoff_return_handler',
      'resume_intent',
      'thread_resume',
      'thread_return',
      'return_to_parent',
      // Session
      'session_resolution',
      'session_created',
      'session_ended',
      'session_updated',
      'turn_start',
      'turn_end',
      // Agentic Compat
      'agent_assist.received',
      'agent_assist.binding_resolved',
      'agent_assist.delegated',
      'agent_assist.translated_response',
      'agent_assist.error',
      'agent_assist.callback_scheduled',
      'agent_assist.callback_delivered',
      'agent_assist.callback_failed',
      // PII
      'pii_plaintext_dispensed',
      'pii_audit_missing_tenant',
      'pii_pattern_override_suppressed_original',
    ]);

    // Every key in MAPPED_EVENTS should have a label
    const missingLabels = [...MAPPED_EVENTS].filter((k) => !EVENT_LABELS_KEYS.has(k));
    expect(missingLabels).toEqual([]);
  });

  it('RUNTIME_EVENT_TYPES has no duplicate entries', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const t of RUNTIME_EVENT_TYPES) {
      if (seen.has(t)) duplicates.push(t);
      seen.add(t);
    }

    expect(duplicates).toEqual([]);
  });

  it('ALL_TRACE_EVENT_TYPES has no duplicate entries', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const type of ALL_TRACE_EVENT_TYPES) {
      if (seen.has(type)) duplicates.push(type);
      seen.add(type);
    }

    expect(duplicates).toEqual([]);
  });
});
