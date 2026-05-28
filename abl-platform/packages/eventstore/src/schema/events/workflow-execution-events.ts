/**
 * Workflow execution event schemas.
 *
 * Deliberate divergence from the other event schema files in this directory:
 * most of them register with the global `eventRegistry` as a module-level
 * side effect. This file exposes an explicit `registerWorkflowExecutionEvents(
 * registry)` function instead. Reasons:
 *
 * 1. These workflow events are flat objects, not `PlatformEvent.data`
 *    envelopes. The Kafka consumer validates with Zod directly, bypassing
 *    `EventRegistry.validate()` which parses the `data` field.
 * 2. The registry entry is retained only for GDPR/PII metadata lookup
 *    (`getPIIEventTypes`). Explicit registration keeps the call site
 *    obvious (wired in `apps/runtime/src/services/eventstore-singleton.ts`)
 *    rather than hidden inside a barrel-import side effect.
 *
 * Event type list is driven by the Zod enum — `registerWorkflowExecution
 * Events` loops over `.options` so adding a new event type is a single-line
 * change. `EventRegistry.register()` stores schemas in a `Map<string, ZodSchema>`
 * with no wildcard resolution (see `event-registry.ts:43`), so a wildcard
 * like `workflow.execution.*` would register a literal never-matching key.
 */

import { z } from 'zod';
import { EventRegistry } from '../event-registry.js';

export const WorkflowExecutionEventTypeSchema = z.enum([
  'workflow.execution.started',
  'workflow.execution.step_started',
  'workflow.execution.step_completed',
  'workflow.execution.completed',
  'workflow.execution.failed',
  'workflow.execution.cancelled',
]);
export type WorkflowExecutionEventType = z.infer<typeof WorkflowExecutionEventTypeSchema>;

export const WorkflowExecutionEventSchema = z
  .object({
    event_id: z.string().min(1), // UUIDv7
    event_type: WorkflowExecutionEventTypeSchema,
    event_version: z.string().default('1.0.0'),
    occurred_at: z.string(), // ISO-8601; serialized to DateTime64(3,'UTC') on the CH side
    tenant_id: z.string().min(1),
    project_id: z.string().min(1),
    execution_id: z.string().min(1),
    workflow_id: z.string().min(1),
    workflow_version: z.string().min(1),
    status: z.string().min(1),
    trigger_type: z.string().min(1),
    // Step-scoped fields — populated on step_started / step_completed only.
    step_id: z.string().nullable().optional(),
    step_name: z.string().nullable().optional(),
    step_type: z.string().nullable().optional(),
    // Cumulative state — carried in every event for per-row MV projection (HLD §5.3 errata E-4).
    started_at: z.string().nullable().optional(),
    completed_at: z.string().nullable().optional(),
    duration_ms: z.number().int().nullable().optional(),
    error_code: z.string().nullable().optional(),
    error_message: z.string().nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough(); // FR-12: forward-compatible — unknown fields are preserved.

export type WorkflowExecutionEvent = z.infer<typeof WorkflowExecutionEventSchema>;

/**
 * Registers one entry per event type with the supplied registry.
 *
 * The registry keeps these entries for GDPR scrubbing (`getPIIEventTypes`).
 * Validation at the consumer boundary uses `WorkflowExecutionEventSchema`
 * directly, not `registry.validate()`.
 */
export function registerWorkflowExecutionEvents(registry: EventRegistry): void {
  for (const eventType of WorkflowExecutionEventTypeSchema.options) {
    registry.register(eventType, WorkflowExecutionEventSchema, {
      version: '1.0.0',
      category: 'workflow',
      containsPII: true,
      description: 'Workflow execution lifecycle event (event-sourced to ClickHouse).',
    });
  }
}
