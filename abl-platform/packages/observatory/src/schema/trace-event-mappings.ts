/**
 * Canonical trace/platform event name mappings.
 *
 * Runtime emits underscore trace event types internally while EventStore and
 * ClickHouse persist dotted platform event names. Keep both directions here so
 * runtime replay and Studio normalization cannot drift independently.
 */

export const TRACE_TO_PLATFORM_TYPE: Readonly<Record<string, string>> = Object.freeze({
  llm_call: 'llm.call.completed', // override to .failed at emit site when has_error
  tool_call: 'tool.call.completed', // override to .failed at emit site when has_error
  tool_call_retry: 'tool.call.retried',
  agent_enter: 'agent.entered',
  agent_exit: 'agent.exited',
  handoff: 'agent.handoff',
  escalation: 'agent.escalated',
  delegate: 'agent.delegated',
  delegate_start: 'agent.delegated',
  delegate_complete: 'agent.delegate.completed',
  decision: 'agent.decision',
  routing_capabilities_resolved: 'agent.decision',
  handoff_condition_check: 'agent.handoff.condition_checked',
  handoff_return_handler: 'agent.handoff.return_handler',
  resume_intent: 'agent.handoff.resume_intent',
  thread_resume: 'agent.thread.resumed',
  return_to_parent: 'agent.thread.returned',
  constraint_check: 'agent.constraint.checked',
  flow_step_enter: 'flow.step.entered',
  flow_step_exit: 'flow.step.exited',
  flow_transition: 'flow.transition',
  session_created: 'session.started',
  session_ended: 'session.ended',
  session_updated: 'session.updated',
  turn_start: 'session.turn.started',
  turn_end: 'session.turn.ended',
  user_message: 'message.user.received',
  agent_response: 'message.agent.sent',
  voice_session_start: 'voice.session.started',
  voice_session_end: 'voice.session.ended',
  voice_turn: 'voice.turn.completed',
  voice_stt: 'voice.stt.completed',
  voice_tts: 'voice.tts.completed',
  voice_realtime_tool_call: 'voice.realtime.tool_call',
  voice_barge_in: 'voice.barge_in.detected',
  voice_asr_quality: 'voice.asr_quality.analyzed',
  voice_tts_quality: 'voice.tts_quality.measured',
  voice_asr_cascade: 'voice.asr_cascade.detected',
  error: 'system.error',
  attachment_upload: 'attachment.uploaded',
  attachment_scan: 'attachment.scanned',
  attachment_process: 'attachment.processed',
  attachment_index: 'attachment.indexed',
  attachment_delete: 'attachment.deleted',
  attachment_preprocess: 'attachment.preprocessed',
  channel_message_received: 'channel.message.received',
  channel_message_sent: 'channel.message.sent',
  channel_response_sent: 'channel.response.sent',
  channel_webhook_delivered: 'channel.webhook.delivered',
  escalation_triggered: 'agent.escalation.triggered',
  escalation_resolved: 'agent.escalation.resolved',
  itsm_ticket_created: 'agent.escalation.itsm_created',
  hook_executed: 'agent.hook.executed',
  agent_error_handled: 'agent.error.handled',
  behavior_profile_applied: 'agent.profile.applied',
  voice_config_resolved: 'agent.voice.config_resolved',
  action_handler_executed: 'flow.action_handler.executed',
  'agent_transfer.transfer_initiated': 'agent.transfer.initiated',
  'agent_transfer.agent_connected': 'agent.transfer.agent_connected',
  'agent_transfer.transfer_completed': 'agent.transfer.completed',
  'agent_transfer.transfer_failed': 'agent.transfer.failed',
  'agent_transfer.agent_disconnected': 'agent.transfer.agent_disconnected',
  'agent_transfer.csat_completed': 'agent.transfer.csat_completed',
  'agent_transfer.acw_completed': 'agent.transfer.acw_completed',
});

/**
 * Durable fallback for runtime trace events that do not have a semantic
 * platform-event mapping yet. The original runtime type is stored in the data
 * payload under RUNTIME_TRACE_TYPE_DATA_KEY so historical replay can restore it.
 */
export const RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE = 'system.runtime_trace';
export const RUNTIME_TRACE_TYPE_DATA_KEY = '_runtime_trace_type';
export const RUNTIME_TRACE_UNMAPPED_DATA_KEY = '_runtime_trace_unmapped';

/**
 * Compatibility aliases for dotted platform events that intentionally collapse
 * onto an existing canonical trace event name.
 */
export const PLATFORM_TO_TRACE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'llm.call.failed': 'llm_call',
  'tool.call.failed': 'tool_call',
  'tool.call.retried': 'tool_call_retry',
});

export const PLATFORM_TO_TRACE_TYPE: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(
    Object.entries(TRACE_TO_PLATFORM_TYPE).reduce<Record<string, string>>(
      (reverseMap, [traceType, platformType]) => {
        reverseMap[platformType] = traceType;
        return reverseMap;
      },
      {},
    ),
    PLATFORM_TO_TRACE_ALIASES,
  ),
);
