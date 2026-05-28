/**
 * Outbox poller (LLD §3.3 + §3.5 + §3.7).
 *
 * Drains `workflow_event_outbox` rows into Kafka via
 * `KafkaEventQueue.publishAndAck`. Driven by a BullMQ repeatable job so
 * only one replica drains at a time (single-active-job leader election
 * — the same blueprint the TriggerScheduler uses at
 * `apps/workflow-engine/src/services/trigger-scheduler.ts`).
 *
 * Responsibilities
 * ----------------
 *  1. Register a repeatable BullMQ job (`every: pollIntervalMs`, fixed
 *     `jobId` so only one is scheduled across all replicas).
 *  2. On each fire, claim up to `batchSize` unpublished rows ordered by
 *     `occurredAt` ascending. Publish each row through `publishAndAck`.
 *     On success, stamp `publishedAt` + `expiresAt`. On failure, bump
 *     `retryCount`, store `lastError`, leave `publishedAt: null`.
 *  3. Emit the workflow.outbox.published / workflow.consumer.flush_failed
 *     structured log events and the OTel metrics defined in
 *     `metrics.ts` (latency histogram, failure counter).
 *  4. Install an observable-gauge provider that counts unpublished rows
 *     so external Prometheus scrapes see the backlog (LLD §5.2 rollout).
 *
 * Safety constraints
 * ------------------
 *  - Concurrency 1 — the job handler is safe to run serially; raising
 *    concurrency would risk re-publishing rows that one worker has read
 *    but not yet marked `publishedAt`.
 *  - `removeOnComplete` / `removeOnFail` configured to cap Redis memory
 *    growth per BullMQ best practice and the TriggerScheduler
 *    precedent.
 *  - `shutdown()` closes the worker, the queue, and both duplicated
 *    Redis connections — mirrors `trigger-scheduler.ts:168-176`.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { createBullMQPair, BULLMQ_CLUSTER_SAFE_PREFIX } from '@agent-platform/redis';
import type {
  BullMQConnectionPair,
  RedisConnectionHandle,
  RedisClient,
} from '@agent-platform/redis';
import { createLogger } from '@abl/compiler/platform';
import type { WorkflowEventOutboxDoc } from './workflow-event-outbox-writer.js';
import {
  recordPublishFailure,
  recordPublishLatency,
  recordPublishSuccess,
  setUnpublishedRowsProvider,
} from './metrics.js';

export const DEFAULT_POLL_INTERVAL_MS = 1000;
export const DEFAULT_BATCH_SIZE = 100;
export const DEFAULT_TTL_HOURS = 72;

const QUEUE_NAME = 'workflow-outbox-publisher';
const REPEATABLE_JOB_ID = 'workflow-outbox-drain';

const log = createLogger('workflow-engine:outbox-poller');

/**
 * Minimal Mongo model surface the poller needs. Decouples from Mongoose
 * so unit tests can inject a fake (constructor DI; no vi.mock).
 */
export interface OutboxPollModel {
  find(filter: Record<string, unknown>): {
    sort(spec: Record<string, 1 | -1>): {
      limit(n: number): {
        lean(): Promise<Array<WorkflowEventOutboxDoc & { _id: string }>>;
      };
    };
  };
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown>;
  countDocuments(filter: Record<string, unknown>): Promise<number>;
}

/**
 * Structural dependency on the Kafka publisher — matches
 * `KafkaEventQueue.publishAndAck(topic, event, key?)` in
 * `@abl/eventstore`. Duplicated here as a structural interface so this
 * module needs no runtime import from the eventstore package (the
 * eventstore barrel doesn't re-export `queues/*` today, and the type
 * shape is stable by design).
 */
export interface PublishClient {
  publishAndAck(topic: string, event: unknown, key?: string): Promise<void>;
}

export interface OutboxPollerConfig {
  pollIntervalMs?: number;
  batchSize?: number;
  ttlHours?: number;
}

export interface OutboxPollerDeps {
  handle: RedisConnectionHandle;
  model: OutboxPollModel;
  kafkaQueue: PublishClient;
  config?: OutboxPollerConfig;
  createBullMQPairFn?: (handle: RedisConnectionHandle) => BullMQConnectionPair;
}

export class OutboxPoller {
  private readonly queue: Queue;
  private readonly worker: Worker;
  private readonly queueConnection: RedisClient;
  private readonly workerConnection: RedisClient;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly ttlMs: number;
  private isShuttingDown = false;

