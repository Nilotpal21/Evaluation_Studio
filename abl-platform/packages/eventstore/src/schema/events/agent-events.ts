/**
 * Agent event schemas.
 *
 * Events related to agent routing: entered, exited, handoff, escalation, delegation, decisions, constraints.
 */

import { z } from 'zod';
import { eventRegistry } from '../event-registry.js';
import { EVENT_CATEGORIES } from '../event-categories.js';

const AgentEnteredTriggerSchema = z
  .enum(['user_message', 'handoff', 'delegate', 'resume_intent', 'fan_out'])
  .or(z.string().min(1));
const AgentExitedResultSchema = z
  .enum([
    'completed',
    'complete',
    'continue',
    'constraint_blocked',
    'escalate',
    'handoff',
    'delegate',
    'error',
    'return_to_parent',
    'waiting_for_action',
    'collect',
  ])
  .or(z.string().min(1));

// ─── agent.entered ─────────────────────────────────────────────────────────

export const AgentEnteredDataSchema = z
  .object({
    mode: z.enum(['scripted', 'reasoning']).optional(),
    trigger: AgentEnteredTriggerSchema.optional(),
  })
  .passthrough();

export type AgentEnteredData = z.infer<typeof AgentEnteredDataSchema>;

eventRegistry.register('agent.entered', AgentEnteredDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: false,
  description: 'Agent became active',
});

// ─── agent.exited ──────────────────────────────────────────────────────────

export const AgentExitedDataSchema = z
  .object({
    result: AgentExitedResultSchema.optional(),
    duration_ms: z.number().optional(),
    durationMs: z.number().optional(),
  })
  .passthrough();

export type AgentExitedData = z.infer<typeof AgentExitedDataSchema>;

eventRegistry.register('agent.exited', AgentExitedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: false,
  description: 'Agent finished execution',
});

// ─── agent.handoff ─────────────────────────────────────────────────────────

export const AgentHandoffDataSchema = z
  .object({
    from_agent: z.string().optional(),
    fromAgent: z.string().optional(),
    to_agent: z.string().optional(),
    toAgent: z.string().optional(),
    reason: z.string().optional(),
    context_meta: z.record(z.unknown()).optional(),
    contextMeta: z.record(z.unknown()).optional(),
    return_expected: z.boolean().optional(),
    returnExpected: z.boolean().optional(),
  })
  .passthrough();

export type AgentHandoffData = z.infer<typeof AgentHandoffDataSchema>;

eventRegistry.register('agent.handoff', AgentHandoffDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: true,
  description: 'Agent handed off to another agent',
});

// ─── agent.escalated ───────────────────────────────────────────────────────

export const AgentEscalatedDataSchema = z
  .object({
    from_agent: z.string().optional(),
    fromAgent: z.string().optional(),
    reason: z.string().optional(),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    user_message_count: z.number().optional(),
    userMessageCount: z.number().optional(),
  })
  .passthrough();

export type AgentEscalatedData = z.infer<typeof AgentEscalatedDataSchema>;

eventRegistry.register('agent.escalated', AgentEscalatedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: true,
  description: 'Agent escalated to human',
});

// ─── agent.escalation.triggered ───────────────────────────────────────────

export const AgentEscalationTriggeredDataSchema = z
  .object({
    reason: z.string().nullish(),
    priority: z.enum(['low', 'medium', 'high', 'critical']).nullish(),
    agent: z.string().optional(),
    agent_name: z.string().optional(),
    agentName: z.string().optional(),
    human_task_id: z.string().nullish(),
    humanTaskId: z.string().nullish(),
    has_agent_transfer: z.boolean().optional(),
    hasAgentTransfer: z.boolean().optional(),
    has_itsm_connector: z.boolean().optional(),
    hasItsmConnector: z.boolean().optional(),
    connector_action: z.string().optional(),
    connectorAction: z.string().optional(),
    is_paused: z.boolean().optional(),
    isPaused: z.boolean().optional(),
    session_id: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .passthrough();

export type AgentEscalationTriggeredData = z.infer<typeof AgentEscalationTriggeredDataSchema>;

eventRegistry.register('agent.escalation.triggered', AgentEscalationTriggeredDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: true,
  description: 'Agent escalation was triggered',
});

// ─── agent.escalation.resolved ────────────────────────────────────────────

export const AgentEscalationResolvedDataSchema = z
  .object({
    human_task_id: z.string().optional(),
    humanTaskId: z.string().optional(),
    decision: z.string().optional(),
    action: z.string().optional(),
    responded_by: z.string().optional(),
    respondedBy: z.string().optional(),
    session_id: z.string().optional(),
    sessionId: z.string().optional(),
    duration_ms: z.number().optional(),
    durationMs: z.number().optional(),
  })
  .passthrough();

export type AgentEscalationResolvedData = z.infer<typeof AgentEscalationResolvedDataSchema>;

eventRegistry.register('agent.escalation.resolved', AgentEscalationResolvedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: true,
  description: 'Agent escalation was resolved by a human',
});

