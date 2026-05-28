/**
 * UT-01 (workflow variant) — Zod schema round-trip + FR-12 passthrough.
 *
 * Validates:
 * - Minimal required fields parse.
 * - Unknown fields survive the round trip (FR-12 forward compat via .passthrough()).
 * - `registerWorkflowExecutionEvents` registers one entry per event-type enum value.
 * - Each event_type validates under the same shared schema.
 */

import { describe, expect, it } from 'vitest';
import { EventRegistry } from '../../event-registry.js';
import {
  WorkflowExecutionEventSchema,
  WorkflowExecutionEventTypeSchema,
  registerWorkflowExecutionEvents,
} from '../workflow-execution-events.js';

describe('WorkflowExecutionEventSchema', () => {
  const baseEvent = {
    event_id: '0192abcd-0000-7000-8000-000000000001',
    event_type: 'workflow.execution.started' as const,
    occurred_at: '2026-04-21T10:00:00.000Z',
    tenant_id: 't1',
    project_id: 'p1',
    execution_id: 'exec-1',
    workflow_id: 'wf-1',
    workflow_version: 'v1',
    status: 'running',
    trigger_type: 'api',
  };

  it('parses a minimal valid event and applies defaults', () => {
    const parsed = WorkflowExecutionEventSchema.parse(baseEvent);
    expect(parsed.event_version).toBe('1.0.0');
    expect(parsed.event_type).toBe('workflow.execution.started');
  });

  it('preserves unknown fields (FR-12 passthrough)', () => {
    const withExtras = {
      ...baseEvent,
      future_field_from_v2: 'preserved-value',
      nested_extras: { level: 1, items: ['a', 'b'] },
    };
    const parsed = WorkflowExecutionEventSchema.parse(withExtras) as Record<string, unknown>;
    expect(parsed.future_field_from_v2).toBe('preserved-value');
    expect(parsed.nested_extras).toEqual({ level: 1, items: ['a', 'b'] });
  });

  it('round-trips JSON without loss', () => {
    const parsed = WorkflowExecutionEventSchema.parse(baseEvent);
    const roundTripped = WorkflowExecutionEventSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it('rejects invalid event_type', () => {
    expect(() =>
      WorkflowExecutionEventSchema.parse({ ...baseEvent, event_type: 'not.a.real.event' }),
    ).toThrow();
  });

  it('rejects empty required IDs', () => {
    expect(() => WorkflowExecutionEventSchema.parse({ ...baseEvent, tenant_id: '' })).toThrow();
  });

  it('accepts step-scoped fields on step events', () => {
    const stepEvent = {
      ...baseEvent,
      event_type: 'workflow.execution.step_started' as const,
      step_id: 'step-1',
      step_name: 'Approval',
      step_type: 'approval',
    };
    const parsed = WorkflowExecutionEventSchema.parse(stepEvent);
    expect(parsed.step_id).toBe('step-1');
  });
});

describe('registerWorkflowExecutionEvents', () => {
  it('registers every event_type enum value (no wildcards)', () => {
    const registry = new EventRegistry();
    registerWorkflowExecutionEvents(registry);

    const registered = registry.getEventTypes().sort();
    const expected = [...WorkflowExecutionEventTypeSchema.options].sort();
    expect(registered).toEqual(expected);
  });

  it('marks every workflow event as containing PII (for GDPR scrubbing)', () => {
    const registry = new EventRegistry();
    registerWorkflowExecutionEvents(registry);

    const pii = registry.getPIIEventTypes().sort();
    const expected = [...WorkflowExecutionEventTypeSchema.options].sort();
    expect(pii).toEqual(expected);
  });

  it('uses the workflow category for all entries', () => {
    const registry = new EventRegistry();
    registerWorkflowExecutionEvents(registry);

    for (const eventType of WorkflowExecutionEventTypeSchema.options) {
      expect(registry.getMetadata(eventType)?.category).toBe('workflow');
    }
  });
});
