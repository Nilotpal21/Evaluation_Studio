/**
 * Flow event schemas.
 *
 * Events related to flow execution in scripted agents: step transitions.
 */

import { z } from 'zod';
import { eventRegistry } from '../event-registry.js';
import { EVENT_CATEGORIES } from '../event-categories.js';

// ─── flow.step.entered ─────────────────────────────────────────────────────

export const FlowStepEnteredDataSchema = z
  .object({
    step_name: z.string().optional(),
    stepName: z.string().optional(),
    step_type: z.enum(['gather', 'call', 'respond', 'branch']).optional(),
    stepType: z.enum(['gather', 'call', 'respond', 'branch']).optional(),
  })
  .passthrough();

eventRegistry.register('flow.step.entered', FlowStepEnteredDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.FLOW,
  containsPII: false,
  description: 'Flow step started execution',
});

// ─── flow.step.exited ──────────────────────────────────────────────────────

export const FlowStepExitedDataSchema = z
  .object({
    step_name: z.string().optional(),
    stepName: z.string().optional(),
    duration_ms: z.number().optional(),
    durationMs: z.number().optional(),
    next_step: z.string().optional(),
    nextStep: z.string().optional(),
  })
  .passthrough();

eventRegistry.register('flow.step.exited', FlowStepExitedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.FLOW,
  containsPII: false,
  description: 'Flow step completed execution',
});

// ─── flow.transition ───────────────────────────────────────────────────────

export const FlowTransitionDataSchema = z
  .object({
    from_step: z.string().optional(),
    fromStep: z.string().optional(),
    to_step: z.string().optional(),
    toStep: z.string().optional(),
    condition: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

eventRegistry.register('flow.transition', FlowTransitionDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.FLOW,
  containsPII: false,
  description: 'Flow transitioned between steps',
});

// ─── flow.action_handler.executed ─────────────────────────────────────────

export const FlowActionHandlerExecutedDataSchema = z
  .object({
    action_id: z.string().optional(),
    actionId: z.string().optional(),
    source: z.enum(['step', 'agent']).optional(),
    handler_result: z.string().optional(),
    handlerResult: z.string().optional(),
    has_set: z.boolean().optional(),
    hasSet: z.boolean().optional(),
    has_respond: z.boolean().optional(),
    hasRespond: z.boolean().optional(),
    has_transition: z.boolean().optional(),
    hasTransition: z.boolean().optional(),
    transition_target: z.string().optional(),
    transitionTarget: z.string().optional(),
    step: z.string().optional(),
    step_name: z.string().optional(),
    stepName: z.string().optional(),
    agent: z.string().optional(),
    agent_name: z.string().optional(),
    agentName: z.string().optional(),
  })
  .passthrough();

export type FlowActionHandlerExecutedData = z.infer<typeof FlowActionHandlerExecutedDataSchema>;

eventRegistry.register('flow.action_handler.executed', FlowActionHandlerExecutedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.FLOW,
  containsPII: false,
  description: 'Interactive action handler executed',
});