// ─── agent.escalation.itsm_created ────────────────────────────────────────

export const AgentEscalationItsmCreatedDataSchema = z
  .object({
    connector_action: z.string().optional(),
    connectorAction: z.string().optional(),
    connector_name: z.string().optional(),
    connectorName: z.string().optional(),
    human_task_id: z.string().optional(),
    humanTaskId: z.string().optional(),
    ticket_id: z.string().nullish(),
    ticketId: z.string().nullish(),
    ticket_url: z.string().nullish(),
    ticketUrl: z.string().nullish(),
    session_id: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .passthrough();

export type AgentEscalationItsmCreatedData = z.infer<typeof AgentEscalationItsmCreatedDataSchema>;

eventRegistry.register('agent.escalation.itsm_created', AgentEscalationItsmCreatedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: false,
  description: 'ITSM ticket was created for an agent escalation',
});

// ─── agent.delegated ───────────────────────────────────────────────────────

export const AgentDelegatedDataSchema = z
  .object({
    from_agent: z.string().optional(),
    fromAgent: z.string().optional(),
    to_agent: z.string().optional(),
    toAgent: z.string().optional(),
    task_summary: z.string().optional(),
    taskSummary: z.string().optional(),
    success: z.boolean().optional(),
    duration_ms: z.number().optional(),
    durationMs: z.number().optional(),
  })
  .passthrough();

export type AgentDelegatedData = z.infer<typeof AgentDelegatedDataSchema>;

eventRegistry.register('agent.delegated', AgentDelegatedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: true,
  description: 'Agent delegated task to sub-agent',
});

// ─── agent.fanout.completed ────────────────────────────────────────────────

export const AgentFanoutCompletedDataSchema = z
  .object({
    from_agent: z.string().optional(),
    fromAgent: z.string().optional(),
    target_count: z.number().optional(),
    targetCount: z.number().optional(),
    success_count: z.number().optional(),
    successCount: z.number().optional(),
    failure_count: z.number().optional(),
    failureCount: z.number().optional(),
    total_duration_ms: z.number().optional(),
    totalDurationMs: z.number().optional(),
  })
  .passthrough();

export type AgentFanoutCompletedData = z.infer<typeof AgentFanoutCompletedDataSchema>;

eventRegistry.register('agent.fanout.completed', AgentFanoutCompletedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: false,
  description: 'Agent fanout to multiple targets completed',
});

// ─── agent.delegate.completed ─────────────────────────────────────────────

export const AgentDelegateCompletedDataSchema = z
  .object({
    agent_name: z.string().optional(),
    agentName: z.string().optional(),
    duration_ms: z.number().optional(),
    durationMs: z.number().optional(),
    task_summary: z.string().optional(),
    taskSummary: z.string().optional(),
  })
  .passthrough();

export type AgentDelegateCompletedData = z.infer<typeof AgentDelegateCompletedDataSchema>;

eventRegistry.register('agent.delegate.completed', AgentDelegateCompletedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: true,
  description: 'Agent delegation completed',
});

// ─── agent.hook.executed ──────────────────────────────────────────────────

export const AgentHookExecutedDataSchema = z
  .object({
    hook_type: z.enum(['before_agent', 'after_agent', 'before_turn', 'after_turn']).optional(),
    hookType: z.enum(['before_agent', 'after_agent', 'before_turn', 'after_turn']).optional(),
    actions_executed: z.array(z.string()).optional(),
    actionsExecuted: z.array(z.string()).optional(),
    duration_ms: z.number().optional(),
    durationMs: z.number().optional(),
    success: z.boolean().optional(),
    error: z.string().optional(),
    tool_calls_made: z.number().optional(),
    toolCallsMade: z.number().optional(),
  })
  .passthrough();

export type AgentHookExecutedData = z.infer<typeof AgentHookExecutedDataSchema>;

