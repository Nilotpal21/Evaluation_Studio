/**
 * BullMQ Scheduler
 *
 * Production scheduler backed by Redis via BullMQ.
 * Supports persistent repeatable jobs, exponential backoff retry,
 * and dead-letter queues for failed jobs.
 *
 * Uses `createRedisConnection` from @agent-platform/redis so both
 * standalone and cluster Redis URLs work correctly.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import type { ScheduledJob, SchedulerStrategy, SchedulerStatus } from './scheduler-types';

// BullMQ types (dynamically imported)
type Queue = any;
type Worker = any;

const log = createLogger('bullmq-scheduler');

export class BullMQScheduler implements SchedulerStrategy {
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private running = false;
  private jobs = new Map<string, ScheduledJob>();
  private redisUrl: string;

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl;
  }

  async register(job: ScheduledJob): Promise<void> {
    this.jobs.set(job.name, job);

    if (this.queue) {
      await this.addRepeatableJob(job);
    }
  }

  async remove(jobName: string): Promise<void> {
    this.jobs.delete(jobName);

    if (this.queue) {
      const repeatableJobs = await this.queue.getRepeatableJobs();
      for (const rj of repeatableJobs) {
        if (rj.name === jobName) {
          await this.queue.removeRepeatableByKey(rj.key);
        }
      }
    }
  }

  async start(): Promise<void> {
    if (this.running) return;

    try {
      // @ts-ignore - bullmq is optional, only used when Redis is available
      const bullmq = await import('bullmq');
      const { createRedisConnection, resolveRedisOptionsFromEnv, BULLMQ_CLUSTER_SAFE_PREFIX } =
        await import('@agent-platform/redis');

      // Build a cluster-aware handle from the URL so both standalone and
      // Redis Cluster deployments work correctly.
      const opts = resolveRedisOptionsFromEnv() ?? { url: this.redisUrl };
      const handle = createRedisConnection(opts);

      // BullMQ requires separate connections for Queue and Worker — sharing one
      // causes the second .close() to fail because the connection is already dead.
      this.queue = new bullmq.Queue('platform-scheduler', {
        connection: handle.duplicate({ maxRetriesPerRequest: null }),
        prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
        defaultJobOptions: {
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 500 },
        },
      });

      // BullMQ Workers use blocking Redis commands (BRPOPLPUSH / XREADGROUP)
      // which require maxRetriesPerRequest: null to avoid premature failures.
      this.worker = new bullmq.Worker(
        'platform-scheduler',
        async (job: any) => {
          const registered = this.jobs.get(job.name);
          if (!registered) {
            log.warn('No handler for job', { jobName: job.name });
            return;
          }

          log.info('Executing job', { jobName: job.name });
          await registered.handler();
          log.info('Completed job', { jobName: job.name });
        },
        {
          connection: handle.duplicate({ maxRetriesPerRequest: null }),
          prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
          concurrency: 1, // Process one job at a time
        },
      );

      this.worker.on('failed', (job: any, err: Error) => {
        log.error('Job failed', { jobName: job?.name, error: err.message });
      });

      // Register all pending jobs
      for (const job of this.jobs.values()) {
        await this.addRepeatableJob(job);
      }

      this.running = true;
      log.info('BullMQ started', { jobCount: this.jobs.size });
    } catch (error) {
      log.error('Failed to start BullMQ', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }

    this.running = false;
    log.info('BullMQ stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  getType(): string {
    return 'bullmq';
  }

  getStatus(): SchedulerStatus {
    const registeredJobs = Array.from(this.jobs.keys());
    const nextRunTimes: Record<string, Date | null> = {};
    for (const name of registeredJobs) {
      nextRunTimes[name] = null; // BullMQ manages next run internally
    }
    return {
      type: this.getType(),
      running: this.running,
      registeredJobs,
      nextRunTimes,
    };
  }

  private async addRepeatableJob(job: ScheduledJob): Promise<void> {
    if (!this.queue) return;

    await this.queue.add(
      job.name,
      { registeredAt: new Date().toISOString() },
      {
        repeat: { pattern: job.cron },
        attempts: job.retries ?? 3,
        backoff: {
          type: 'exponential',
          delay: job.backoff ?? 5000,
        },
        timeout: job.timeout ?? 300_000,
      },
    );
  }
}
