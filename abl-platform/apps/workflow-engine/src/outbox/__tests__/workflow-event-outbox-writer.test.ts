/**
 * Unit tests for `workflow-event-outbox-writer.ts`.
 *
 * Scope:
 *  - `buildOutboxPayload` is pure — exercised directly with sample events.
 *  - `WorkflowEventOutboxWriter.writeWithSession` is exercised with a
 *    hand-rolled fake `insertMany` implementation (no Mongoose, no Mongo).
 *    The writer only forwards docs + the session option, so the fake
 *    captures the arguments and asserts on them.
 *
 * Deliberately NO `vi.mock` of internal packages (platform-mock-lint
 * forbids it). The `OutboxModelLike` interface exists specifically so
 * this test can inject a fake via constructor DI.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildOutboxPayload,
  WorkflowEventOutboxWriter,
  WORKFLOW_EXECUTION_TOPIC,
  HUMAN_TASK_TOPIC,
  type OutboxModelLike,
  type WorkflowEventOutboxDoc,
} from '../workflow-event-outbox-writer.js';
import type { WorkflowExecutionEvent, HumanTaskEvent } from '@abl/eventstore/schema';

function makeWorkflowEvent(
  overrides: Partial<WorkflowExecutionEvent> = {},
): WorkflowExecutionEvent {
  return {
    event_id: '0199be02-4e4f-7000-8000-000000000001',
    event_type: 'workflow.execution.started',
    event_version: '1.0.0',
    occurred_at: '2026-04-21T10:00:00.000Z',
    tenant_id: 't1',
    project_id: 'p1',
    execution_id: 'exec-1',
    workflow_id: 'wf-1',
    workflow_version: '1',
    status: 'running',
    trigger_type: 'manual',
    ...overrides,
  } as WorkflowExecutionEvent;
}

function makeHumanTaskEvent(overrides: Partial<HumanTaskEvent> = {}): HumanTaskEvent {
  return {
    event_id: '0199be02-4e4f-7000-8000-000000000002',
    event_type: 'human_task.created',
    event_version: '1.0.0',
    occurred_at: '2026-04-21T10:00:05.000Z',
    tenant_id: 't1',
    project_id: 'p1',
    task_id: 'task-1',
    execution_id: 'exec-1',
    workflow_id: 'wf-1',
    workflow_version: '1',
    mailbox: 'workflow',
    status: 'pending',
    assignees: [],
    approvers: [],
    ...overrides,
  } as HumanTaskEvent;
}

describe('buildOutboxPayload', () => {
  it('maps a workflow execution event onto the workflow topic with execution_id as entityId', () => {
    const event = makeWorkflowEvent();
    const doc = buildOutboxPayload({ entityKind: 'workflow_execution', event });

    expect(doc._id).toBe(event.event_id);
    expect(doc.tenantId).toBe('t1');
    expect(doc.projectId).toBe('p1');
    expect(doc.entityKind).toBe('workflow_execution');
    expect(doc.entityId).toBe('exec-1');
    expect(doc.topic).toBe(WORKFLOW_EXECUTION_TOPIC);
    expect(doc.eventType).toBe('workflow.execution.started');
    expect(doc.eventVersion).toBe('1.0.0');
    expect(doc.occurredAt).toBeInstanceOf(Date);
    expect(doc.occurredAt.toISOString()).toBe('2026-04-21T10:00:00.000Z');
    expect(doc.publishedAt).toBeNull();
    expect(doc.lastError).toBeNull();
    expect(doc.retryCount).toBe(0);
    expect(doc.expiresAt).toBeNull();
  });

  it('maps a human-task event onto the human-task topic with task_id as entityId', () => {
    const event = makeHumanTaskEvent();
    const doc = buildOutboxPayload({ entityKind: 'human_task', event });

    expect(doc.entityKind).toBe('human_task');
    expect(doc.entityId).toBe('task-1');
    expect(doc.topic).toBe(HUMAN_TASK_TOPIC);
    expect(doc.eventType).toBe('human_task.created');
  });

  it('preserves the full event in the payload field verbatim (poller forwards without re-shaping)', () => {
    const event = makeWorkflowEvent({
      metadata: { custom: 'nested-value', count: 42 },
    });
    const doc = buildOutboxPayload({ entityKind: 'workflow_execution', event });

    expect(doc.payload).toEqual(event);
    expect((doc.payload as WorkflowExecutionEvent).metadata).toEqual({
      custom: 'nested-value',
      count: 42,
    });
  });

  it('falls back to event_version "1.0.0" when absent (Zod default already runs upstream, but defensive)', () => {
    const event = { ...makeWorkflowEvent(), event_version: undefined as unknown as string };
    const doc = buildOutboxPayload({ entityKind: 'workflow_execution', event });
    expect(doc.eventVersion).toBe('1.0.0');
  });

  it('throws when occurred_at is not a valid ISO-8601 datetime', () => {
    const event = makeWorkflowEvent({ occurred_at: 'not-a-date' });
    expect(() => buildOutboxPayload({ entityKind: 'workflow_execution', event })).toThrow(
      /occurred_at.*not a valid ISO-8601/,
    );
  });
});

describe('WorkflowEventOutboxWriter.writeWithSession', () => {
  const insertManyCalls: Array<{
    docs: WorkflowEventOutboxDoc[];
    options: { session?: unknown } | undefined;
  }> = [];

  function newFakeModel(): OutboxModelLike {
    insertManyCalls.length = 0;
    return {
      insertMany: vi.fn(async (docs: WorkflowEventOutboxDoc[], options) => {
        insertManyCalls.push({ docs, options });
        return docs;
      }),
    };
  }

  it('forwards docs + session to the underlying model', async () => {
    const fake = newFakeModel();
    const writer = new WorkflowEventOutboxWriter(fake);
    const fakeSession = { id: 'session-handle' } as unknown as import('mongoose').ClientSession;
    const doc = buildOutboxPayload({
      entityKind: 'workflow_execution',
      event: makeWorkflowEvent(),
    });

    await writer.writeWithSession([doc], fakeSession);

    expect(insertManyCalls).toHaveLength(1);
    expect(insertManyCalls[0]!.docs).toEqual([doc]);
    expect(insertManyCalls[0]!.options).toEqual({ session: fakeSession });
  });

  it('omits the options object entirely when session is null (standalone-Mongo fallback)', async () => {
    const fake = newFakeModel();
    const writer = new WorkflowEventOutboxWriter(fake);
    const doc = buildOutboxPayload({
      entityKind: 'human_task',
      event: makeHumanTaskEvent(),
    });

    await writer.writeWithSession([doc], null);

    expect(insertManyCalls).toHaveLength(1);
    expect(insertManyCalls[0]!.options).toBeUndefined();
  });

  it('is a no-op when the docs array is empty (avoids a zero-doc insertMany call)', async () => {
    const fake = newFakeModel();
    const writer = new WorkflowEventOutboxWriter(fake);

    await writer.writeWithSession([], null);

    expect(insertManyCalls).toHaveLength(0);
    expect(fake.insertMany).not.toHaveBeenCalled();
  });

  it('propagates insertMany errors so the caller can abort the enclosing transaction', async () => {
    const error = new Error('duplicate _id');
    const fake: OutboxModelLike = {
      insertMany: vi.fn(async () => {
        throw error;
      }),
    };
    const writer = new WorkflowEventOutboxWriter(fake);
    const doc = buildOutboxPayload({
      entityKind: 'workflow_execution',
      event: makeWorkflowEvent(),
    });

    await expect(writer.writeWithSession([doc], null)).rejects.toBe(error);
  });
});
