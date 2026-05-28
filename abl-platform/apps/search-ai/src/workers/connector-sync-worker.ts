/**
 * Connector Sync Worker
 *
 * Background worker for connector sync operations (full and delta sync).
 * Runs connector sync as a long-running job with progress tracking.
 *
 * Job types:
 * - connector:full-sync — Full document enumeration and ingestion
 * - connector:delta-sync — Incremental sync using delta tokens
 *
 * Flow: API triggers job → Worker executes sync → Updates status in DB
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import type {
  IConnectorConfig,
  ISearchSource,
  ISearchDocument,
  ISearchIndex,
  IEndUserOAuthToken,
} from '@agent-platform/database/models';
import type { ISyncCheckpoint, IDriveDeltaToken } from '@agent-platform/database';
import { withTenantContext } from '@agent-platform/database/mongo';
import { getLazyModel } from '../db/index.js';
import {
  createQueue,
  createWorkerOptions,
  workerLog,
  workerError,
  runBestEffortWorkerSideEffect,
  createWorkerSideEffectFailure,
  getRedisConnection,
  withTraceContext,
} from './shared.js';
import type { IngestionJobData } from './shared.js';
import { SharePointConnector } from '@agent-platform/connector-sharepoint';
import type { SyncProgressCallback } from '@agent-platform/connectors-base';
import { CancellationChecker } from '@agent-platform/connectors-base';
import { QUEUE_INGESTION, QUEUE_DOCLING_EXTRACTION } from '@agent-platform/search-ai-sdk';
import { DistributedLockManager, type Lock } from '@agent-platform/shared-observability';
import { createSubscriber } from '@agent-platform/redis';
import type { RedisClient } from '@agent-platform/redis';
import { getSharedRedisClient, getSharedRedisHandle } from './shared.js';
import { writeAuditEntry } from '../services/connector-audit.service.js';

// Models bound to correct databases via dual-connection
const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
const SearchSource = getLazyModel<ISearchSource>('SearchSource');
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');
const SyncCheckpoint = getLazyModel<ISyncCheckpoint>('SyncCheckpoint');
const EndUserOAuthToken = getLazyModel<IEndUserOAuthToken>('EndUserOAuthToken');
const DriveDeltaToken = getLazyModel<IDriveDeltaToken>('DriveDeltaToken');
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');

// ============================================================================
// Queue Names
// ============================================================================

export const QUEUE_CONNECTOR_SYNC = 'connector-sync';

// ============================================================================
// Job Data Interface
// ============================================================================

export interface ConnectorSyncJobData {
  connectorId: string;
  tenantId: string;
  syncType: 'full' | 'delta';
  resumeFromCheckpoint?: boolean; // If true, look for existing checkpoint
}

// ============================================================================
// Progress Publisher
// ============================================================================

/**
 * Publishes sync progress events to Redis for WebSocket streaming.
 * Used by base-sync-coordinator progress callback.
 */
class SyncProgressPublisher {
  private redis: RedisClient | null;
  private jobId: string;
  private startTime: number;

  constructor(jobId: string) {
    this.jobId = jobId;
    this.startTime = Date.now();
    this.redis = getSharedRedisClient();
  }

