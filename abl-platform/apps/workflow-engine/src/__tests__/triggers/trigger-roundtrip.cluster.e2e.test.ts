/**
 * E2E-WIRE-1 — Workflow Engine BullMQ Pair Round-Trip on Cluster
 *
 * Verifies that the Workflow Engine's BullMQ connections (constructed via
 * `createBullMQPair(handle)` from `@agent-platform/redis`) work correctly
 * against a real Redis Cluster:
 *
 *   - Queue connection can enqueue jobs without CROSSSLOT errors
 *   - Worker connection can dequeue and process jobs
 *   - `disconnect()` cleanly tears down both connections
 *   - BullMQ hash-slot co-location: `bull:{<queueName>}:*` keys all land on
 *     the same slot because BullMQ internally uses braces in its key names
 *
 * Per the test spec (INT-3 deferred): full BullMQ failover survival
 * (enqueue → failover → continue → assert all processed) is a separate
 * dedicated chaos scenario requiring longer timeouts and container control.
 * This suite verifies the happy path and wiring.
 *
 * Picked up by `pnpm test:cluster` via `vitest.cluster.config.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Queue, Worker, type Job } from 'bullmq';
import { ClusterTestHarness } from '../../../../../tools/cluster-test-harness.js';
import {
  BULLMQ_CLUSTER_SAFE_PREFIX,
  createBullMQPair,
  createRedisConnection,
  type RedisConnectionHandle,
} from '@agent-platform/redis';

const harness = new ClusterTestHarness();
let handle: RedisConnectionHandle;

beforeAll(async () => {
  await harness.boot();
  handle = createRedisConnection({
    cluster: true,
    url: harness.getUrl(),
    lazyConnect: false,
  });
  for (let i = 0; i < 60; i++) {
    if (handle.isReady()) break;
    await new Promise((r) => setTimeout(r, 250));
  }
}, 60_000);

beforeEach(async () => {
  await harness.flushAllMasters();
});

afterAll(async () => {
  await handle.disconnect();
}, 30_000);

// ---------------------------------------------------------------------------
// E2E-WIRE-1: BullMQ pair on cluster — enqueue + process
// ---------------------------------------------------------------------------

describe('E2E-WIRE-1 · BullMQ pair round-trip on cluster', () => {
  it('enqueues 10 jobs and Worker processes all within 15s', async () => {
    const pair = createBullMQPair(handle);
    const queueName = `we-trigger-${Date.now()}`;

    const processed: string[] = [];
    let resolveAll: () => void;
    const allDone = new Promise<void>((r) => (resolveAll = r));

    const worker = new Worker(
      queueName,
      async (job: Job) => {
        processed.push(job.data.id as string);
        if (processed.length === 10) resolveAll();
        return { ok: true };
      },
      { connection: pair.workerConnection, prefix: BULLMQ_CLUSTER_SAFE_PREFIX },
    );

    const queue = new Queue(queueName, {
      connection: pair.queueConnection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    });

    try {
      // Enqueue 10 jobs.
      const jobs = Array.from({ length: 10 }, (_, i) => ({
        name: 'trigger',
        data: { id: `job-${i}`, workflowId: 'wf-1', projectId: 'p1', tenantId: 't1' },
      }));
      await queue.addBulk(jobs);

      // Wait for all to be processed.
      await Promise.race([
        allDone,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Timeout: Worker did not process all 10 jobs in 15s')),
            15_000,
          ),
        ),
      ]);

      expect(processed).toHaveLength(10);
      // Each job ID must appear exactly once.
      const unique = new Set(processed);
      expect(unique.size).toBe(10);
    } finally {
      await worker.close();
      await queue.close();
      pair.disconnect();
    }
  }, 30_000);

  it('disconnect() tears down both connections without hanging', async () => {
    const pair = createBullMQPair(handle);

    // Sanity-check that connections are live before disconnect.
    const queueName = `we-disc-${Date.now()}`;
    await pair.queueConnection.set(`{${queueName}}:probe`, '1', 'EX', 10);

    // Disconnect must resolve promptly.
    const start = Date.now();
    pair.disconnect();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5_000);
  }, 30_000);

  it('second BullMQ pair from same handle is independent (queue isolation)', async () => {
    const pair1 = createBullMQPair(handle);
    const pair2 = createBullMQPair(handle);

    const q1Name = `we-iso1-${Date.now()}`;
    const q2Name = `we-iso2-${Date.now()}`;

    const q1Processed: string[] = [];
    const q2Processed: string[] = [];
    let resolveQ1: () => void;
    let resolveQ2: () => void;
    const q1Done = new Promise<void>((r) => (resolveQ1 = r));
    const q2Done = new Promise<void>((r) => (resolveQ2 = r));

    const w1 = new Worker(
      q1Name,
      async (job: Job) => {
        q1Processed.push(job.data.queueId as string);
        if (q1Processed.length === 5) resolveQ1();
      },
      { connection: pair1.workerConnection, prefix: BULLMQ_CLUSTER_SAFE_PREFIX },
    );
    const w2 = new Worker(
      q2Name,
      async (job: Job) => {
        q2Processed.push(job.data.queueId as string);
        if (q2Processed.length === 5) resolveQ2();
      },
      { connection: pair2.workerConnection, prefix: BULLMQ_CLUSTER_SAFE_PREFIX },
    );

    const queue1 = new Queue(q1Name, {
      connection: pair1.queueConnection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    });
    const queue2 = new Queue(q2Name, {
      connection: pair2.queueConnection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    });

    try {
      const jobs1 = Array.from({ length: 5 }, (_, i) => ({
        name: 'j',
        data: { queueId: `q1-job-${i}` },
      }));
      const jobs2 = Array.from({ length: 5 }, (_, i) => ({
        name: 'j',
        data: { queueId: `q2-job-${i}` },
      }));

      await Promise.all([queue1.addBulk(jobs1), queue2.addBulk(jobs2)]);

      const timeout = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout: queue isolation test')), 15_000),
      );
      await Promise.race([Promise.all([q1Done, q2Done]), timeout]);

      expect(q1Processed).toHaveLength(5);
      expect(q2Processed).toHaveLength(5);

      // No cross-contamination.
      for (const id of q1Processed) {
        expect(id.startsWith('q1-job-')).toBe(true);
      }
      for (const id of q2Processed) {
        expect(id.startsWith('q2-job-')).toBe(true);
      }
    } finally {
      await Promise.all([w1.close(), w2.close(), queue1.close(), queue2.close()]);
      pair1.disconnect();
      pair2.disconnect();
    }
  }, 30_000);

  it('queueConnection and workerConnection survive a brief delay between create and use', async () => {
    const pair = createBullMQPair(handle);
    const queueName = `we-delay-${Date.now()}`;

    // Wait 2s before using — simulates WE startup sequence.
    await new Promise((r) => setTimeout(r, 2_000));

    const processed: string[] = [];
    let resolveDone: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));

    const worker = new Worker(
      queueName,
      async (job: Job) => {
        processed.push(job.data.id as string);
        if (processed.length === 3) resolveDone();
      },
      { connection: pair.workerConnection, prefix: BULLMQ_CLUSTER_SAFE_PREFIX },
    );
    const queue = new Queue(queueName, {
      connection: pair.queueConnection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    });

    try {
      await queue.addBulk([
        { name: 't', data: { id: 'a' } },
        { name: 't', data: { id: 'b' } },
        { name: 't', data: { id: 'c' } },
      ]);

      await Promise.race([
        done,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10_000)),
      ]);

      expect(processed).toHaveLength(3);
    } finally {
      await worker.close();
      await queue.close();
      pair.disconnect();
    }
  }, 30_000);
});