eventRegistry.register('agent.hook.executed', AgentHookExecutedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: false,
  description: 'Agent lifecycle hook executed',
});

// ─── agent.error.handled ──────────────────────────────────────────────────

export const AgentErrorHandledDataSchema = z
  .object({
    error_type: z.string().optional(),
    errorType: z.string().optional(),
    subtype: z.string().optional(),
    message: z.string().optional(),
    action: z.string().optional(),
    handler: z.string().optional(),
    field: z.string().optional(),
    agent: z.string().optional(),
    agent_name: z.string().optional(),
    agentName: z.string().optional(),
    error_code: z.string().optional(),
    errorCode: z.string().optional(),
    diagnostic: z.unknown().optional(),
  })
  .passthrough();

export type AgentErrorHandledData = z.infer<typeof AgentErrorHandledDataSchema>;

eventRegistry.register('agent.error.handled', AgentErrorHandledDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: true,
  description: 'Agent-level error handler matched and handled an error',
});

// ─── agent.profile.applied ────────────────────────────────────────────────

const profileToolDeltaSchema = z.union([z.number(), z.array(z.string())]);

export const AgentProfileAppliedDataSchema = z
  .object({
    profile_name: z.string().optional(),
    profileName: z.string().optional(),
    previous_profiles: z.array(z.string()).optional(),
    previousProfiles: z.array(z.string()).optional(),
    active_profiles: z.array(z.string()).optional(),
    activeProfiles: z.array(z.string()).optional(),
    tools_added: profileToolDeltaSchema.optional(),
    toolsAdded: profileToolDeltaSchema.optional(),
    tools_hidden: profileToolDeltaSchema.optional(),
    toolsHidden: profileToolDeltaSchema.optional(),
    has_voice_override: z.boolean().optional(),
    hasVoiceOverride: z.boolean().optional(),
    turn_count: z.number().optional(),
    turnCount: z.number().optional(),
    agent: z.string().optional(),
    agent_name: z.string().optional(),
    agentName: z.string().optional(),
  })
  .passthrough();

export type AgentProfileAppliedData = z.infer<typeof AgentProfileAppliedDataSchema>;

eventRegistry.register('agent.profile.applied', AgentProfileAppliedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: false,
  description: 'Agent behavior profile overrides were applied',
});

// ─── agent.voice.config_resolved ──────────────────────────────────────────

export const AgentVoiceConfigResolvedDataSchema = z
  .object({
    provider: z.string().optional(),
    voice_id: z.string().optional(),
    voiceId: z.string().optional(),
    source: z.string().optional(),
    speed: z.number().optional(),
    tts_vendor: z.string().optional(),
    ttsVendor: z.string().optional(),
    tts_voice: z.string().optional(),
    ttsVoice: z.string().optional(),
    mode: z.string().optional(),
  })
  .passthrough();

export type AgentVoiceConfigResolvedData = z.infer<typeof AgentVoiceConfigResolvedDataSchema>;

eventRegistry.register('agent.voice.config_resolved', AgentVoiceConfigResolvedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: false,
  description: 'Agent voice configuration was resolved',
});

// ─── agent.decision ────────────────────────────────────────────────────────

export const AgentDecisionDataSchema = z
  .object({
    decisionKind: z
      .enum([
        'handoff',
        'delegation',
        'flow_transition',
        'field_validation',
        'escalation',
        'completion',
        'constraint_check',
        'guardrail_check',
        'gather_extraction',
        'correction',
        'data_mutation',
      ])
      .optional(),
    outcome: z.string().optional(),
    reasoning: z.string().optional(),
  })
  .passthrough();

export type AgentDecisionData = z.infer<typeof AgentDecisionDataSchema>;

eventRegistry.register('agent.decision', AgentDecisionDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: true,
  description: 'Agent made a routing or escalation decision',
});

// ─── agent.constraint.checked ──────────────────────────────────────────────

export const AgentConstraintCheckedDataSchema = z
  .object({
    constraint_name: z.string().optional(),
    constraintName: z.string().optional(),
    passed: z.boolean().optional(),
    violation_type: z.string().optional(),
    violationType: z.string().optional(),
    handler_action: z.string().optional(),
    handlerAction: z.string().optional(),
  })
  .passthrough();

export type AgentConstraintCheckedData = z.infer<typeof AgentConstraintCheckedDataSchema>;

eventRegistry.register('agent.constraint.checked', AgentConstraintCheckedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: false,
  description: 'Agent constraint validation result',
});