  /**
   * Publish progress event to Redis channel.
   * WebSocket subscribers will receive this via `progress:${jobId}` channel.
   */
  async publish(data: {
    processedCount: number;
    totalCount?: number;
    currentResource: string;
    documentsPerSecond: number;
  }): Promise<void> {
    if (!this.redis) return;
    try {
      const elapsedMs = Date.now() - this.startTime;
      const elapsedMin = elapsedMs / 60000;
      const rate = data.processedCount / Math.max(elapsedMin, 0.1); // docs per minute

      // Calculate ETA if total known
      let eta: string | undefined;
      if (data.totalCount && data.totalCount > data.processedCount && rate > 0) {
        const remaining = data.totalCount - data.processedCount;
        const etaMin = remaining / rate;
        const etaDate = new Date(Date.now() + etaMin * 60000);
        eta = etaDate.toISOString();
      }

      const event = {
        type: 'documents_processed',
        jobId: this.jobId,
        timestamp: new Date().toISOString(),
        data: {
          currentDocument: data.currentResource,
          rate: Math.round(rate * 100) / 100, // Round to 2 decimals
          eta,
          progress: {
            total: data.totalCount || 0,
            completed: data.processedCount,
            failed: 0, // Not tracked in callback
            percentage:
              data.totalCount && data.totalCount > 0
                ? Math.round((data.processedCount / data.totalCount) * 100)
                : 0,
          },
        },
      };

      const channel = `progress:${this.jobId}`;
      await this.redis.publish(channel, JSON.stringify(event));
    } catch (error) {
      workerError('connector-sync', 'Failed to publish progress event', error);
      // Don't throw - progress publishing failures shouldn't stop sync
    }
  }

  /**
   * No-op — uses shared Redis client, which is managed at process level.
   */
  async close(): Promise<void> {
    // Shared client; nothing to close per-publisher.
  }
}

// ============================================================================
// Distributed Lock Setup
// ============================================================================

// Distributed lock manager (uses shared Redis client)
let lockManager: DistributedLockManager;

function ensureLockManager(): DistributedLockManager {
  if (!lockManager) {
    const client = getSharedRedisClient();
    if (!client) throw new Error('Redis not configured — cannot acquire distributed lock');
    lockManager = new DistributedLockManager(client);
  }
  return lockManager;
}

// ============================================================================
// Worker Processor
// ============================================================================

