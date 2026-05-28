/**
 * UT-01 (human-task variant) — Zod schema round-trip + FR-12 passthrough
 * + `mailbox` literal enforcement.
 */

import { describe, expect, it } from 'vitest';
import { EventRegistry } from '../../event-registry.js';
import {
  HumanTaskEventSchema,
  HumanTaskEventTypeSchema,
  registerHumanTaskEvents,
} from '../human-task-events.js';

describe('HumanTaskEventSchema', () => {
  const baseEvent = {
    event_id: '0192abcd-0000-7000-8000-000000000002',
    event_type: 'human_task.created' as const,
    occurred_at: '2026-04-21T10:00:00.000Z',
    tenant_id: 't1',
    project_id: 'p1',
    task_id: 'task-1',
    execution_id: 'exec-1',
    workflow_id: 'wf-1',
    workflow_version: 'v1',
    mailbox: 'workflow' as const,
    status: 'pending',
  };

  it('parses a minimal valid event and applies array defaults', () => {
    const parsed = HumanTaskEventSchema.parse(baseEvent);
    expect(parsed.event_version).toBe('1.0.0');
    expect(parsed.assignees).toEqual([]);
    expect(parsed.approvers).toEqual([]);
  });

  it('preserves unknown fields (FR-12 passthrough)', () => {
    const withExtras = {
      ...baseEvent,
      future_field_from_v2: 'keep-me',
      sla_budget_ms: 300000,
    };
    const parsed = HumanTaskEventSchema.parse(withExtras) as Record<string, unknown>;
    expect(parsed.future_field_from_v2).toBe('keep-me');
    expect(parsed.sla_budget_ms).toBe(300000);
  });

  it('round-trips JSON without loss', () => {
    const parsed = HumanTaskEventSchema.parse({
      ...baseEvent,
      assignees: ['u1', 'u2'],
      payload: { form_fields: [{ id: 'name', value: 'Alice' }] },
    });
    const roundTripped = HumanTaskEventSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it('rejects mailbox other than "workflow" (agent mailbox out of scope)', () => {
    expect(() =>
      HumanTaskEventSchema.parse({
        ...baseEvent,
        // @ts-expect-error — deliberately invalid literal to prove scope guard.
        mailbox: 'agent',
      }),
    ).toThrow();
  });

  it('rejects invalid event_type', () => {
    expect(() =>
      HumanTaskEventSchema.parse({ ...baseEvent, event_type: 'human_task.unknown' }),
    ).toThrow();
  });

  it('rejects empty required IDs', () => {
    expect(() => HumanTaskEventSchema.parse({ ...baseEvent, task_id: '' })).toThrow();
  });
});

describe('registerHumanTaskEvents', () => {
  it('registers every event_type enum value', () => {
    const registry = new EventRegistry();
    registerHumanTaskEvents(registry);

    const registered = registry.getEventTypes().sort();
    const expected = [...HumanTaskEventTypeSchema.options].sort();
    expect(registered).toEqual(expected);
  });

  it('marks every human-task event as containing PII (for GDPR scrubbing)', () => {
    const registry = new EventRegistry();
    registerHumanTaskEvents(registry);

    const pii = registry.getPIIEventTypes().sort();
    const expected = [...HumanTaskEventTypeSchema.options].sort();
    expect(pii).toEqual(expected);
  });
});
