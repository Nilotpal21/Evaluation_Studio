/**
 * Unit tests for `OutboxPoller.drain` (LLD §3.3).
 *
 * The BullMQ registration path is not exercised here — that requires a
 * live Redis. The pure draining logic is exercised by calling
 * `poller.drain(jobId)` directly against fake model + fake publisher
 * implementations (constructor DI).
 *
 * BullMQ Queue/Worker and createBullMQPair are stubbed so the constructor
 * can succeed without a live Redis connection. The drain logic itself uses
 * only deps.model and deps.kafkaQueue — no Redis path is exercised.
 *
 * Focus areas:
 *  - Happy path: publishes each row in order, stamps `publishedAt` +
 *    `expiresAt` on success.
 *  - Failure path: bumps `retryCount`, stores `lastError`, leaves
 *    `publishedAt: null` so the row is re-attempted on the next drain.
 *  - Empty batch: no-op when the unpublished query returns nothing.
 *  - TTL computation: `expiresAt` = `publishedAt + ttlHours`.
 *  - Publish key: the tenant id is forwarded as the Kafka partition key.
 */

import { describe, it, expect, vi } from 'vitest';

// Stub BullMQ so the OutboxPoller constructor does not require a live Redis.
vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn();
    close = vi.fn();
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn();
  },
}));

import { OutboxPoller, type OutboxPollModel, type PublishClient } from '../outbox-poller.js';
import type { WorkflowEventOutboxDoc } from '../workflow-event-outbox-writer.js';
import type {
  BullMQConnectionPair,
  RedisClient,
  RedisConnectionHandle,
} from '@agent-platform/redis';

function makeRow(
  overrides: Partial<WorkflowEventOutboxDoc> = {},
): WorkflowEventOutboxDoc & { _id: string } {
  return {
    _id: overrides._id ?? 'evt-1',
    tenantId: 't1',
    projectId: 'p1',
    entityKind: 'workflow_execution',
    entityId: 'exec-1',
    topic: 'abl.workflow.execution',
    eventType: 'workflow.execution.started',
    eventVersion: '1.0.0',
    occurredAt: new Date('2026-04-21T10:00:00Z'),
    payload: { event_id: 'evt-1' },
    publishedAt: null,
    lastError: null,
    retryCount: 0,
    expiresAt: null,
    ...overrides,
  };
}

function makeModelAndPublisher(
  rows: Array<WorkflowEventOutboxDoc & { _id: string }>,
  publishBehavior: 'success' | Error = 'success',
) {
  const updates: Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const publishes: Array<{ topic: string; event: unknown; key?: string }> = [];

  const model: OutboxPollModel = {
    find: vi.fn(() => ({
      sort: vi.fn(() => ({
        limit: vi.fn(() => ({
          lean: vi.fn(async () => rows),
        })),
      })),
    })),
    updateOne: vi.fn(async (filter, update) => {
      updates.push({ filter, update });
      return { acknowledged: true };
    }),
    countDocuments: vi.fn(async () => rows.filter((r) => r.publishedAt === null).length),
  };

  const publisher: PublishClient = {
    publishAndAck: vi.fn(async (topic, event, key) => {
      publishes.push({ topic, event, key });
      if (publishBehavior instanceof Error) throw publishBehavior;
    }),
  };

  return { model, publisher, updates, publishes };
}

function fakeHandle(): RedisConnectionHandle {
  return {
    client: {} as RedisConnectionHandle['client'],
    isReady: vi.fn(() => true),
    duplicate: vi.fn(() => ({}) as RedisConnectionHandle['client']),
    disconnect: vi.fn(async () => {}),
  } as unknown as RedisConnectionHandle;
}

function fakePair(): BullMQConnectionPair {
  return {
    queueConnection: { disconnect: vi.fn() } as unknown as RedisClient,
    workerConnection: { disconnect: vi.fn() } as unknown as RedisClient,
    disconnect: vi.fn(),
  };
}

