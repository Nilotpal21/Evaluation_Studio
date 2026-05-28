/**
 * Session Retention Cleanup Job
 *
 * Periodic job that purges old terminal sessions and orphaned messages
 * from the database. This job is intentionally separate from live
 * idle/max-age timeout enforcement so retention settings do not control
 * when active conversations are terminalized.
 *
 * When Redis is available, each pass acquires a best-effort distributed lock
 * so only one pod performs the retention sweep at a time.
 */

import { isDatabaseAvailable } from '../db/index.js';
import {
  findOldSessions,
  findOldSessionsByTenant,
  getDistinctTenantIds,
  deleteSessionsByIds,
  deleteSessionsByIdsSystem,
  deleteOldMessages,
} from '../repos/session-repo.js';
import { getTenantConfigService, PLAN_LIMITS } from './tenant-config.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('session-cleanup');

const TERMINAL_STATUSES = ['completed', 'ended', 'escalated', 'abandoned', 'error'];
const FALLBACK_SESSION_RETENTION_DAYS = PLAN_LIMITS.TEAM.sessionRetentionDays;
const HOURS_PER_DAY = 24;
const CLEANUP_BATCH_SIZE = 500;
const DISTRIBUTED_LOCK_KEY = 'session-retention-cleanup';
const DISTRIBUTED_LOCK_PREFIX = 'runtime-maintenance';
const MIN_LOCK_TTL_MS = 5 * 60 * 1000;

let cleanupTimer: NodeJS.Timeout | null = null;

interface CleanupConfig {
  sessionTtlHours: number;
  messageTtlHours: number;
  intervalMinutes: number;
}

/**
 * Start the periodic retention cleanup job.
 * No-ops if database is unavailable or both retention knobs are disabled.
 */
