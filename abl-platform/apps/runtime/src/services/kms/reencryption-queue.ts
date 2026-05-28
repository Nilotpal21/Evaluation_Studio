/**
 * Re-encryption Queue
 *
 * BullMQ queue for DEK re-wrapping after KEK rotation.
 * Pattern matches llm-queue.ts: lazy BullMQ init, local fallback, graceful shutdown.
 *
 * Jobs are enqueued by:
 *   - kms-rotation-job.ts (periodic KEK age check)
 *   - kms-admin.ts (manual key rotation trigger)
 *
 * Deduplication: jobId includes tenant + optional project/environment scope +
 * reason + date, preventing duplicate scoped jobs on the same day.
 */

import { createLogger } from '@abl/compiler/platform';
import { BULLMQ_CLUSTER_SAFE_PREFIX } from '@agent-platform/redis';
import { createHash } from 'node:crypto';

const log = createLogger('reencryption-queue');

// =============================================================================
// TYPES
// =============================================================================

export interface ReencryptionJob {
  tenantId: string;
  reason: 'kek-age-exceeded' | 'manual-rotation' | 'key-compromise' | 'provider-drift';
  kekKeyId?: string;
  projectId?: string;
  environment?: string;
  /**
   * Optional discriminator for idempotency. Provider-drift jobs should include
   * the target provider fingerprint so an earlier same-day completed job does
   * not suppress a new drift run after a provider/config rollout.
   */
  dedupeKey?: string;
}

interface ReencryptionQueueConfig {
  enabled: boolean;
  concurrency: number;
  batchSize: number;
  maxRetries: number;
  jobTimeoutMs: number;
}

// =============================================================================
// STATE
// =============================================================================

let bullQueue: any = null;
let bullWorker: any = null;
let bullMQPair: {
  queueConnection: any;
  workerConnection: any;
  disconnect(): void;
} | null = null;
let initialized = false;
let shutdownRequested = false;
let sharedResolver: {
  resolve: (tenantId: string, projectId: string, environment: string) => Promise<any>;
} | null = null;

