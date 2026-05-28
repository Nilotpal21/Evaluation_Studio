import { createLogger } from '@abl/compiler/platform';
import { isDatabaseAvailable } from '../../db/index.js';
import { BillingUsagePublicationSchedulerService } from './billing-usage-publication-scheduler-service.js';

const log = createLogger('billing-usage-publication-scheduler');

const DISTRIBUTED_LOCK_KEY = 'billing-usage-publication-scheduler';
const DISTRIBUTED_LOCK_PREFIX = 'runtime-maintenance';
const MIN_LOCK_TTL_MS = 5 * 60 * 1000;

export interface BillingUsagePublicationSchedulerConfig {
  enabled: boolean;
  intervalMs: number;
  tenantBatchSize: number;
  batchLimit: number;
}

let billingPublicationTimer: NodeJS.Timeout | null = null;
let billingPublicationPassInFlight = false;

async function runScheduledPassWithLock(
  service: BillingUsagePublicationSchedulerService,
  config: BillingUsagePublicationSchedulerConfig,
): Promise<void> {
  const lockTtlMs = Math.max(MIN_LOCK_TTL_MS, config.intervalMs);

  try {
    const { getRedisClient } = await import('../redis/redis-client.js');
    const redis = getRedisClient();
    if (!redis) {
      await runScheduledPass(service);
      return;
    }

    const { DistributedLockManager } = await import('@agent-platform/shared');
    const lockManager = new DistributedLockManager(redis);
    const lock = await lockManager.acquire(DISTRIBUTED_LOCK_KEY, {
      keyPrefix: DISTRIBUTED_LOCK_PREFIX,
      ttlMs: lockTtlMs,
    });

    if (!lock) {
      log.debug('Skipping billing publication scheduler pass — lock held by another pod', {
        intervalMs: config.intervalMs,
      });
      return;
    }

    try {
      await runScheduledPass(service);
    } finally {
      await lockManager.release(lock).catch((error: unknown) =>
        log.warn('Failed to release billing publication scheduler lock', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  } catch (error: unknown) {
    log.warn('Billing publication scheduler lock unavailable, running without coordination', {
      error: error instanceof Error ? error.message : String(error),
    });
    await runScheduledPass(service);
  }
}

async function runScheduledPass(service: BillingUsagePublicationSchedulerService): Promise<void> {
  const result = await service.runDuePublications();

  if (result.appliedBatchCount > 0 || result.failedBatchCount > 0) {
    log.info('Billing publication scheduler pass completed', {
      scannedTenantCount: result.scannedTenantCount,
      pendingTenantCount: result.pendingTenantCount,
      attemptedBatchCount: result.attemptedBatchCount,
      appliedBatchCount: result.appliedBatchCount,
      failedBatchCount: result.failedBatchCount,
      skippedTenantCount: result.skippedTenantCount,
    });
  }
}

export function startBillingUsagePublicationScheduler(
  config: BillingUsagePublicationSchedulerConfig,
): void {
  if (billingPublicationTimer) {
    return;
  }

  if (!config.enabled) {
    log.info('Billing publication scheduler disabled');
    return;
  }

  if (!isDatabaseAvailable()) {
    log.info('Billing publication scheduler skipped — database not available');
    return;
  }

  const service = new BillingUsagePublicationSchedulerService({
    tenantBatchSize: config.tenantBatchSize,
    batchLimit: config.batchLimit,
  });

  log.info('Starting billing publication scheduler', {
    intervalMs: config.intervalMs,
    tenantBatchSize: config.tenantBatchSize,
    batchLimit: config.batchLimit,
  });

  const runOnce = async () => {
    if (billingPublicationPassInFlight) {
      log.warn('Billing publication scheduler pass skipped — previous pass still running');
      return;
    }

    billingPublicationPassInFlight = true;
    try {
      await runScheduledPassWithLock(service, config);
    } catch (error: unknown) {
      log.error('Billing publication scheduler pass failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      billingPublicationPassInFlight = false;
    }
  };

  void runOnce();
  billingPublicationTimer = setInterval(() => {
    void runOnce();
  }, config.intervalMs);

  if (billingPublicationTimer.unref) {
    billingPublicationTimer.unref();
  }
}

export function stopBillingUsagePublicationScheduler(): void {
  if (!billingPublicationTimer) {
    return;
  }

  clearInterval(billingPublicationTimer);
  billingPublicationTimer = null;
  billingPublicationPassInFlight = false;
  log.info('Billing publication scheduler stopped');
}