export function startSessionCleanupJob(config: CleanupConfig): void {
  if (cleanupTimer) return;

  if (config.sessionTtlHours <= 0 && config.messageTtlHours <= 0) {
    log.info('Session retention cleanup disabled');
    return;
  }

  if (!isDatabaseAvailable()) {
    log.info('Session retention cleanup skipped — database not available');
    return;
  }

  const intervalMs = config.intervalMinutes * 60 * 1000;

  log.info('Starting session retention cleanup job', {
    sessionTtlHours: config.sessionTtlHours,
    messageTtlHours: config.messageTtlHours,
    intervalMinutes: config.intervalMinutes,
  });

  runCleanupWithLock(config).catch((err) =>
    log.error('Initial session retention cleanup failed', {
      phase: 'lock_acquire',
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );

  cleanupTimer = setInterval(() => {
    runCleanupWithLock(config).catch((err) =>
      log.error('Periodic session retention cleanup failed', {
        phase: 'lock_acquire',
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );
  }, intervalMs);

  if (cleanupTimer.unref) cleanupTimer.unref();
}

/**
 * Stop the retention cleanup job (for graceful shutdown).
 */
export function stopSessionCleanupJob(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    log.info('Session retention cleanup job stopped');
  }
}

async function getTenantRetentionDays(tenantId: string): Promise<number> {
  try {
    const config = await getTenantConfigService().getConfigAsync(tenantId);
    return config.limits.sessionRetentionDays;
  } catch (err) {
    log.warn('Failed to resolve tenant retention, using TEAM defaults', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return FALLBACK_SESSION_RETENTION_DAYS;
  }
}

async function runCleanupWithLock(config: CleanupConfig): Promise<void> {
  if (!isDatabaseAvailable()) {
    return;
  }

  const lockTtlMs = Math.max(MIN_LOCK_TTL_MS, config.intervalMinutes * 60 * 1000);

  try {
    const { getRedisClient } = await import('./redis/redis-client.js');
    const redis = getRedisClient();
    if (!redis) {
      await runCleanup(config);
      return;
    }

    const { DistributedLockManager } = await import('@agent-platform/shared');
    const lockManager = new DistributedLockManager(redis);
    const lock = await lockManager.acquire(DISTRIBUTED_LOCK_KEY, {
      keyPrefix: DISTRIBUTED_LOCK_PREFIX,
      ttlMs: lockTtlMs,
    });

    if (!lock) {
      log.debug('Skipping session retention cleanup pass — lock held by another pod', {
        intervalMinutes: config.intervalMinutes,
      });
      return;
    }

    try {
      await runCleanup(config);
    } finally {
      await lockManager.release(lock).catch((error: unknown) =>
        log.warn('Failed to release session retention cleanup lock', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  } catch (error) {
    log.warn('Session retention cleanup lock unavailable, running without coordination', {
      phase: 'lock_fallback',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    await runCleanup(config);
  }
}

async function runCleanup(config: CleanupConfig): Promise<void> {
  if (!isDatabaseAvailable()) {
    return;
  }

  let sessionsDeleted = 0;
  let messagesDeleted = 0;

  try {
    const tenantIds = await getDistinctTenantIds();

    for (const tenantId of tenantIds) {
      try {
        const sessionRetentionDays = await getTenantRetentionDays(tenantId);
        const sessionRetentionHours = sessionRetentionDays * HOURS_PER_DAY;

        if (sessionRetentionHours < 0) {
          continue;
        }

        const effectiveSessionHours =
          config.sessionTtlHours > 0
            ? Math.min(sessionRetentionHours, config.sessionTtlHours)
            : sessionRetentionHours;

        if (effectiveSessionHours <= 0) {
          continue;
        }

        const sessionCutoff = new Date(Date.now() - effectiveSessionHours * 60 * 60 * 1000);

        let batchDeleted = 0;
        do {
          const batch = await findOldSessionsByTenant(
            tenantId,
            sessionCutoff,
            TERMINAL_STATUSES,
            CLEANUP_BATCH_SIZE,
          );
          if (batch.length === 0) {
            break;
          }

          batchDeleted = await deleteSessionsByIds(
            batch.map((session) => session.id),
            tenantId,
          );
          sessionsDeleted += batchDeleted;
        } while (batchDeleted >= CLEANUP_BATCH_SIZE);
      } catch (err) {
        log.error('Session retention cleanup failed for tenant, continuing', {
          phase: 'tenant_iteration',
          tenantId,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          tenantCount: tenantIds?.length ?? null,
        });
      }
    }
  } catch (err) {
    log.warn('Per-tenant session retention cleanup failed, falling back to global cleanup', {
      phase: 'tenant_iteration',
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    if (config.sessionTtlHours > 0) {
      sessionsDeleted += await runGlobalSessionCleanup(config.sessionTtlHours);
    }
  }

  if (config.messageTtlHours > 0) {
    const messageCutoff = new Date(Date.now() - config.messageTtlHours * 60 * 60 * 1000);
    messagesDeleted = await deleteOldMessages(messageCutoff, TERMINAL_STATUSES);
  }

  if (sessionsDeleted > 0 || messagesDeleted > 0) {
    log.info('Session retention cleanup completed', { sessionsDeleted, messagesDeleted });
  }
}

async function runGlobalSessionCleanup(sessionTtlHours: number): Promise<number> {
  const sessionCutoff = new Date(Date.now() - sessionTtlHours * 60 * 60 * 1000);
  let sessionsDeleted = 0;
  let batchDeleted = 0;

  do {
    const batch = await findOldSessions(sessionCutoff, TERMINAL_STATUSES, CLEANUP_BATCH_SIZE);
    if (batch.length === 0) {
      break;
    }

    batchDeleted = await deleteSessionsByIdsSystem(batch.map((session) => session.id));
    sessionsDeleted += batchDeleted;
  } while (batchDeleted >= CLEANUP_BATCH_SIZE);

  return sessionsDeleted;
}
