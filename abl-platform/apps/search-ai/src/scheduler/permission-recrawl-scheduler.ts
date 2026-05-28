/**
 * Permission Recrawl Scheduler
 *
 * Sets up recurring scheduled permission recrawls using BullMQ's repeat functionality.
 * Runs weekly to keep permissions up-to-date as SharePoint permissions change.
 *
 * Schedule: Every Sunday at 2:00 AM UTC
 */

import { Queue, Worker } from 'bullmq';
import { BULLMQ_CLUSTER_SAFE_PREFIX, type RedisConnectionHandle } from '@agent-platform/redis';
import { createLogger } from '@abl/compiler/platform';
import {
  schedulePermissionRecrawlJobs,
  createPermissionRecrawlQueue,
  type PermissionRecrawlJobData,
} from '../workers/permission-recrawl-worker.js';
import { createQueue } from '../workers/shared.js';

const log = createLogger('permission-recrawl-scheduler');

// ============================================================================
// Scheduler Configuration
// ============================================================================

const SCHEDULE_NAME = 'weekly-permission-recrawl';
const CRON_SCHEDULE = '0 2 * * 0'; // Every Sunday at 2:00 AM UTC

export interface PermissionRecrawlSchedulerOptions {
  handle: RedisConnectionHandle;
  enabled?: boolean; // Default: true
  cronSchedule?: string; // Default: '0 2 * * 0' (Sunday 2 AM)
}

// ============================================================================
// Scheduler Setup
// ============================================================================

export async function setupPermissionRecrawlScheduler(
  options: PermissionRecrawlSchedulerOptions,
): Promise<Queue<PermissionRecrawlJobData>> {
  const { handle, enabled = true, cronSchedule = CRON_SCHEDULE } = options;

  if (!enabled) {
    log.info('Scheduler disabled via config');
    return null as any;
  }

  // Create scheduler queue (separate from worker queue) — cluster-aware via factory
  const schedulerQueue = createQueue(
    'permission-recrawl-scheduler',
  ) as Queue<PermissionRecrawlJobData>;

  try {
    // Remove existing schedules (in case cron changed)
    const existingJobs = await schedulerQueue.getRepeatableJobs();
    for (const job of existingJobs) {
      if (job.name === SCHEDULE_NAME) {
        await schedulerQueue.removeRepeatableByKey(job.key);
        log.info('Removed existing schedule');
      }
    }

    // Add new recurring schedule
    await schedulerQueue.add(
      SCHEDULE_NAME,
      {} as any, // No job data needed - scheduler just triggers the scan
      {
        repeat: {
          pattern: cronSchedule,
        },
        jobId: SCHEDULE_NAME,
      },
    );

    log.info('Scheduled permission recrawl', { cronSchedule });

    // Create worker to process scheduled jobs — Worker needs maxRetriesPerRequest: null
    // for blocking XREADGROUP commands to work in both standalone and cluster mode.
    const schedulerWorker = new Worker(
      'permission-recrawl-scheduler',
      async (job) => {
        if (job.name === SCHEDULE_NAME) {
          log.info('Executing scheduled permission recrawl');

          try {
            const workerQueue = createPermissionRecrawlQueue();
            await schedulePermissionRecrawlJobs(workerQueue);
            log.info('Scheduled permission recrawl completed');
          } catch (error) {
            log.error('Scheduled permission recrawl failed', {
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        }
      },
      {
        connection: handle.duplicate({ maxRetriesPerRequest: null }),
        prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      },
    );

    // Suppress unused variable warning — worker lifecycle managed by BullMQ
    void schedulerWorker;

    return schedulerQueue;
  } catch (error) {
    log.error('Failed to setup scheduler', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// ============================================================================
// Scheduler Management
// ============================================================================

export async function getSchedulerStatus(schedulerQueue: Queue<PermissionRecrawlJobData>): Promise<{
  enabled: boolean;
  nextRun: Date | null;
  lastRun: Date | null;
  schedule: string | null;
}> {
  const repeatableJobs = await schedulerQueue.getRepeatableJobs();
  const scheduleJob = repeatableJobs.find((job) => job.name === SCHEDULE_NAME);

  if (!scheduleJob) {
    return {
      enabled: false,
      nextRun: null,
      lastRun: null,
      schedule: null,
    };
  }

  return {
    enabled: true,
    nextRun: scheduleJob.next ? new Date(scheduleJob.next) : null,
    lastRun: null, // BullMQ doesn't track last run in repeatable job metadata
    schedule: scheduleJob.pattern || null,
  };
}

export async function pauseScheduler(
  schedulerQueue: Queue<PermissionRecrawlJobData>,
): Promise<void> {
  const repeatableJobs = await schedulerQueue.getRepeatableJobs();
  const scheduleJob = repeatableJobs.find((job) => job.name === SCHEDULE_NAME);

  if (scheduleJob) {
    await schedulerQueue.removeRepeatableByKey(scheduleJob.key);
    log.info('Paused scheduled permission recrawl');
  }
}

export async function resumeScheduler(
  schedulerQueue: Queue<PermissionRecrawlJobData>,
  cronSchedule: string = CRON_SCHEDULE,
): Promise<void> {
  await pauseScheduler(schedulerQueue);

  await schedulerQueue.add(SCHEDULE_NAME, {} as any, {
    repeat: {
      pattern: cronSchedule,
    },
    jobId: SCHEDULE_NAME,
  });

  log.info('Resumed scheduled permission recrawl', { cronSchedule });
}
