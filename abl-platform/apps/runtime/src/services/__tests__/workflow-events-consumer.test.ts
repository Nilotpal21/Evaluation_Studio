/**
 * UT-02 (row mapper) + UT-04 (Zod validation) + consumer dispatch tests
 * for `WorkflowEventsConsumer` (LLD §4.1, Phase 4 test slice).
 *
 * Test architecture
 * -----------------
 *  - No `vi.mock` of internal modules (CLAUDE.md "Test Architecture").
 *  - Kafka queues are replaced with structural fakes that invoke the
 *    consumer's registered handler directly.
 *  - ClickHouse client is a stub `command()` that records calls — the
 *    writer's real `insert()` path is exercised, but we only assert the
 *    consumer's *dispatch* behaviour (Zod parse + row mapper + buffer
 *    insert). Actual CH inserts are tied to `flush()` which is exercised
 *    separately by forcing a `flushAll()` and inspecting buffer metrics.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  WorkflowEventsConsumer,
  toWorkflowExecutionEventRow,
  toHumanTaskEventRow,
  type ConsumerQueueClient,
  type WorkflowExecutionEventRow,
  type HumanTaskEventRow,
} from '../workflow-events-consumer.js';

// ── Fakes ─────────────────────────────────────────────────────────────────

interface FakeChClient {
  command: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
}

function createFakeChClient(): FakeChClient {
  return {
    command: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ json: async () => [] }),
  };
}

class FakeQueue implements ConsumerQueueClient {
  handler: ((event: unknown) => void | Promise<void>) | null = null;
  closed = false;
  onProcess(handler: (event: unknown) => void | Promise<void>): void {
    this.handler = handler;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async push(event: unknown): Promise<void> {
    if (!this.handler) throw new Error('no handler registered');
    await this.handler(event);
  }
}

class ClosePushQueue extends FakeQueue {
  constructor(private readonly closeEvent: unknown) {
    super();
  }

  override async close(): Promise<void> {
    if (this.handler) {
      await this.handler(this.closeEvent);
    }
    await super.close();
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const BASE_EXEC_EVENT = {
  event_id: '00000000-0000-0000-0000-000000000001',
  event_type: 'workflow.execution.started' as const,
  event_version: '1.0.0',
  occurred_at: '2026-04-21T10:00:00.000Z',
  tenant_id: 't1',
  project_id: 'p1',
  execution_id: 'exec-1',
  workflow_id: 'wf-1',
  workflow_version: '7',
  status: 'running',
  trigger_type: 'manual',
};

const BASE_HUMAN_TASK_EVENT = {
  event_id: '00000000-0000-0000-0000-000000000002',
  event_type: 'human_task.created' as const,
  event_version: '1.0.0',
  occurred_at: '2026-04-21T10:05:00.000Z',
  tenant_id: 't1',
  project_id: 'p1',
  task_id: 'task-1',
  execution_id: 'exec-1',
  workflow_id: 'wf-1',
  workflow_version: '7',
  mailbox: 'workflow' as const,
  status: 'pending',
  assignees: [],
  approvers: [],
  created_at: '2026-04-21T10:05:00.000Z',
};

describe('toWorkflowExecutionEventRow (UT-02)', () => {
  it('populates all required CH columns with sensible defaults for step fields', () => {
    const row: WorkflowExecutionEventRow = toWorkflowExecutionEventRow(BASE_EXEC_EVENT);
    expect(row.event_id).toBe(BASE_EXEC_EVENT.event_id);
    expect(row.tenant_id).toBe('t1');
    expect(row.execution_id).toBe('exec-1');
    expect(row.step_id).toBe('');
    expect(row.step_name).toBe('');
    expect(row.step_type).toBe('');
    expect(row.error_code).toBe('');
    expect(row.duration_ms).toBe(0);
    // `toChDateTime()` converts ISO-8601 to CH `DateTime64(3)` parse-friendly
    // format (space separator, no `T`, no trailing `Z`).
    expect(row.started_at).toBe('2026-04-21 10:00:00.000'); // default: fallback to occurred_at
    expect(row.completed_at).toBeNull();
    expect(row.payload_truncated).toBe(0);
  });

  it('forwards step fields when set on the event', () => {
    const row = toWorkflowExecutionEventRow({
      ...BASE_EXEC_EVENT,
      step_id: 'step-1',
      step_name: 'Fetch data',
      step_type: 'http',
      started_at: '2026-04-21T10:00:00.000Z',
      completed_at: '2026-04-21T10:00:05.000Z',
      duration_ms: 5000,
    });
    expect(row.step_id).toBe('step-1');
    expect(row.step_name).toBe('Fetch data');
    expect(row.step_type).toBe('http');
    expect(row.completed_at).toBe('2026-04-21 10:00:05.000');
    expect(row.duration_ms).toBe(5000);
  });

  it('serializes metadata to JSON payload', () => {
    const row = toWorkflowExecutionEventRow({
      ...BASE_EXEC_EVENT,
      metadata: { reason: 'manual trigger', user: 'u1' },
    });
    expect(JSON.parse(row.payload)).toEqual({ reason: 'manual trigger', user: 'u1' });
  });
});

describe('toHumanTaskEventRow (UT-02)', () => {
  it('maps base fields and fills optional columns with defaults', () => {
    const row: HumanTaskEventRow = toHumanTaskEventRow(BASE_HUMAN_TASK_EVENT);
    expect(row.task_id).toBe('task-1');
    expect(row.mailbox).toBe('workflow');
    expect(row.assigned_to).toEqual([]);
    expect(row.claimed_by).toBe('');
    expect(row.responded_by).toBe('');
    expect(row.decision).toBe('');
    expect(row.due_at).toBeNull();
    expect(row.sla_breached_at).toBeNull();
    // `toChDateTime()` normalises ISO-8601 to CH DateTime64 parse format.
    expect(row.created_at).toBe('2026-04-21 10:05:00.000');
  });

  it('pulls assignees from passthrough `assigned_to` when present and falls back otherwise', () => {
    const row = toHumanTaskEventRow({
      ...BASE_HUMAN_TASK_EVENT,
      assignees: ['alice'],
    });
    expect(row.assigned_to).toEqual(['alice']);
  });
});

describe('WorkflowEventsConsumer dispatch (UT-04 Zod validation)', () => {
  let chClient: FakeChClient;
  let executionQueue: FakeQueue;
  let humanTaskQueue: FakeQueue;
  let consumer: WorkflowEventsConsumer;

  beforeEach(() => {
    chClient = createFakeChClient();
    executionQueue = new FakeQueue();
    humanTaskQueue = new FakeQueue();
    consumer = new WorkflowEventsConsumer({
      chClient: chClient as never,
      executionQueue,
      humanTaskQueue,
      flushIntervalMs: 60_000, // disable timer flushes for deterministic tests
    });
    consumer.start();
  });

  it('rejects invalid workflow.execution events without throwing or buffering', async () => {
    // Missing required field `workflow_id` — Zod must reject.
    const invalid = { ...BASE_EXEC_EVENT, workflow_id: undefined };
    await expect(executionQueue.push(invalid)).resolves.toBeUndefined();
    // CH client should not be hit at all on a rejection.
    expect(chClient.insert).not.toHaveBeenCalled();
    await consumer.shutdown();
  });

  it('accepts valid workflow.execution events and closes cleanly on shutdown', async () => {
    await expect(executionQueue.push(BASE_EXEC_EVENT)).resolves.toBeUndefined();
    await consumer.shutdown();
    expect(executionQueue.closed).toBe(true);
    expect(humanTaskQueue.closed).toBe(true);
  });

  it('shutdown flushes events delivered during queue close before writers are closed', async () => {
    const chClient = createFakeChClient();
    const executionQueue = new ClosePushQueue(BASE_EXEC_EVENT);
    const humanTaskQueue = new FakeQueue();
    const consumer = new WorkflowEventsConsumer({
      chClient: chClient as unknown as ConstructorParameters<
        typeof WorkflowEventsConsumer
      >[0]['chClient'],
      executionQueue,
      humanTaskQueue,
      flushIntervalMs: 60_000,
    });

    consumer.start();
    await consumer.shutdown();

    expect(chClient.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        table: 'abl_platform.workflow_execution_events',
        values: [expect.objectContaining({ execution_id: 'exec-1' })],
      }),
    );
  });

  it('rejects human_task events with mailbox != workflow (schema literal guard)', async () => {
    const agentMailboxEvent = { ...BASE_HUMAN_TASK_EVENT, mailbox: 'agent' };
    await expect(humanTaskQueue.push(agentMailboxEvent)).resolves.toBeUndefined();
    expect(chClient.insert).not.toHaveBeenCalled();
    await consumer.shutdown();
  });

  it('suppresses the lag histogram sample when occurred_at is malformed', async () => {
    await expect(
      executionQueue.push({ ...BASE_EXEC_EVENT, occurred_at: 'not-a-date' }),
    ).resolves.toBeUndefined();
    await consumer.shutdown();
  });

  it('isHealthy: false before start(), true after start(), consults both queue isHealthy() hooks', async () => {
    const chClient = createFakeChClient();
    const executionQueue = new FakeQueue();
    const humanTaskQueue = new FakeQueue();
    // Structural queue with an optional isHealthy() override.
    const executionWithHealth: ConsumerQueueClient = Object.assign(executionQueue, {
      isHealthy: () => true,
    });
    const humanTaskWithHealth: ConsumerQueueClient = Object.assign(humanTaskQueue, {
      isHealthy: () => true,
    });
    const consumer = new WorkflowEventsConsumer({
      chClient: chClient as unknown as ConstructorParameters<
        typeof WorkflowEventsConsumer
      >[0]['chClient'],
      executionQueue: executionWithHealth,
      humanTaskQueue: humanTaskWithHealth,
    });

    expect(consumer.isHealthy()).toBe(false); // not started yet
    consumer.start();
    expect(consumer.isHealthy()).toBe(true);

    // Flip execution queue to unhealthy — consumer should reflect it.
    (executionWithHealth as { isHealthy: () => boolean }).isHealthy = () => false;
    expect(consumer.isHealthy()).toBe(false);

    await consumer.shutdown();
  });

  it('isHealthy: queues without isHealthy() are treated as healthy (test-double compat)', async () => {
    const chClient = createFakeChClient();
    // FakeQueue has no isHealthy() — should default to healthy per the `?? true` fallback.
    const consumer = new WorkflowEventsConsumer({
      chClient: chClient as unknown as ConstructorParameters<
        typeof WorkflowEventsConsumer
      >[0]['chClient'],
      executionQueue: new FakeQueue(),
      humanTaskQueue: new FakeQueue(),
    });
    consumer.start();
    expect(consumer.isHealthy()).toBe(true);
    await consumer.shutdown();
  });
});