describe('OutboxPoller.drain', () => {
  it('publishes each unpublished row and stamps publishedAt + expiresAt on success', async () => {
    const row = makeRow({ _id: 'evt-alpha', tenantId: 'tenant-7' });
    const { model, publisher, updates, publishes } = makeModelAndPublisher([row]);

    const poller = new OutboxPoller({
      handle: fakeHandle(),
      model,
      kafkaQueue: publisher,
      config: { batchSize: 10, pollIntervalMs: 500, ttlHours: 72 },
      createBullMQPairFn: fakePair,
    });

    const result = await poller.drain('job-1');

    expect(result).toEqual({ published: 1, failed: 0 });
    expect(publishes).toHaveLength(1);
    expect(publishes[0]!.topic).toBe('abl.workflow.execution');
    expect(publishes[0]!.key).toBe('tenant-7'); // tenant id is the partition key
    expect(publishes[0]!.event).toEqual(row.payload);

    expect(updates).toHaveLength(1);
    expect(updates[0]!.filter).toEqual({ _id: 'evt-alpha' });
    const set = updates[0]!.update.$set as { publishedAt: Date; expiresAt: Date };
    expect(set.publishedAt).toBeInstanceOf(Date);
    expect(set.expiresAt).toBeInstanceOf(Date);
    const deltaMs = set.expiresAt.getTime() - set.publishedAt.getTime();
    // 72h × 60m × 60s × 1000ms = 259_200_000
    expect(deltaMs).toBe(72 * 60 * 60 * 1000);

    await poller.shutdown();
  });

  it('on Kafka failure: bumps retryCount, stores lastError, leaves publishedAt null', async () => {
    const row = makeRow({ retryCount: 2 });
    const kafkaErr = new Error('broker unreachable');
    const { model, publisher, updates } = makeModelAndPublisher([row], kafkaErr);

    const poller = new OutboxPoller({
      handle: fakeHandle(),
      model,
      kafkaQueue: publisher,
      config: { batchSize: 10, pollIntervalMs: 500, ttlHours: 72 },
      createBullMQPairFn: fakePair,
    });

    const result = await poller.drain('job-2');

    expect(result).toEqual({ published: 0, failed: 1 });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.update).toEqual({
      $set: { lastError: 'broker unreachable' },
      $inc: { retryCount: 1 },
    });

    await poller.shutdown();
  });

  it('is a no-op when the unpublished query returns no rows', async () => {
    const { model, publisher, updates, publishes } = makeModelAndPublisher([]);

    const poller = new OutboxPoller({
      handle: fakeHandle(),
      model,
      kafkaQueue: publisher,
      createBullMQPairFn: fakePair,
    });

    const result = await poller.drain('job-empty');

    expect(result).toEqual({ published: 0, failed: 0 });
    expect(publishes).toHaveLength(0);
    expect(updates).toHaveLength(0);

    await poller.shutdown();
  });

  it('processes each row in the batch in order, advancing despite single-row failures', async () => {
    const rows = [
      makeRow({ _id: 'evt-1', tenantId: 't1' }),
      makeRow({ _id: 'evt-2', tenantId: 't2' }),
      makeRow({ _id: 'evt-3', tenantId: 't3' }),
    ];
    let callCount = 0;
    const { model, updates, publishes } = makeModelAndPublisher(rows, 'success');
    const failingPublisher: PublishClient = {
      publishAndAck: vi.fn(async (topic, event, key) => {
        callCount++;
        publishes.push({ topic, event, key });
        if (callCount === 2) {
          throw new Error('transient');
        }
      }),
    };

    const poller = new OutboxPoller({
      handle: fakeHandle(),
      model,
      kafkaQueue: failingPublisher,
      config: { batchSize: 10, pollIntervalMs: 500, ttlHours: 1 },
      createBullMQPairFn: fakePair,
    });

    const result = await poller.drain('job-mix');

    expect(result).toEqual({ published: 2, failed: 1 });
    expect(publishes).toHaveLength(3);
    expect(updates).toHaveLength(3);
    // Row 1: success — has $set.publishedAt; Row 2: failure — has $inc.retryCount; Row 3: success.
    expect((updates[0]!.update as Record<string, unknown>).$set).toHaveProperty('publishedAt');
    expect((updates[1]!.update as Record<string, unknown>).$inc).toEqual({ retryCount: 1 });
    expect((updates[2]!.update as Record<string, unknown>).$set).toHaveProperty('publishedAt');

    await poller.shutdown();
  });

  // Round-1 review follow-up: verify the `updateOne` try/catch wrappers
  // prevent a secondary Mongo failure from aborting the remaining rows
  // in the batch. The poller should log + continue.

  it('on success-path Mongo updateOne failure: counts the publish + continues to remaining rows', async () => {
    const rows = [
      makeRow({ _id: 'evt-bk-fail', tenantId: 't1' }),
      makeRow({ _id: 'evt-after', tenantId: 't2' }),
    ];
    const publishes: Array<{ topic: string; event: unknown; key?: string }> = [];
    let updateCallCount = 0;
    const model: OutboxPollModel = {
      find: vi.fn(() => ({
        sort: vi.fn(() => ({
          limit: vi.fn(() => ({ lean: vi.fn(async () => rows) })),
        })),
      })),
      updateOne: vi.fn(async () => {
        updateCallCount++;
        if (updateCallCount === 1) throw new Error('mongo hiccup');
        return { acknowledged: true };
      }),
      countDocuments: vi.fn(async () => 0),
    };
    const publisher: PublishClient = {
      publishAndAck: vi.fn(async (topic, event, key) => {
        publishes.push({ topic, event, key });
      }),
    };

    const poller = new OutboxPoller({
      handle: fakeHandle(),
      model,
      kafkaQueue: publisher,
      config: { batchSize: 10, pollIntervalMs: 500, ttlHours: 72 },
      createBullMQPairFn: fakePair,
    });

    const result = await poller.drain('job-bk-fail-success');

    // Kafka publish succeeded for both rows; the first row's bookkeeping
    // updateOne throws but the catch swallows it — second row still processes.
    expect(publishes).toHaveLength(2);
    expect(result.published).toBe(2);
    expect(result.failed).toBe(0);

    await poller.shutdown();
  });

  it('on failure-path Mongo updateOne failure: counts the row as failed + continues', async () => {
    const rows = [
      makeRow({ _id: 'evt-err-bk', tenantId: 't1' }),
      makeRow({ _id: 'evt-after-err', tenantId: 't2' }),
    ];
    const publishes: Array<{ topic: string; event: unknown; key?: string }> = [];
    let publishCallCount = 0;
    let updateCallCount = 0;
    const model: OutboxPollModel = {
      find: vi.fn(() => ({
        sort: vi.fn(() => ({
          limit: vi.fn(() => ({ lean: vi.fn(async () => rows) })),
        })),
      })),
      updateOne: vi.fn(async () => {
        updateCallCount++;
        // Throw on the FIRST row's error-path bookkeeping; succeed after.
        if (updateCallCount === 1) throw new Error('mongo hiccup during error bookkeeping');
        return { acknowledged: true };
      }),
      countDocuments: vi.fn(async () => 0),
    };
    const publisher: PublishClient = {
      publishAndAck: vi.fn(async (topic, event, key) => {
        publishCallCount++;
        publishes.push({ topic, event, key });
        // Row 1 publish fails → enters error path → updateOne throws → wrapped try/catch continues.
        if (publishCallCount === 1) throw new Error('kafka fail');
      }),
    };

    const poller = new OutboxPoller({
      handle: fakeHandle(),
      model,
      kafkaQueue: publisher,
      config: { batchSize: 10, pollIntervalMs: 500, ttlHours: 72 },
      createBullMQPairFn: fakePair,
    });

    const result = await poller.drain('job-bk-fail-error');

    // Row 1: publish failed, error-bookkeeping updateOne failed — still counted as failed.
    // Row 2: publish succeeded, bookkeeping updateOne succeeded.
    expect(result.failed).toBe(1);
    expect(result.published).toBe(1);
    expect(publishes).toHaveLength(2);

    await poller.shutdown();
  });
});
