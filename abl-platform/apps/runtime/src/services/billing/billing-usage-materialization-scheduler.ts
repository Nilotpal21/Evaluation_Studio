import { createLogger } from '@abl/compiler/platform';
import { isDatabaseAvailable } from '../../db/index.js';
import { BillingUsageMaterializationSchedulerService } from './billing-usage-materialization-scheduler-service.js';

const log = createLogger('billing-usage-materialization-scheduler');

const DISTRIBUTED_LOCK_KEY = 'billing-usage-materialization-scheduler';
const DISTRIBUTED_LOCK_PREFIX = 'runtime-maintenance';
const MIN_LOCK_TTL_MS = 5 * 60 * 1000;

export interface BillingUsageMaterializationSchedulerConfig {
  enabled: boolean;
  intervalMs: number;
  tenantBatchSize: number;
}

let billingMaterializationTimer: NodeJS.Timeout | null = null;
let billingMaterializationPassInFlight = false;

async function runScheduledPassWithLock(
  service: BillingUsageMaterializationSchedulerService,
  config: BillingUsageMaterializationSchedulerConfig,
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
      log.debug('Skipping billing materialization scheduler pass — lock held by another pod', {
        intervalMs: config.intervalMs,
      });
      return;
    }

    try {
      await runScheduledPass(service);
    } finally {
      await lockManager.release(lock).catch((error: unknown) =>
        log.warn('Failed to release billing materialization scheduler lock', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  } catch (error) {
    log.warn('Billing materialization scheduler lock unavailable, running without coordination', {
      error: error instanceof Error ? error.message : String(error),
    });
    await runScheduledPass(service);
  }
}

async function runScheduledPass(
  service: BillingUsageMaterializationSchedulerService,
): Promise<void> {
  const result = await service.runDueMaterializations();

  if (result.materializedBatchCount > 0 || result.failedTenantCount > 0) {
    log.info('Billing materialization scheduler pass completed', {
      scannedTenantCount: result.scannedTenantCount,
      dueTenantCount: result.dueTenantCount,
      materializedBatchCount: result.materializedBatchCount,
      failedTenantCount: result.failedTenantCount,
      skippedTenantCount: result.skippedTenantCount,
    });
  }
}

export function startBillingUsageMaterializationScheduler(
  config: BillingUsageMaterializationSchedulerConfig,
): void {
  if (billingMaterializationTimer) {
    return;
  }

  if (!config.enabled) {
    log.info('Billing materialization scheduler disabled');
    return;
  }

  if (!isDatabaseAvailable()) {
    log.info('Billing materialization scheduler skipped — database not available');
    return;
  }

  const service = new BillingUsageMaterializationSchedulerService({
    tenantBatchSize: config.tenantBatchSize,
  });

  log.info('Starting billing materialization scheduler', {
    intervalMs: config.intervalMs,
    tenantBatchSize: config.tenantBatchSize,
  });

  const runOnce = async () => {
    if (billingMaterializationPassInFlight) {
      log.warn('Billing materialization scheduler pass skipped — previous pass still running');
      return;
    }

    billingMaterializationPassInFlight = true;
    try {
      await runScheduledPassWithLock(service, config);
    } catch (error) {
      log.error('Billing materialization scheduler pass failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      billingMaterializationPassInFlight = false;
    }
  };

  void runOnce();
  billingMaterializationTimer = setInterval(() => {
    void runOnce();
  }, config.intervalMs);

  if (billingMaterializationTimer.unref) {
    billingMaterializationTimer.unref();
  }
}

export function stopBillingUsageMaterializationScheduler(): void {
  if (!billingMaterializationTimer) {
    return;
  }

  clearInterval(billingMaterializationTimer);
  billingMaterializationTimer = null;
  billingMaterializationPassInFlight = false;
  log.info('Billing materialization scheduler stopped');
}
