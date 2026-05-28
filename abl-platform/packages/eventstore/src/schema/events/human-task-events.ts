/**
 * Human-task event schemas (workflow mailbox only).
 *
 * Uses the same explicit-registration pattern as workflow-execution-events.ts
 * (see that file's header for the rationale). The `mailbox` field is pinned
 * to the literal 'workflow' — agent mailboxes are explicitly out of scope
 * for this event-sourcing pipeline (HLD §5.3 — scope enforced at MV too).
 */

import { z } from 'zod';
import { EventRegistry } from '../event-registry.js';

export const HumanTaskEventTypeSchema = z.enum([
  'human_task.created',
  'human_task.assigned',
  'human_task.approved',
  'human_task.rejected',
  'human_task.cancelled',
  'human_task.expired',
]);
export type HumanTaskEventType = z.infer<typeof HumanTaskEventTypeSchema>;

export const HumanTaskEventSchema = z
  .object({
    event_id: z.string().min(1),
    event_type: HumanTaskEventTypeSchema,
    event_version: z.string().default('1.0.0'),
    occurred_at: z.string(),
    tenant_id: z.string().min(1),
    project_id: z.string().min(1),
    task_id: z.string().min(1),
    execution_id: z.string().min(1),
    workflow_id: z.string().min(1),
    workflow_version: z.string().min(1),
    // HLD §5 — scope. Agent mailbox is out of scope and MUST be rejected here.
    mailbox: z.literal('workflow'),
    status: z.string().min(1),
    assignees: z.array(z.string()).default([]),
    approvers: z.array(z.string()).default([]),
    policy: z.record(z.unknown()).optional(),
    payload: z.record(z.unknown()).optional(),
    outcome: z.string().nullable().optional(),
    outcome_by: z.string().nullable().optional(),
    decided_at: z.string().nullable().optional(),
    // Cumulative state carried on every event (HLD §5.3 errata E-4).
    created_at: z.string().nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type HumanTaskEvent = z.infer<typeof HumanTaskEventSchema>;

/**
 * Registers one entry per event type. `EventRegistry.register()` stores
 * schemas in `Map<string, ZodSchema>` — no wildcard resolution, so each
 * event type must be registered explicitly (looping over `.options`).
 */
export function registerHumanTaskEvents(registry: EventRegistry): void {
  for (const eventType of HumanTaskEventTypeSchema.options) {
    registry.register(eventType, HumanTaskEventSchema, {
      version: '1.0.0',
      category: 'human_task',
      containsPII: true,
      description: 'Workflow human-task lifecycle event (event-sourced to ClickHouse).',
    });
  }
}
