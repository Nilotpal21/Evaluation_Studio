/**
 * Session event schemas.
 *
 * Events related to session lifecycle: started, ended, resumed, terminated.
 */

import { z } from 'zod';
import { eventRegistry } from '../event-registry.js';
import { EVENT_CATEGORIES } from '../event-categories.js';

const SESSION_ENDED_COMPAT_REASONS = [
  'completed',
  'timeout',
  'error',
  'user_left',
  'user_exit',
] as const;
const SESSION_ENDED_CANONICAL_DISPOSITIONS = [
  'completed',
  'abandoned',
  'agent_hangup',
  'transferred',
  'failed',
  'timeout',
  'unengaged',
] as const;
const SESSION_ENDED_STATUSES = ['completed', 'escalated', 'abandoned'] as const;
const SESSION_TERMINAL_SOURCES = [
  'close_api',
  'bulk_close',
  'cleanup',
  'disconnect',
  'sdk_end_session',
  'transfer_end',
  'provider_end',
] as const;

// ─── session.started ───────────────────────────────────────────────────────

export const SessionStartedDataSchema = z
  .object({
    channel: z.string().optional(),
    agent_name: z.string().optional(),
    agentName: z.string().optional(),
    deployment_id: z.string().optional(),
    deploymentId: z.string().optional(),
    resolution_method: z.enum(['new', 'resumed', 'artifact']).optional(),
    resolutionMethod: z.enum(['new', 'resumed', 'artifact']).optional(),
    caller_identity_tier: z.enum(['anonymous', 'identified', 'verified']).optional(),
    callerIdentityTier: z.enum(['anonymous', 'identified', 'verified']).optional(),
  })
  .passthrough();

export type SessionStartedData = z.infer<typeof SessionStartedDataSchema>;

eventRegistry.register('session.started', SessionStartedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.SESSION,
  containsPII: false,
  description: 'Session created or resumed',
});

// ─── session.ended ─────────────────────────────────────────────────────────

export const SessionEndedDataSchema = z
  .object({
    reason: z
      .union([z.enum(SESSION_ENDED_COMPAT_REASONS), z.enum(SESSION_ENDED_CANONICAL_DISPOSITIONS)])
      .optional(),
    disposition: z.enum(SESSION_ENDED_CANONICAL_DISPOSITIONS).optional(),
    status: z.enum(SESSION_ENDED_STATUSES).optional(),
    terminal_source: z.enum(SESSION_TERMINAL_SOURCES).optional(),
    terminalSource: z.enum(SESSION_TERMINAL_SOURCES).optional(),
    total_duration_ms: z.number().optional(),
    totalDurationMs: z.number().optional(),
    total_turns: z.number().optional(),
    totalTurns: z.number().optional(),
    total_llm_calls: z.number().optional(),
    totalLlmCalls: z.number().optional(),
    total_tool_calls: z.number().optional(),
    totalToolCalls: z.number().optional(),
    total_tokens: z.number().optional(),
    totalTokens: z.number().optional(),
    estimated_cost: z.number().optional(),
    estimatedCost: z.number().optional(),
  })
  .passthrough();

export type SessionEndedData = z.infer<typeof SessionEndedDataSchema>;

eventRegistry.register('session.ended', SessionEndedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.SESSION,
  containsPII: false,
  description: 'Session completed or terminated',
});

// ─── session.resumed ───────────────────────────────────────────────────────

export const SessionResumedDataSchema = z
  .object({
    resolution_method: z.enum(['explicit_id', 'channel_artifact']).optional(),
    resolutionMethod: z.enum(['explicit_id', 'channel_artifact']).optional(),
    original_session_age_ms: z.number().optional(),
    originalSessionAgeMs: z.number().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

export type SessionResumedData = z.infer<typeof SessionResumedDataSchema>;

eventRegistry.register('session.resumed', SessionResumedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.SESSION,
  containsPII: false,
  description: 'Existing session resumed',
});

// ─── session.terminated ────────────────────────────────────────────────────

export const SessionTerminatedDataSchema = z
  .object({
    reason: z.enum(['stale', 'expired', 'over_capacity']).optional(),
    inactivity_duration_ms: z.number().optional(),
    inactivityDurationMs: z.number().optional(),
  })
  .passthrough();

export type SessionTerminatedData = z.infer<typeof SessionTerminatedDataSchema>;

eventRegistry.register('session.terminated', SessionTerminatedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.SESSION,
  containsPII: false,
  description: 'Session forcibly terminated by system',
});

// ─── session.updated ──────────────────────────────────────────────────────

export const SessionUpdatedDataSchema = z
  .object({
    update_source: z
      .enum(['injection', 'gather', 'set', 'tool_result', 'handoff', 'execution'])
      .optional(),
    updateSource: z
      .enum(['injection', 'gather', 'set', 'tool_result', 'handoff', 'execution'])
      .optional(),
    keys_updated: z.array(z.string()).optional(),
    keysUpdated: z.array(z.string()).optional(),
    update_count: z.number().optional(),
    updateCount: z.number().optional(),
  })
  .passthrough();

export type SessionUpdatedData = z.infer<typeof SessionUpdatedDataSchema>;

eventRegistry.register('session.updated', SessionUpdatedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.SESSION,
  containsPII: false,
  description: 'Session context or state updated',
});

// ─── session.turn.started ──────────────────────────────────────────────────

export const SessionTurnStartedDataSchema = z
  .object({
    agent: z.string().optional(),
    agentName: z.string().optional(),
    turnIndex: z.number().optional(),
    turn_index: z.number().optional(),
    messageId: z.string().optional(),
    message_id: z.string().optional(),
    source: z.string().optional(),
  })
  .passthrough();

export type SessionTurnStartedData = z.infer<typeof SessionTurnStartedDataSchema>;

eventRegistry.register('session.turn.started', SessionTurnStartedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.SESSION,
  containsPII: false,
  description: 'Session turn started — user message accepted for execution',
});

// ─── session.turn.ended ────────────────────────────────────────────────────

export const SessionTurnEndedDataSchema = z
  .object({
    agent: z.string().optional(),
    agentName: z.string().optional(),
    turnIndex: z.number().optional(),
    turn_index: z.number().optional(),
    outcome: z.string().optional(),
    durationMs: z.number().optional(),
    duration_ms: z.number().optional(),
  })
  .passthrough();

export type SessionTurnEndedData = z.infer<typeof SessionTurnEndedDataSchema>;

eventRegistry.register('session.turn.ended', SessionTurnEndedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.SESSION,
  containsPII: false,
  description: 'Session turn ended — execution returned a terminal action',
});
