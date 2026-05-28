/**
 * Workflow Purge Job
 *
 * Periodic job that hard-deletes workflows, versions, and trigger registrations
 * that were soft-deleted beyond the retention period. This prevents storage
 * growth from accumulated soft-deleted documents (GAP-006).
 *
 * When Redis is available, each pass acquires a best-effort distributed lock
 * so only one pod performs the purge sweep at a time.
 */

import { isDatabaseAvailable } from '../db/index.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('workflow-purge');

const DEFAULT_RETENTION_DAYS = 30;
const PURGE_BATCH_SIZE = 200;
const DISTRIBUTED_LOCK_KEY = 'workflow-purge-cleanup';
const DISTRIBUTED_LOCK_PREFIX = 'runtime-maintenance';
const MIN_LOCK_TTL_MS = 5 * 60 * 1000;

let purgeTimer: NodeJS.Timeout | null = null;

export interface WorkflowPurgeConfig {
  retentionDays: number;
  intervalMinutes: number;
}

/**
 * Start the periodic workflow purge job.
 * No-ops if database is unavailable or retention is disabled (retentionDays <= 0).
 */
export function startWorkflowPurgeJob(config: WorkflowPurgeConfig): void {
  if (purgeTimer) return;

  const retentionDays = config.retentionDays > 0 ? config.retentionDays : DEFAULT_RETENTION_DAYS;

  if (!isDatabaseAvailable()) {
    log.info('Workflow purge job skipped — database not available');
    return;
  }

  const intervalMs = config.intervalMinutes * 60 * 1000;

  log.info('Starting workflow purge job', {
    retentionDays,
    intervalMinutes: config.intervalMinutes,
  });

  const effectiveConfig = { ...config, retentionDays };

  runPurgeWithLock(effectiveConfig).catch((err) =>
    log.error('Initial workflow purge failed', {
      error: err instanceof Error ? err.message : String(err),
    }),
  );

  purgeTimer = setInterval(() => {
    runPurgeWithLock(effectiveConfig).catch((err) =>
      log.error('Periodic workflow purge failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, intervalMs);

  if (purgeTimer.unref) purgeTimer.unref();
}

/**
 * Stop the purge job (for graceful shutdown).
 */
export function stopWorkflowPurgeJob(): void {
  if (purgeTimer) {
    clearInterval(purgeTimer);
    purgeTimer = null;
    log.info('Workflow purge job stopped');
  }
}

async function runPurgeWithLock(config: WorkflowPurgeConfig): Promise<void> {
  if (!isDatabaseAvailable()) return;

  const lockTtlMs = Math.max(MIN_LOCK_TTL_MS, config.intervalMinutes * 60 * 1000);

  try {
    const { getRedisClient } = await import('./redis/redis-client.js');
    const redis = getRedisClient();
    if (!redis) {
      await runPurge(config);
      return;
    }

    const { DistributedLockManager } = await import('@agent-platform/shared');
    const lockManager = new DistributedLockManager(redis);
    const lock = await lockManager.acquire(DISTRIBUTED_LOCK_KEY, {
      keyPrefix: DISTRIBUTED_LOCK_PREFIX,
      ttlMs: lockTtlMs,
    });

    if (!lock) {
      log.debug('Skipping workflow purge pass — lock held by another pod');
      return;
    }

    try {
      await runPurge(config);
    } finally {
      await lockManager.release(lock).catch((error: unknown) =>
        log.warn('Failed to release workflow purge lock', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  } catch (error) {
    log.warn('Workflow purge lock unavailable, running without coordination', {
      error: error instanceof Error ? error.message : String(error),
    });
    await runPurge(config);
  }
}

async function runPurge(config: WorkflowPurgeConfig): Promise<void> {
  if (!isDatabaseAvailable()) return;

  const cutoff = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000);
  let workflowsDeleted = 0;
  let versionsDeleted = 0;
  let triggersDeleted = 0;

  try {
    const { Workflow, WorkflowVersion, TriggerRegistration } =
      await import('@agent-platform/database/models');

    // Find soft-deleted workflows past retention in batches
    let batch: Array<{ _id: string; tenantId: string; projectId?: string }>;
    do {
      batch = (await Workflow.find(
        { deleted: true, deletedAt: { $lte: cutoff } },
        { _id: 1, tenantId: 1, projectId: 1 },
        { limit: PURGE_BATCH_SIZE, lean: true },
      )) as Array<{ _id: string; tenantId: string; projectId?: string }>;

      if (batch.length === 0) break;

      const workflowIds = batch.map((w) => w._id);

      // Hard-delete trigger registrations for these workflows
      const triggerResult = await TriggerRegistration.deleteMany({
        workflowId: { $in: workflowIds },
      });
      triggersDeleted += triggerResult.deletedCount ?? 0;

      // Hard-delete versions for these workflows
      const versionResult = await WorkflowVersion.deleteMany({
        workflowId: { $in: workflowIds },
      });
      versionsDeleted += versionResult.deletedCount ?? 0;

      // Hard-delete the workflows themselves
      const workflowResult = await Workflow.deleteMany({
        _id: { $in: workflowIds },
      });
      workflowsDeleted += workflowResult.deletedCount ?? 0;
    } while (batch.length >= PURGE_BATCH_SIZE);
  } catch (err) {
    log.error('Workflow purge failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (workflowsDeleted > 0 || versionsDeleted > 0 || triggersDeleted > 0) {
    log.info('Workflow purge completed', {
      workflowsDeleted,
      versionsDeleted,
      triggersDeleted,
      retentionDays: config.retentionDays,
    });
  }
}