function hashJobIdPart(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function getDefaultQueueConfig(): ReencryptionQueueConfig {
  return {
    enabled: process.env.KMS_REENCRYPTION_QUEUE_ENABLED !== 'false',
    concurrency: 1,
    batchSize: 50,
    maxRetries: 3,
    jobTimeoutMs: 300_000,
  };
}

// =============================================================================
// INIT
// =============================================================================

async function initBullMQ(): Promise<boolean> {
  if (initialized) return !!bullQueue;
  initialized = true;

  const config = getDefaultQueueConfig();
  if (!config.enabled) {
    log.info('Re-encryption queue disabled');
    return false;
  }

  try {
    const { getRedisHandle, getRedisClient } = await import('../redis/redis-client.js');
    const handle = getRedisHandle();

    // Dynamic import BullMQ
    const bullmq = (await import('bullmq' as string)) as any;
    const { Queue, Worker } = bullmq;

    let queueConnection: any;
    let workerConnection: any;

    if (handle) {
      // Cluster-aware path: createBullMQPair builds fresh connections per-node.
      const { createBullMQPair } = await import('@agent-platform/redis');
      bullMQPair = createBullMQPair(handle);
      queueConnection = bullMQPair.queueConnection;
      workerConnection = bullMQPair.workerConnection;
    } else {
      // Standalone / test path: fall back to getRedisClient().duplicate() so that
      // tests that mock getRedisClient (but not getRedisHandle) still work.
      const client = getRedisClient();
      if (!client) {
        log.info('Re-encryption queue skipped — Redis not available');
        return false;
      }
      if (typeof (client as any).duplicate !== 'function') {
        log.info('Re-encryption queue skipped — Redis client has no duplicate() method');
        return false;
      }
      queueConnection = (client as any).duplicate({ maxRetriesPerRequest: null });
      workerConnection = (client as any).duplicate({ maxRetriesPerRequest: null });
      const _qConn = queueConnection;
      const _wConn = workerConnection;
      bullMQPair = {
        queueConnection,
        workerConnection,
        disconnect() {
          _qConn.quit?.().catch((err: unknown) => {
            log.warn('Queue connection quit error', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
          _wConn.quit?.().catch((err: unknown) => {
            log.warn('Worker connection quit error', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        },
      };
    }

    bullQueue = new Queue('kms-reencryption', {
      connection: queueConnection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      defaultJobOptions: {
        attempts: config.maxRetries,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 500, age: 86400 },
        removeOnFail: { count: 200, age: 604800 },
      },
    });

    bullWorker = new Worker(
      'kms-reencryption',
      async (job: any) => {
        if (shutdownRequested) return;
        await processReencryptionJob(job.data as ReencryptionJob, config.batchSize, job);
      },
      {
        connection: workerConnection,
        prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
        concurrency: config.concurrency,
        lockDuration: config.jobTimeoutMs,
      },
    );

    bullWorker.on('failed', (job: any, err: Error) => {
      log.error('Re-encryption job failed', {
        jobId: job?.id,
        tenantId: job?.data?.tenantId,
        error: err.message,
        attempts: job?.attemptsMade,
      });
    });

    bullWorker.on('completed', (job: any) => {
      log.info('Re-encryption job completed', {
        jobId: job?.id,
        tenantId: job?.data?.tenantId,
      });
    });

    log.info('Re-encryption queue initialized (BullMQ)');
    return true;
  } catch (err) {
    log.warn('Re-encryption queue init failed — jobs will be skipped', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// =============================================================================
// ENQUEUE
// =============================================================================

/**
 * Enqueue a re-encryption job.
 * Deduplicates by scope + reason + date to prevent redundant work.
 */
export async function enqueueReencryption(job: ReencryptionJob): Promise<string | null> {
  const ready = await initBullMQ();
  if (!ready || !bullQueue) {
    log.debug('Re-encryption queue not available — skipping job', {
      tenantId: job.tenantId,
    });
    return null;
  }

  const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  // BullMQ disallows ':' in custom job IDs — use '-' as separator.
  // For unscoped jobs we preserve the legacy jobId format so dedup still
  // works across pod generations during a rolling deploy (old pods produce
  // `reencrypt-{tenant}-{reason}-{date}`). Scoped jobs use an extended
  // format that includes the scope identifiers.
  const dedupeSuffix = job.dedupeKey ? `-${hashJobIdPart(job.dedupeKey)}` : '';
  const jobId =
    job.projectId || job.environment
      ? `reencrypt-${job.tenantId}-${job.projectId ?? '_all-projects'}-${job.environment ?? '_all-environments'}-${job.reason}${dedupeSuffix}-${dateKey}`
      : `reencrypt-${job.tenantId}-${job.reason}${dedupeSuffix}-${dateKey}`;

  try {
    const added = await bullQueue.add('reencrypt', job, { jobId });
    log.info('Enqueued re-encryption job', {
      jobId: added.id,
      tenantId: job.tenantId,
      projectId: job.projectId ?? null,
      environment: job.environment ?? null,
      reason: job.reason,
    });
    return added.id;
  } catch (err) {
    log.error('Failed to enqueue re-encryption job', {
      tenantId: job.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// =============================================================================
// WORKER LOGIC
// =============================================================================

async function processReencryptionJob(
  job: ReencryptionJob,
  batchSize: number,
  bullJob?: any,
): Promise<void> {
  const { tenantId, kekKeyId, projectId, environment } = job;

  log.info('Processing re-encryption job', {
    tenantId,
    projectId: projectId ?? null,
    environment: environment ?? null,
    reason: job.reason,
  });

  try {
    const { DEKEntry } = await import('@agent-platform/database/models');
    const { getKMSProviderPool } = await import('@agent-platform/database/kms');
    const { getGlobalKMSResolver } = await import('@agent-platform/database/kms');
    sharedResolver ??=
      getGlobalKMSResolver() ??
      (() => {
        throw new Error('Global KMS resolver not initialized — cannot process re-encryption jobs');
      })();
    const resolver = sharedResolver;
    const pool = getKMSProviderPool();

    // Find all DEKs for this tenant that need re-wrapping
    const query: Record<string, any> = {
      tenantId,
      status: { $in: ['active', 'decrypt_only'] },
    };
    if (projectId) {
      query.projectId = projectId;
    }
    if (environment) {
      query.environment = environment;
    }
    if (kekKeyId) {
      query.kekKeyId = kekKeyId;
    }

    const allDekIds = await DEKEntry.find(query).select('_id').sort({ epoch: 1, _id: 1 }).lean();
    const totalCount = allDekIds.length;
    let processed = 0;
    let errors = 0;
    log.info('Resolved re-encryption workload', {
      tenantId,
      projectId: projectId ?? null,
      environment: environment ?? null,
      reason: job.reason,
      totalCount,
      targetKekKeyId: kekKeyId ?? null,
    });

    // Process in batches
    while (processed < totalCount) {
      if (shutdownRequested) {
        log.info('Re-encryption interrupted by shutdown', { tenantId, processed });
        break;
      }

      const batchIds = allDekIds
        .slice(processed, processed + batchSize)
        .map((entry: any) => entry._id);
      const batch = await DEKEntry.find({ _id: { $in: batchIds } })
        .sort({ epoch: 1, _id: 1 })
        .lean();

      if (batch.length === 0) break;

      let processedThisBatch = 0;
      for (const dek of batch) {
        if (shutdownRequested) {
          log.info('Re-encryption interrupted during batch processing', {
            tenantId,
            processed,
            processedThisBatch,
          });
          break;
        }

        try {
          const dekDoc = dek as any;
          const targetConfig = await resolver.resolve(
            tenantId,
            dekDoc.projectId ?? '_tenant',
            dekDoc.environment ?? '_tenant',
          );
          const sourceProviderRef = dekDoc.wrappingProvider ?? {
            providerType: 'local',
            keyId: dekDoc.kekKeyId,
          };
          const sourceProvider =
            dekDoc.wrappingProvider != null
              ? await pool.getProvider(dekDoc.wrappingProvider)
              : pool.getLocalProvider();
          const targetProvider = await pool.getProvider(targetConfig.provider);

          // Unwrap with the provider that originally wrapped this DEK.
          const plaintext = await sourceProvider.unwrapKey(
            dekDoc.kekKeyId,
            Buffer.from(dekDoc.wrappedDek, 'base64'),
            dekDoc.kekKeyVersion,
            dekDoc.kekKeyVersionId ?? undefined,
          );

          // Re-wrap with the currently resolved provider for the DEK's scope.
          const targetKeyId = kekKeyId || targetConfig.keyId || dekDoc.kekKeyId;
          const { ciphertext, keyVersion, keyVersionId } = await targetProvider.wrapKey(
            targetKeyId,
            plaintext,
          );

          // ── Verification: unwrap the NEW ciphertext and compare to original ──
          // This prevents data loss if unwrap→rewrap produces different key material
          // (e.g., due to provider version mismatch or wire format change).
          const verification = await targetProvider.unwrapKey(
            targetKeyId,
            ciphertext,
            keyVersion,
            keyVersionId,
          );

          if (!plaintext.equals(verification)) {
            verification.fill(0);
            plaintext.fill(0);
            errors++;
            log.error(
              'Re-encryption verification FAILED — rewrapped DEK does not match original. Skipping to prevent data loss.',
              {
                dekId: dekDoc._id,
                dekIdentifier: dekDoc.epoch,
                tenantId,
                reason: job.reason,
                projectId: dekDoc.projectId ?? '_tenant',
                environment: dekDoc.environment ?? '_tenant',
                sourceProviderType: sourceProviderRef.providerType,
                sourceKeyId: dekDoc.kekKeyId,
                targetProviderType: targetConfig.provider.providerType,
                targetKeyId,
              },
            );
            continue;
          }
          verification.fill(0);

          // Zero-fill original plaintext
          plaintext.fill(0);

          // Atomic update with version check
          await DEKEntry.findOneAndUpdate(
            {
              _id: dekDoc._id,
              kekKeyVersion: dekDoc.kekKeyVersion, // Optimistic concurrency
            },
            {
              $set: {
                wrappedDek: ciphertext.toString('base64'),
                kekKeyId: targetKeyId,
                kekKeyVersion: keyVersion ?? dekDoc.kekKeyVersion,
                kekKeyVersionId: keyVersionId ?? null,
                wrappingProvider: targetConfig.provider,
                wrappingSourceConfigVersion: targetConfig.sourceConfigVersion,
              },
            },
          );
        } catch (err) {
          errors++;
          log.warn('Failed to re-encrypt DEK', {
            dekId: (dek as any)._id,
            dekIdentifier: (dek as any).epoch,
            tenantId,
            reason: job.reason,
            projectId: (dek as any).projectId ?? '_tenant',
            environment: (dek as any).environment ?? '_tenant',
            sourceProviderType: (dek as any).wrappingProvider?.providerType ?? 'local',
            sourceKeyId: (dek as any).kekKeyId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        processedThisBatch += 1;
      }

      processed += processedThisBatch;

      // Update job progress (for resumability)
      if (bullJob) {
        await bullJob.updateProgress(Math.round((processed / totalCount) * 100));
      }
    }

    const completedFully = processed >= totalCount;

    log.info(completedFully ? 'Re-encryption job finished' : 'Re-encryption job interrupted', {
      tenantId,
      total: totalCount,
      processed,
      errors,
      interrupted: !completedFully,
    });

    // Only stamp lastKekRotatedAt when the ENTIRE tenant was re-wrapped without
    // errors AND without an early shutdown break. Scoped runs must not advance
    // the tenant-wide rotation watermark.
    if (errors === 0 && completedFully && !projectId && !environment) {
      const { TenantKMSConfig } = await import('@agent-platform/database/models');
      await TenantKMSConfig.updateOne(
        { tenantId },
        { $set: { lastKekRotatedAt: new Date() } },
      ).catch((err: unknown) => {
        log.warn('Failed to update lastKekRotatedAt after re-encryption', {
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    const { logKMSAuditEvent } = await import('./kms-audit-logger.js');
    logKMSAuditEvent({
      tenantId,
      operation: 'batch_reencryption',
      keyId: kekKeyId || 'all',
      providerType: 'system',
      success: errors === 0 && completedFully,
      latencyMs: 0,
      metadata: {
        total: totalCount,
        processed,
        errors,
        interrupted: !completedFully,
        reason: job.reason,
        projectId: projectId ?? null,
        environment: environment ?? null,
      },
    });
  } catch (err) {
    try {
      const { logKMSAuditEvent } = await import('./kms-audit-logger.js');
      logKMSAuditEvent({
        tenantId,
        operation: 'batch_reencryption',
        keyId: kekKeyId || 'all',
        providerType: 'system',
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        latencyMs: 0,
        metadata: {
          reason: job.reason,
          fatal: true,
          projectId: projectId ?? null,
          environment: environment ?? null,
        },
      });
    } catch (auditErr) {
      log.warn('KMS audit log write failed after fatal re-encryption failure', {
        tenantId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
    log.error('Re-encryption job failed', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err; // Let BullMQ retry
  }
}

// =============================================================================
// SHUTDOWN
// =============================================================================

/**
 * Gracefully shut down the re-encryption queue.
 */
export async function shutdownReencryptionQueue(): Promise<void> {
  shutdownRequested = true;

  try {
    if (bullWorker) {
      await bullWorker.close();
      bullWorker = null;
    }
    if (bullQueue) {
      await bullQueue.close();
      bullQueue = null;
    }
    if (bullMQPair) {
      bullMQPair.disconnect();
      bullMQPair = null;
    }
    initialized = false;
    log.info('Re-encryption queue shut down');
  } catch (err) {
    log.warn('Re-encryption queue shutdown error', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