async function processConnectorSyncJob(job: Job<ConnectorSyncJobData>): Promise<void> {
  const { connectorId, tenantId, syncType, resumeFromCheckpoint } = job.data;

  workerLog('connector-sync', `Processing ${syncType} sync job ${job.id}`, {
    connectorId,
    tenantId,
    syncType,
    resumeFromCheckpoint,
  });

  await withTraceContext(job.data as unknown as Record<string, unknown>, () =>
    withTenantContext({ tenantId }, async () => {
      // 1. Load connector configuration to get indexId
      const config = await ConnectorConfig.findOne({ _id: connectorId, tenantId });
      if (!config) {
        throw new Error(`Connector ${connectorId} not found`);
      }

      // 2. Load SearchSource to get indexId
      const source = await SearchSource.findOne({ _id: config.sourceId, tenantId });
      if (!source) {
        throw new Error(`SearchSource ${config.sourceId} not found for connector ${connectorId}`);
      }

      const indexId = source.indexId;

      // 3. Acquire distributed lock (scoped to index + connector)
      // Lock key: sync-lock:${indexId}:${connectorId}
      const lockMgr = ensureLockManager();
      const lockResourceId = `${indexId}:${connectorId}`;
      const lock = await lockMgr.acquire(lockResourceId, {
        keyPrefix: 'sync-lock',
        ttlMs: 3600000, // 1 hour (matches typical max sync duration)
        retryAttempts: 0, // No retry - fail fast if already locked
      });

      if (!lock) {
        const existingLock = await lockMgr.isLocked(lockResourceId, 'sync-lock');
        workerError(
          'connector-sync',
          `Sync already in progress for connector ${connectorId} in index ${indexId}`,
          new Error(`Lock held by ${existingLock?.value}, expires at ${existingLock?.expiresAt}`),
        );
        throw new Error(
          `Connector ${connectorId} in index ${indexId} is already being synced by another worker. Please wait for completion or pause the existing sync.`,
        );
      }

      workerLog(
        'connector-sync',
        `Acquired sync lock for connector ${connectorId} in index ${indexId}`,
        {
          lockValue: lock.value,
          expiresAt: lock.expiresAt,
          indexId,
        },
      );

      // Declare resources at function scope so they're accessible in finally block
      let doclingQueue: any = null;
      let progressPublisher: SyncProgressPublisher | null = null;
      let cancellationChecker: CancellationChecker | null = null;

      try {
        // 4. Check if connector is paused
        if (config.errorState.isPaused && !resumeFromCheckpoint) {
          throw new Error('Connector is paused. Use resume endpoint to continue.');
        }

        try {
          // 4a. Set up cancellation checker with hybrid approach
          const handle = getSharedRedisHandle();
          const subscriberClient = handle ? createSubscriber(handle) : undefined;
          cancellationChecker = new CancellationChecker({
            connectorId,
            tenantId,
            jobId: job.id as string,
            redis: subscriberClient,
            connectorConfigModel: ConnectorConfig,
          });
          workerLog(
            'connector-sync',
            'Cancellation checker initialized (hybrid Redis + DB polling)',
          );

          // 3. Load checkpoint if resuming
          let checkpoint = null;
          if (resumeFromCheckpoint) {
            checkpoint = await SyncCheckpoint.findOne({
              tenantId,
              connectorId,
            }).sort({ checkpointedAt: -1 });

            if (checkpoint) {
              workerLog(
                'connector-sync',
                `Resuming from checkpoint at ${checkpoint.state.processedCount} documents`,
                {
                  connectorId,
                  checkpointId: checkpoint._id,
                },
              );
            }
          }

          // 4. Update sync state to in-progress
          await ConnectorConfig.findOneAndUpdate(
            { _id: connectorId, tenantId },
            {
              'syncState.currentJobId': job.id as string,
              'syncState.syncInProgress': true,
              'syncState.lastSyncError': null,
            },
          );

          // 4b. Write sync started audit entry
          await runBestEffortWorkerSideEffect(
            'connector-sync',
            'write sync.started audit entry',
            async () => {
              await writeAuditEntry({
                connectorId,
                tenantId,
                actor: 'system',
                actorType: 'system',
                event: 'sync.started',
                category: 'sync',
                metadata: { syncType, jobId: job.id },
              });
            },
          );

          // 5. Initialize connector
          let connector: any;

          switch (config.connectorType) {
            case 'sharepoint':
              // Create Docling extraction queue for document processing
              doclingQueue = createQueue(QUEUE_DOCLING_EXTRACTION);

              connector = new SharePointConnector(
                config.toObject(),
                EndUserOAuthToken,
                {
                  SearchDocument,
                  SearchSource,
                  SyncCheckpoint,
                  ConnectorConfig,
                  DriveDeltaToken,
                },
                doclingQueue,
              );
              await connector.initialize();
              break;
            default:
              throw new Error(`Unsupported connector type: ${config.connectorType}`);
          }

          // 6. Create progress publisher for real-time updates
          progressPublisher = new SyncProgressPublisher(job.id as string);

          // 7. Perform sync (with checkpoint and progress callback)
          let result;
          if (syncType === 'full') {
            result = await connector.performFullSync(
              checkpoint,
              (progress: Parameters<SyncProgressCallback>[0]) => {
                // Publish progress to Redis every time base-sync-coordinator reports
                void progressPublisher?.publish(progress);
              },
            );
          } else {
            result = await connector.performDeltaSync();
          }

          // 7. Handle paused sync
          if (result.paused) {
            workerLog('connector-sync', `Sync paused at ${result.documentsProcessed} documents`, {
              connectorId,
              checkpointId: result.checkpointId,
            });

            // Update sync state with paused status
            await ConnectorConfig.findOneAndUpdate(
              { _id: connectorId, tenantId },
              {
                'syncState.currentJobId': null,
                'syncState.syncInProgress': false,
                'syncState.processedDocuments': result.documentsProcessed,
                'syncState.failedDocuments': result.documentsFailed,
              },
            );

            return; // Exit gracefully
          }

          // 8. Update progress to 100%
          await job.updateProgress(100);

          // 9. Update sync state with success
          const now = new Date();
          await ConnectorConfig.findOneAndUpdate(
            { _id: connectorId, tenantId },
            {
              'syncState.currentJobId': null,
              'syncState.syncInProgress': false,
              'syncState.lastFullSyncAt':
                syncType === 'full' ? now : config.syncState.lastFullSyncAt,
              'syncState.lastDeltaSyncAt':
                syncType === 'delta' ? now : config.syncState.lastDeltaSyncAt,
              'syncState.totalDocuments': result.documentsProcessed,
              'syncState.processedDocuments': result.documentsProcessed,
              'syncState.failedDocuments': result.documentsFailed,
            },
          );

          // 10. Update SearchSource status to active + document count
          await SearchSource.findOneAndUpdate(
            { _id: config.sourceId, tenantId },
            {
              status: 'active',
              documentCount: result.documentsProcessed,
              lastSyncAt: now,
            },
          );

          // 11. Update SearchIndex document count
          if (result.documentsProcessed > 0) {
            await SearchIndex.findOneAndUpdate(
              { _id: indexId, tenantId },
              { $inc: { documentCount: result.documentsProcessed } },
            );
          }

          // 11. Trigger ingestion pipeline for synced documents
          if (result.documentsProcessed > 0) {
            const ingestionQueue = createQueue(QUEUE_INGESTION);
            try {
              // Build pre-configured field data from fieldConfig (if set before sync)
              let preConfiguredFields: IngestionJobData['preConfiguredFields'];
              if (config.fieldConfig?.fields?.length) {
                const selected = config.fieldConfig.fields.filter((f) => f.selected);
                const embedding = selected.filter((f) => f.includeInEmbedding);
                preConfiguredFields = {
                  selectedFields: selected.map((f) => f.sourcePath),
                  embeddingFields: embedding.map((f) => f.sourcePath),
                  fieldMappings: selected
                    .filter((f) => f.canonicalMapping)
                    .map((f) => ({
                      sourceField: f.sourcePath,
                      canonicalField: f.canonicalMapping!,
                      type: f.fieldType,
                      alias: f.displayName,
                    })),
                };
                workerLog(
                  'connector-sync',
                  `Using pre-sync field config: ${selected.length} fields selected, ${embedding.length} for embedding`,
                  { connectorId, indexId },
                );
              }

              const ingestionData: IngestionJobData = {
                jobId: `connector-ingest:${connectorId}:${Date.now()}`,
                indexId,
                sourceId: config.sourceId,
                tenantId,
                preConfiguredFields,
              };
              await ingestionQueue.add('connector-ingestion', ingestionData, {
                jobId: `connector-ingest:${connectorId}:${Date.now()}`,
                removeOnComplete: { age: 86400 },
                removeOnFail: { age: 604800 },
              });
              workerLog(
                'connector-sync',
                `Queued ingestion job for ${result.documentsProcessed} documents`,
                {
                  connectorId,
                  indexId,
                  sourceId: config.sourceId,
                },
              );
            } finally {
              await ingestionQueue.close();
            }
          }

          // 11. Clean up checkpoint on successful completion
          if (checkpoint) {
            await SyncCheckpoint.deleteOne({ _id: checkpoint._id });
            workerLog('connector-sync', 'Checkpoint deleted after successful completion', {
              connectorId,
            });
          }

          workerLog('connector-sync', `${syncType} sync completed successfully`, {
            connectorId,
            documentsProcessed: result.documentsProcessed,
            duration: result.durationMs,
          });

          // Write sync completed audit entry
          await runBestEffortWorkerSideEffect(
            'connector-sync',
            'write sync.completed audit entry',
            async () => {
              await writeAuditEntry({
                connectorId,
                tenantId,
                actor: 'system',
                actorType: 'system',
                event: 'sync.completed',
                category: 'sync',
                metadata: {
                  syncType,
                  docsAdded: result.documentsProcessed,
                  docsFailed: result.documentsFailed,
                  durationMs: result.durationMs,
                },
              });
            },
          );
        } catch (error) {
          // Update sync state with error
          const errMsg = error instanceof Error ? error.message : String(error);
          await ConnectorConfig.findOneAndUpdate(
            { _id: connectorId, tenantId },
            {
              'syncState.currentJobId': null,
              'syncState.syncInProgress': false,
              'syncState.lastSyncError': errMsg,
            },
          );

          // Update source status to error
          let errorToThrow: unknown = error;
          try {
            await SearchSource.findOneAndUpdate(
              { _id: config.sourceId, tenantId },
              { status: 'error', syncError: errMsg },
            );
          } catch (sourceStatusError) {
            workerError(
              'connector-sync',
              'Failed to mark source as errored after sync failure',
              sourceStatusError,
            );
            errorToThrow = createWorkerSideEffectFailure(
              error,
              'mark the source as errored after sync failure',
              sourceStatusError,
            );
          }

          workerError('connector-sync', `${syncType} sync failed`, error);

          // Write sync failed audit entry
          await runBestEffortWorkerSideEffect(
            'connector-sync',
            'write sync.failed audit entry',
            async () => {
              await writeAuditEntry({
                connectorId,
                tenantId,
                actor: 'system',
                actorType: 'system',
                event: 'sync.failed',
                category: 'sync',
                metadata: {
                  syncType,
                  error: error instanceof Error ? error.message : String(error),
                },
              });
            },
          );

          throw errorToThrow;
        } finally {
          // Cleanup cancellation checker
          if (cancellationChecker) {
            try {
              await cancellationChecker.cleanup();
              workerLog('connector-sync', 'Cleaned up cancellation checker');
            } catch (checkerCloseError) {
              workerError(
                'connector-sync',
                'Failed to cleanup cancellation checker',
                checkerCloseError,
              );
            }
          }

          // Close progress publisher
          if (progressPublisher) {
            try {
              await progressPublisher.close();
              workerLog('connector-sync', 'Closed progress publisher');
            } catch (publisherCloseError) {
              workerError(
                'connector-sync',
                'Failed to close progress publisher',
                publisherCloseError,
              );
            }
          }

          // Close docling queue if it was created
          if (doclingQueue) {
            try {
              await doclingQueue.close();
              workerLog('connector-sync', 'Closed docling extraction queue');
            } catch (queueCloseError) {
              workerError('connector-sync', 'Failed to close docling queue', queueCloseError);
            }
          }
        }
      } finally {
        // Always release lock, even on error
        const released = await lockMgr.release(lock);
        if (released) {
          workerLog(
            'connector-sync',
            `Released sync lock for connector ${connectorId} in index ${indexId}`,
            {
              lockValue: lock.value,
            },
          );
        } else {
          workerError(
            'connector-sync',
            `Failed to release lock for connector ${connectorId} in index ${indexId}`,
            new Error('Lock may have expired or been released by another process'),
          );
        }
      }
    }),
  );
}

// ============================================================================
// Worker Instance
// ============================================================================

export const connectorSyncWorker = new Worker(
  QUEUE_CONNECTOR_SYNC,
  processConnectorSyncJob,
  createWorkerOptions(1), // Process one sync at a time per worker
);

connectorSyncWorker.on('completed', (job) => {
  workerLog('connector-sync', `Job ${job.id} completed`);
});

connectorSyncWorker.on('failed', (job, err) => {
  workerError('connector-sync', `Job ${job?.id} failed`, err);
});

// ============================================================================
// Graceful Shutdown on SIGTERM
// ============================================================================

/**
 * Handle SIGTERM signal (Kubernetes pod shutdown).
 * Gives running job time to save checkpoint before exit.
 */
process.on('SIGTERM', async () => {
  workerLog('connector-sync', 'Received SIGTERM, initiating graceful shutdown');

  try {
    // Close worker (stops accepting new jobs)
    await connectorSyncWorker.close();
    workerLog('connector-sync', 'Worker closed gracefully');
  } catch (error) {
    workerError('connector-sync', 'Error during graceful shutdown', error);
  } finally {
    process.exit(0);
  }
});

export default connectorSyncWorker;
