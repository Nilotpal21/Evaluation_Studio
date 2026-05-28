interface RuntimeMaintenanceLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
}

const DEFAULT_BILLING_MATERIALIZATION_INTERVAL_MS = 300_000;
const DEFAULT_BILLING_MATERIALIZATION_TENANT_BATCH_SIZE = 100;
const DEFAULT_BILLING_PUBLICATION_INTERVAL_MS = 1_800_000;
const DEFAULT_BILLING_PUBLICATION_TENANT_BATCH_SIZE = 100;
const DEFAULT_BILLING_PUBLICATION_BATCH_LIMIT = 10;

export async function startRuntimeMaintenanceJobs(logger: RuntimeMaintenanceLogger): Promise<void> {
  try {
    const { startKMSRotationJob } = await import('./kms/kms-rotation-job.js');
    startKMSRotationJob({
      intervalMinutes: parseInt(process.env.KMS_ROTATION_INTERVAL_MINUTES || '60', 10),
      // DEK destruction is explicitly opt-in. Null keeps decrypt_only DEKs readable indefinitely.
      dekRetentionDays: null,
      kekRotationPeriodDays: 365,
      enableReencryption: true,
    });
    logger.info('KMS rotation job started');
  } catch (err) {
    logger.warn('KMS rotation job failed to start (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { startAuthProfileRotationJob } =
      await import('./auth-profile/auth-profile-rotation-scheduler.js');
    startAuthProfileRotationJob();
    logger.info('Auth profile rotation job started');
  } catch (err) {
    logger.warn('Auth profile rotation job failed to start (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { startBillingUsageMaterializationScheduler } =
      await import('./billing/billing-usage-materialization-scheduler.js');
    startBillingUsageMaterializationScheduler({
      enabled: process.env.BILLING_MATERIALIZATION_ENABLED === 'true',
      intervalMs: parseInt(
        process.env.BILLING_MATERIALIZATION_INTERVAL_MS ||
          String(DEFAULT_BILLING_MATERIALIZATION_INTERVAL_MS),
        10,
      ),
      tenantBatchSize: parseInt(
        process.env.BILLING_MATERIALIZATION_TENANT_BATCH_SIZE ||
          String(DEFAULT_BILLING_MATERIALIZATION_TENANT_BATCH_SIZE),
        10,
      ),
    });
    logger.info('Billing materialization scheduler started');
  } catch (err) {
    logger.warn('Billing materialization scheduler failed to start (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { startBillingUsagePublicationScheduler } =
      await import('./billing/billing-usage-publication-scheduler.js');
    startBillingUsagePublicationScheduler({
      enabled: process.env.BILLING_PUBLICATION_ENABLED === 'true',
      intervalMs: parseInt(
        process.env.BILLING_PUBLICATION_INTERVAL_MS ||
          String(DEFAULT_BILLING_PUBLICATION_INTERVAL_MS),
        10,
      ),
      tenantBatchSize: parseInt(
        process.env.BILLING_PUBLICATION_TENANT_BATCH_SIZE ||
          String(DEFAULT_BILLING_PUBLICATION_TENANT_BATCH_SIZE),
        10,
      ),
      batchLimit: parseInt(
        process.env.BILLING_PUBLICATION_BATCH_LIMIT ||
          String(DEFAULT_BILLING_PUBLICATION_BATCH_LIMIT),
        10,
      ),
    });
    logger.info('Billing publication scheduler started');
  } catch (err) {
    logger.warn('Billing publication scheduler failed to start (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function stopRuntimeMaintenanceJobs(): Promise<void> {
  try {
    const { stopKMSRotationJob } = await import('./kms/kms-rotation-job.js');
    stopKMSRotationJob();
  } catch {
    // Module may not be loaded
  }

  try {
    const { stopAuthProfileRotationJob } =
      await import('./auth-profile/auth-profile-rotation-scheduler.js');
    stopAuthProfileRotationJob();
  } catch {
    // Module may not be loaded
  }

  try {
    const { stopBillingUsageMaterializationScheduler } =
      await import('./billing/billing-usage-materialization-scheduler.js');
    stopBillingUsageMaterializationScheduler();
  } catch {
    // Module may not be loaded
  }

  try {
    const { stopBillingUsagePublicationScheduler } =
      await import('./billing/billing-usage-publication-scheduler.js');
    stopBillingUsagePublicationScheduler();
  } catch {
    // Module may not be loaded
  }

  try {
    const { shutdownReencryptionQueue } = await import('./kms/reencryption-queue.js');
    await shutdownReencryptionQueue();
  } catch {
    // Module may not be loaded
  }
}