// ─── agent.handoff.condition_checked ───────────────────────────────────────

export const AgentHandoffConditionCheckedDataSchema = z
  .object({
    agent: z.string().optional(),
    agentName: z.string().optional(),
    target: z.string().optional(),
    condition: z.string().optional(),
    matched: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export type AgentHandoffConditionCheckedData = z.infer<
  typeof AgentHandoffConditionCheckedDataSchema
>;

eventRegistry.register('agent.handoff.condition_checked', AgentHandoffConditionCheckedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: false,
  description: 'Handoff condition evaluated during routing',
});

// ─── agent.handoff.return_handler ──────────────────────────────────────────

export const AgentHandoffReturnHandlerDataSchema = z
  .object({
    agent: z.string().optional(),
    agentName: z.string().optional(),
    fromAgent: z.string().optional(),
    from_agent: z.string().optional(),
    handlerName: z.string().optional(),
    handler_name: z.string().optional(),
    action: z.string().optional(),
  })
  .passthrough();

export type AgentHandoffReturnHandlerData = z.infer<typeof AgentHandoffReturnHandlerDataSchema>;

eventRegistry.register('agent.handoff.return_handler', AgentHandoffReturnHandlerDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: false,
  description: 'Handoff ON_RETURN handler executed',
});

// ─── agent.handoff.resume_intent ───────────────────────────────────────────

export const AgentHandoffResumeIntentDataSchema = z
  .object({
    agent: z.string().optional(),
    agentName: z.string().optional(),
    sourceAgent: z.string().optional(),
    source_agent: z.string().optional(),
    messageSource: z.string().optional(),
    message_source: z.string().optional(),
    reasonCode: z.string().optional(),
    reason_code: z.string().optional(),
  })
  .passthrough();

export type AgentHandoffResumeIntentData = z.infer<typeof AgentHandoffResumeIntentDataSchema>;

eventRegistry.register('agent.handoff.resume_intent', AgentHandoffResumeIntentDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: true,
  description: 'Parent resumed the original user intent after a handoff returned',
});

// ─── agent.thread.resumed ──────────────────────────────────────────────────

export const AgentThreadResumedDataSchema = z
  .object({
    agent: z.string().optional(),
    agentName: z.string().optional(),
    parentThreadIndex: z.number().optional(),
    parent_thread_index: z.number().optional(),
    childThreadIndex: z.number().optional(),
    child_thread_index: z.number().optional(),
    threadStackDepth: z.number().optional(),
    thread_stack_depth: z.number().optional(),
  })
  .passthrough();

export type AgentThreadResumedData = z.infer<typeof AgentThreadResumedDataSchema>;

eventRegistry.register('agent.thread.resumed', AgentThreadResumedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: false,
  description: 'Parent thread resumed after a child thread completed',
});

// ─── agent.thread.returned ─────────────────────────────────────────────────

export const AgentThreadReturnedDataSchema = z
  .object({
    agent: z.string().optional(),
    agentName: z.string().optional(),
    fromAgent: z.string().optional(),
    from_agent: z.string().optional(),
    toAgent: z.string().optional(),
    to_agent: z.string().optional(),
    parentThreadIndex: z.number().optional(),
    parent_thread_index: z.number().optional(),
    childThreadIndex: z.number().optional(),
    child_thread_index: z.number().optional(),
    forwardedMessage: z.string().optional(),
    forwarded_message: z.string().optional(),
  })
  .passthrough();

export type AgentThreadReturnedData = z.infer<typeof AgentThreadReturnedDataSchema>;

eventRegistry.register('agent.thread.returned', AgentThreadReturnedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: true,
  description: 'Child thread returned control to its parent',
});

// ─── agent.transfer.initiated ─────────────────────────────────────────────

export const AgentTransferInitiatedDataSchema = z
  .object({
    provider: z.string().optional(),
    channel: z.string().optional(),
    queue: z.string().optional(),
    skills: z.array(z.string()).optional(),
    runtimeSessionId: z.string().optional(),
    contactId: z.string().optional(),
  })
  .passthrough();

export type AgentTransferInitiatedData = z.infer<typeof AgentTransferInitiatedDataSchema>;

eventRegistry.register('agent.transfer.initiated', AgentTransferInitiatedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: true,
  description: 'Agent transfer to human agent was initiated',
});

// ─── agent.transfer.agent_connected ──────────────────────────────────────