  constructor(private readonly deps: OutboxPollerDeps) {
    this.pollIntervalMs =
      deps.config?.pollIntervalMs ??
      Number(process.env.WORKFLOW_OUTBOX_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS);
    this.batchSize =
      deps.config?.batchSize ??
      Number(process.env.WORKFLOW_OUTBOX_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
    this.ttlMs =
      ((deps.config?.ttlHours ??
        Number(process.env.WORKFLOW_OUTBOX_TTL_HOURS ?? DEFAULT_TTL_HOURS)) as number) *
      60 *
      60 *
      1000;

    const pair = (deps.createBullMQPairFn ?? createBullMQPair)(deps.handle);
    this.queueConnection = pair.queueConnection;
    this.workerConnection = pair.workerConnection;

    this.queue = new Queue(QUEUE_NAME, {
      connection: this.queueConnection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    });

    this.worker = new Worker(
      QUEUE_NAME,
      async (job: Job) => {
        if (this.isShuttingDown) return;
        await this.drain(job.id ?? 'unknown');
      },
      {
        connection: this.workerConnection,
        prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
        concurrency: 1,
      },
    );

    this.worker.on('failed', (job, err) => {
      log.warn('workflow.outbox.worker_failed', {
        event_type: 'workflow.consumer.flush_failed',
        jobId: job?.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Start the poller — registers the repeatable job and wires the
   * observable gauge. Idempotent: calling start() twice yields a single
   * repeatable job because BullMQ keys by `jobId`.
   */
  async start(): Promise<void> {
    await this.queue.add(
      REPEATABLE_JOB_ID,
      { reason: 'outbox.drain' },
      {
        jobId: REPEATABLE_JOB_ID,
        repeat: { every: this.pollIntervalMs },
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 200 },
      },
    );

    setUnpublishedRowsProvider(async () => {
      try {
        return await this.deps.model.countDocuments({ publishedAt: null });
      } catch (err) {
        log.warn('Unpublished-rows countDocuments failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return 0;
      }
    });

    log.info('OutboxPoller started', {
      pollIntervalMs: this.pollIntervalMs,
      batchSize: this.batchSize,
      ttlHours: this.ttlMs / (60 * 60 * 1000),
    });
  }

  /**
   * Graceful shutdown — closes the worker first so no new jobs run,
   * then the queue, then both Redis connections. Matches the
   * TriggerScheduler teardown sequence.
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    await this.worker.close();
    await this.queue.close();
    this.queueConnection.disconnect();
    this.workerConnection.disconnect();
    log.info('OutboxPoller shut down');
  }

  /**
   * Drain up to `batchSize` rows and publish each via publishAndAck.
   * Exposed for tests (driven directly via `new OutboxPoller(...).drain()`).
   */
  async drain(jobId: string): Promise<{ published: number; failed: number }> {
    const rows = await this.deps.model
      .find({ publishedAt: null })
      .sort({ occurredAt: 1 })
      .limit(this.batchSize)
      .lean();

    if (rows.length === 0) {
      return { published: 0, failed: 0 };
    }

    let published = 0;
    let failed = 0;

    for (const row of rows) {
      const startedAt = Date.now();
      try {
        await this.deps.kafkaQueue.publishAndAck(row.topic, row.payload, String(row.tenantId));
        const latencyMs = Date.now() - startedAt;
        const now = new Date();
        // Wrap the success-path bookkeeping `updateOne` in its own
        // try/catch so a transient Mongo hiccup can't abort the remaining
        // rows in this batch. If stamping `publishedAt` fails, the
        // ReplacingMergeTree dedup (`_version`) absorbs the duplicate
        // publish on the next poll cycle — the row still has
        // `publishedAt: null` and will be re-drained.
        try {
          await this.deps.model.updateOne(
            { _id: row._id },
            { $set: { publishedAt: now, expiresAt: new Date(now.getTime() + this.ttlMs) } },
          );
        } catch (bookkeepErr) {
          log.warn('workflow.outbox.bookkeeping_failed', {
            event_id: row._id,
            entity_kind: row.entityKind,
            topic: row.topic,
            error: bookkeepErr instanceof Error ? bookkeepErr.message : String(bookkeepErr),
            note: 'Kafka publish succeeded but updateOne failed — row will redrain; dedup on _version absorbs duplicate.',
          });
        }
        recordPublishLatency(latencyMs, { topic: row.topic, entity_kind: row.entityKind });
        recordPublishSuccess({ topic: row.topic, entity_kind: row.entityKind });
        log.info('workflow.outbox.published', {
          event_type: 'workflow.outbox.published',
          event_id: row._id,
          entity_kind: row.entityKind,
          topic: row.topic,
          latency_ms: latencyMs,
          attempt: (row.retryCount ?? 0) + 1,
          job_id: jobId,
        });
        published++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordPublishFailure({ topic: row.topic, entity_kind: row.entityKind });
        // Error-path bookkeeping — wrap the `updateOne` so a secondary
        // Mongo failure can't abort the entire drain batch. If this
        // updateOne itself fails, log + continue — the row stays
        // `publishedAt: null` so it is re-tried on the next poll cycle.
        try {
          await this.deps.model.updateOne(
            { _id: row._id },
            { $set: { lastError: msg }, $inc: { retryCount: 1 } },
          );
        } catch (bookkeepErr) {
          log.error('workflow.outbox.bookkeeping_failed', {
            event_id: row._id,
            entity_kind: row.entityKind,
            topic: row.topic,
            error: bookkeepErr instanceof Error ? bookkeepErr.message : String(bookkeepErr),
            note: 'Publish failure bookkeeping updateOne failed — retryCount/lastError not incremented for this cycle.',
          });
        }
        log.error('workflow.outbox.publish_failed', {
          event_type: 'workflow.consumer.flush_failed',
          event_id: row._id,
          entity_kind: row.entityKind,
          topic: row.topic,
          error: msg,
          attempt: (row.retryCount ?? 0) + 1,
          job_id: jobId,
        });
        failed++;
      }
    }

    return { published, failed };
  }
}
