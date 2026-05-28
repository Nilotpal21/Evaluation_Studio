/**
 * BullMQEventQueue - Redis-backed persistent queue.
 *
 * Uses BullMQ for durable event queuing with:
 * - Redis persistence (events survive pod restarts)
 * - Automatic retry with exponential backoff
 * - Concurrency control
 * - Dead letter queue for failed events
 *
 * Use when:
 * - Need durability (events must not be lost)
 * - Need decoupled processing (queue → worker)
 * - Already have Redis infrastructure
 * - Want cross-pod fan-in (multiple pods → single queue → multiple workers)
 */

import { Queue, Worker, type Job } from 'bullmq';
import { createLogger } from '@agent-platform/shared-observability';
import type { RedisConnectionHandle, BullMQConnectionPair } from '@agent-platform/redis';
import { createBullMQPair, BULLMQ_CLUSTER_SAFE_PREFIX } from '@agent-platform/redis';
import type { IEventQueue } from '../interfaces/event-queue.js';

const log = createLogger('eventstore:bullmq-queue');

export interface BullMQEventQueueConfig {
  redis: RedisConnectionHandle;
  queueName?: string;
  concurrency?: number;
  maxRetries?: number;
}

export class BullMQEventQueue implements IEventQueue {
  readonly queueName: string;
  private queue: Queue;
  private worker: Worker | null = null;
  private handler: ((event: unknown) => void | Promise<void>) | null = null;
  private redisHealthy = true;
  private readonly concurrency: number;
  private readonly maxRetries: number;
  private readonly pair: BullMQConnectionPair;

  constructor(config: BullMQEventQueueConfig) {
    this.queueName = config.queueName ?? 'eventstore-events';
    this.concurrency = config.concurrency ?? 10;
    this.maxRetries = config.maxRetries ?? 3;

    // Create cluster-safe BullMQ connection pair from the handle
    this.pair = createBullMQPair(config.redis);

    // Create BullMQ queue
    this.queue = new Queue(this.queueName, {
      connection: this.pair.queueConnection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      defaultJobOptions: {
        attempts: this.maxRetries,
        backoff: {
          type: 'exponential',
          delay: 1000, // Start at 1s, exponential backoff
        },
        removeOnComplete: true, // Clean up successful jobs
        removeOnFail: false, // Keep failed jobs for debugging
      },
    });

    // Monitor Redis connection health
    this.queue.on('error', (err) => {
      log.error('Redis connection error', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.redisHealthy = false;
    });

    this.queue.on('resumed', () => {
      this.redisHealthy = true;
    });
  }

  get pendingCount(): number {
    // BullMQ doesn't expose synchronous count - return estimate
    // Use queue.getJobCounts() for accurate async count
    return 0; // Would need async API
  }

  enqueue(event: unknown): void {
    // Non-blocking: add to Redis queue, returns immediately
    this.queue.add('event', event).catch((err) => {
      log.error('Failed to enqueue event', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.redisHealthy = false;
    });
  }

  enqueueBatch(events: unknown[]): void {
    // BullMQ batch add for efficiency
    const jobs = events.map((event) => ({ name: 'event', data: event }));
    this.queue.addBulk(jobs).catch((err) => {
      log.error('Failed to enqueue batch', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.redisHealthy = false;
    });
  }

  onProcess(handler: (event: unknown) => void | Promise<void>): void {
    if (this.handler) {
      throw new Error('BullMQEventQueue: Handler already registered');
    }

    this.handler = handler;

    // Create BullMQ worker using the worker connection from the pair
    this.worker = new Worker(
      this.queueName,
      async (job: Job) => {
        // Process the event
        await Promise.resolve(handler(job.data));
      },
      {
        connection: this.pair.workerConnection,
        prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
        concurrency: this.concurrency,
      },
    );

    this.worker.on('failed', (job, err) => {
      log.error('Job failed', {
        jobId: job?.id,
        attempts: job?.attemptsMade,
        error: err.message,
      });
    });
  }

  async flush(): Promise<void> {
    // Wait for all pending jobs to complete
    await this.queue.drain();
  }

  async close(): Promise<void> {
    // Graceful shutdown: wait for active jobs, then close
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    await this.queue.close();
    this.pair.disconnect();
    this.handler = null;
  }

  isHealthy(): boolean {
    return this.redisHealthy;
  }

  /**
   * Get detailed queue metrics (async).
   */
  async getMetrics(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
  }> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'completed', 'failed');
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
    };
  }
}