export const AgentTransferAgentConnectedDataSchema = z
  .object({
    provider: z.string().optional(),
    channel: z.string().optional(),
    agentName: z.string().optional(),
    agent_name: z.string().optional(),
    waitTimeMs: z.number().optional(),
    wait_time_ms: z.number().optional(),
    runtimeSessionId: z.string().optional(),
    contactId: z.string().optional(),
  })
  .passthrough();

export type AgentTransferAgentConnectedData = z.infer<typeof AgentTransferAgentConnectedDataSchema>;

eventRegistry.register('agent.transfer.agent_connected', AgentTransferAgentConnectedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: true,
  description: 'Human agent connected to the transfer session',
});

// ─── agent.transfer.completed ─────────────────────────────────────────────

export const AgentTransferCompletedDataSchema = z
  .object({
    provider: z.string().optional(),
    channel: z.string().optional(),
    status: z.string().optional(),
    durationMs: z.number().optional(),
    duration_ms: z.number().optional(),
    runtimeSessionId: z.string().optional(),
    contactId: z.string().optional(),
  })
  .passthrough();

export type AgentTransferCompletedData = z.infer<typeof AgentTransferCompletedDataSchema>;

eventRegistry.register('agent.transfer.completed', AgentTransferCompletedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: true,
  description: 'Agent transfer session completed',
});

// ─── agent.transfer.failed ────────────────────────────────────────────────

export const AgentTransferFailedDataSchema = z
  .object({
    provider: z.string().optional(),
    channel: z.string().optional(),
    errorCode: z.string().optional(),
    error_code: z.string().optional(),
    errorMessage: z.string().optional(),
    error_message: z.string().optional(),
    runtimeSessionId: z.string().optional(),
    contactId: z.string().optional(),
  })
  .passthrough();

export type AgentTransferFailedData = z.infer<typeof AgentTransferFailedDataSchema>;

eventRegistry.register('agent.transfer.failed', AgentTransferFailedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: true,
  description: 'Agent transfer to human agent failed',
});

// ─── agent.transfer.agent_disconnected ───────────────────────────────────

export const AgentTransferAgentDisconnectedDataSchema = z
  .object({
    provider: z.string().optional(),
    channel: z.string().optional(),
    reason: z.string().optional(),
    durationMs: z.number().optional(),
    duration_ms: z.number().optional(),
    runtimeSessionId: z.string().optional(),
    contactId: z.string().optional(),
    originalType: z.string().optional(),
    syntheticDisconnect: z.boolean().optional(),
    isACWEnabled: z.boolean().optional(),
    acwStartTime: z.string().optional(),
  })
  .passthrough();

export type AgentTransferAgentDisconnectedData = z.infer<
  typeof AgentTransferAgentDisconnectedDataSchema
>;

eventRegistry.register(
  'agent.transfer.agent_disconnected',
  AgentTransferAgentDisconnectedDataSchema,
  {
    version: '1.0.0',
    category: EVENT_CATEGORIES.AGENT,
    containsPII: true,
    description: 'Human agent disconnected from the transfer session',
  },
);

// ─── agent.transfer.csat_completed ───────────────────────────────────────

export const AgentTransferCsatCompletedDataSchema = z
  .object({
    provider: z.string().optional(),
    channel: z.string().optional(),
    score: z.number().optional(),
    feedback: z.string().optional(),
    runtimeSessionId: z.string().optional(),
    contactId: z.string().optional(),
  })
  .passthrough();

export type AgentTransferCsatCompletedData = z.infer<typeof AgentTransferCsatCompletedDataSchema>;

eventRegistry.register('agent.transfer.csat_completed', AgentTransferCsatCompletedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: true,
  description: 'CSAT survey completed after an agent transfer session',
});

// ─── agent.transfer.acw_completed ─────────────────────────────────────────

export const AgentTransferAcwCompletedDataSchema = z
  .object({
    provider: z.string().optional(),
    channel: z.string().optional(),
    acwCloseReason: z.enum(['timeout', 'agent_closed']).optional(),
    acwTimedOut: z.boolean().optional(),
    dispositionCode: z.string().optional(),
    reason: z.string().optional(),
    transferSessionId: z.string().optional(),
    runtimeSessionId: z.string().optional(),
    contactId: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .passthrough();

export type AgentTransferAcwCompletedData = z.infer<typeof AgentTransferAcwCompletedDataSchema>;

eventRegistry.register('agent.transfer.acw_completed', AgentTransferAcwCompletedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: true,
  description: 'After Contact Work completed following an agent transfer',
});
