/**
 * Webhook Notification Worker
 *
 * Processes Microsoft Graph webhook notifications for SharePoint connector real-time updates.
 * Receives notifications from the webhook receiver endpoint and triggers delta sync
 * for the affected drive.
 *
 * Flow: webhook notification → deduplicate → trigger delta sync → update subscription
 */

import { Worker, Queue } from 'bullmq';
import type { Job } from 'bullmq';
import { ConnectorConfig } from '@agent-platform/database';
import { withTenantContext } from '@agent-platform/database/mongo';
import {
  createWorkerOptions,
  workerLog,
  workerError,
  withTraceContext,
  getRedisConnection,
} from './shared.js';
import type { WebhookNotificationJobData, WebhookNotificationBatchJobData } from './shared.js';
import { BULLMQ_CLUSTER_SAFE_PREFIX, type RedisClient } from '@agent-platform/redis';
import { getSharedRedisClient } from './shared.js';
import { QUEUE_CONNECTOR_SYNC } from './connector-sync-worker.js';

const QUEUE_NAME = 'webhook-notification';

// Redis client for deduplication cache (uses shared cluster-safe client)
let redisClient: RedisClient | null = null;

// Singleton Queue for enqueueing connector sync jobs (avoids leaking Redis connections)
let syncQueueInstance: Queue | null = null;
function getSyncQueue(): Queue {
  if (!syncQueueInstance) {
    syncQueueInstance = new Queue(QUEUE_CONNECTOR_SYNC, {
      connection: getRedisConnection(),
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    });
  }
  return syncQueueInstance;
}

// ─── Deduplication ──────────────────────────────────────────────────────

/**
 * Check if notification has already been processed recently.
 * Uses Redis cache with 5-minute TTL to prevent duplicate processing.
 *
 * @returns true if notification is a duplicate
 */
async function isDuplicateNotification(
  connectorId: string,
  subscriptionId: string,
  resource: string,
): Promise<boolean> {
  if (!redisClient) {
    redisClient = getSharedRedisClient();
  }
  if (!redisClient) return false; // Redis unavailable — allow through

  const cacheKey = `webhook:dedup:${connectorId}:${subscriptionId}:${resource}`;
  const exists = await redisClient.exists(cacheKey);

  if (exists) {
    return true;
  }

  // Mark as processed with 5-minute TTL
  await redisClient.setex(cacheKey, 300, '1');
  return false;
}

// ─── Worker Processor ───────────────────────────────────────────────────

async function processWebhookNotification(job: Job<WebhookNotificationJobData>): Promise<void> {
  const { connectorId, tenantId, subscriptionId, changeType, resource, driveId } = job.data;

  workerLog('webhook-notification', `Processing webhook notification ${job.id}`, {
    connectorId,
    subscriptionId,
    changeType,
    resource,
    driveId,
  });

  await withTraceContext(job.data as unknown as Record<string, unknown>, () =>
    withTenantContext({ tenantId }, async () => {
      // Ensure Redis client is initialized
      if (!redisClient) {
        redisClient = getSharedRedisClient();
      }

      // ── 1. Check for duplicates ─────────────────────────────────────────
      const isDuplicate = await isDuplicateNotification(connectorId, subscriptionId, resource);

      if (isDuplicate) {
        workerLog('webhook-notification', 'Skipping duplicate notification', {
          connectorId,
          subscriptionId,
        });
        return;
      }

      // ── 2. Load connector ───────────────────────────────────────────────
      const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId });

      if (!connector) {
        throw new Error(`Connector ${connectorId} not found for tenant ${tenantId}`);
      }

      if (connector.errorState.isPaused) {
        workerLog('webhook-notification', 'Connector is paused, skipping notification', {
          connectorId,
        });
        return;
      }

      // ── 3. Trigger delta sync for affected drive ───────────────────────
      if (!driveId) {
        workerLog('webhook-notification', 'No driveId in notification, skipping delta sync', {
          connectorId,
          resource,
        });
        return;
      }

      if (!redisClient) {
        workerLog('webhook-notification', 'Redis unavailable, skipping debounce check', {
          connectorId,
        });
      }

      // ── 4. Check debouncing (prevent sync churn during bulk operations) ──
      const lastSyncKey = `webhook:last-sync:${connectorId}`;
      const lastSyncTimestamp = redisClient ? await redisClient.get(lastSyncKey) : null;

      if (lastSyncTimestamp) {
        const timeSinceLastSync = Date.now() - parseInt(lastSyncTimestamp);
        const DEBOUNCE_WINDOW_MS = 30000; // 30 seconds

        if (timeSinceLastSync < DEBOUNCE_WINDOW_MS) {
          workerLog('webhook-notification', 'Debouncing: sync triggered recently, skipping', {
            connectorId,
            timeSinceLastSyncMs: timeSinceLastSync,
            debounceWindowMs: DEBOUNCE_WINDOW_MS,
          });
          return;
        }
      }

      // Mark sync as triggered (60s TTL allows cooldown after job completes)
      if (redisClient) {
        await redisClient.setex(lastSyncKey, 60, Date.now().toString());
      }

      // ── 5. Enqueue delta sync job ──────────────────────────────────────
      // The job will process changes for the specific drive that triggered the webhook
      const syncQueue = getSyncQueue();

      workerLog('webhook-notification', 'Enqueueing delta sync job', {
        connectorId,
        driveId,
        changeType,
      });

      await syncQueue.add(
        'connector-delta-sync',
        {
          connectorId,
          tenantId,
          syncType: 'delta',
        },
        {
          // Fixed jobId prevents duplicate sync jobs for the same connector
          // BullMQ automatically rejects duplicate jobs with same jobId
          jobId: `delta-sync-${connectorId}`,
          // Remove job from queue after completion
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );

      workerLog('webhook-notification', 'Delta sync job enqueued successfully', {
        connectorId,
        driveId,
      });

      workerLog('webhook-notification', 'Successfully processed notification', {
        connectorId,
        driveId,
      });
    }),
  );
}

// ─── Batch Processor ────────────────────────────────────────────────────

async function processWebhookNotificationBatch(
  job: Job<WebhookNotificationBatchJobData>,
): Promise<void> {
  const { connectorId, tenantId, notifications } = job.data;

  workerLog('webhook-notification', `Processing webhook notification batch ${job.id}`, {
    connectorId,
    batchSize: notifications.length,
  });

  await withTraceContext(job.data as unknown as Record<string, unknown>, () =>
    withTenantContext({ tenantId }, async () => {
      // Ensure Redis client is initialized
      if (!redisClient) {
        redisClient = getSharedRedisClient();
      }

      // ── 1. Deduplicate notifications in batch ───────────────────────────
      const uniqueNotifications = [];
      for (const notification of notifications) {
        const isDuplicate = await isDuplicateNotification(
          connectorId,
          notification.subscriptionId,
          notification.resource,
        );

        if (!isDuplicate) {
          uniqueNotifications.push(notification);
        }
      }

      if (uniqueNotifications.length === 0) {
        workerLog('webhook-notification', 'All notifications in batch are duplicates', {
          connectorId,
          batchSize: notifications.length,
        });
        return;
      }

      workerLog('webhook-notification', 'Batch after deduplication', {
        connectorId,
        original: notifications.length,
        unique: uniqueNotifications.length,
      });

      // ── 2. Load connector ───────────────────────────────────────────────
      const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId });

      if (!connector) {
        throw new Error(`Connector ${connectorId} not found for tenant ${tenantId}`);
      }

      if (connector.errorState.isPaused) {
        workerLog('webhook-notification', 'Connector is paused, skipping batch', {
          connectorId,
        });
        return;
      }

      // ── 3. Check debouncing (prevent sync churn) ────────────────────────
      const lastSyncKey = `webhook:last-sync:${connectorId}`;
      const lastSyncTimestamp = redisClient ? await redisClient.get(lastSyncKey) : null;

      if (lastSyncTimestamp) {
        const timeSinceLastSync = Date.now() - parseInt(lastSyncTimestamp);
        const DEBOUNCE_WINDOW_MS = 30000; // 30 seconds

        if (timeSinceLastSync < DEBOUNCE_WINDOW_MS) {
          workerLog('webhook-notification', 'Debouncing: sync triggered recently, skipping batch', {
            connectorId,
            timeSinceLastSyncMs: timeSinceLastSync,
            debounceWindowMs: DEBOUNCE_WINDOW_MS,
          });
          return;
        }
      }

      // Mark sync as triggered (60s TTL)
      if (redisClient) {
        await redisClient.setex(lastSyncKey, 60, Date.now().toString());
      }

      // ── 4. Enqueue delta sync job ──────────────────────────────────────
      const syncQueue = getSyncQueue();

      const driveIds = uniqueNotifications
        .map((n) => n.driveId)
        .filter((id): id is string => id !== undefined);

      workerLog('webhook-notification', 'Enqueueing delta sync job for batch', {
        connectorId,
        uniqueNotifications: uniqueNotifications.length,
        affectedDrives: new Set(driveIds).size,
      });

      await syncQueue.add(
        'connector-delta-sync',
        {
          connectorId,
          tenantId,
          syncType: 'delta',
        },
        {
          // Fixed jobId prevents duplicate sync jobs for the same connector
          jobId: `delta-sync-${connectorId}`,
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );

      workerLog('webhook-notification', 'Delta sync job enqueued successfully for batch', {
        connectorId,
        batchSize: uniqueNotifications.length,
      });

      workerLog('webhook-notification', 'Successfully processed notification batch', {
        connectorId,
        originalBatchSize: notifications.length,
        processedCount: uniqueNotifications.length,
      });
    }),
  );
}

// ─── Worker Factory ─────────────────────────────────────────────────────

export function createWebhookNotificationWorker(concurrency = 10): Worker {
  // Router function to handle both job types
  async function processJob(
    job: Job<WebhookNotificationJobData | WebhookNotificationBatchJobData>,
  ) {
    if (job.name === 'process-batch') {
      return processWebhookNotificationBatch(job as Job<WebhookNotificationBatchJobData>);
    } else {
      return processWebhookNotification(job as Job<WebhookNotificationJobData>);
    }
  }

  const worker = new Worker(QUEUE_NAME, processJob, createWorkerOptions(concurrency));

  worker.on('completed', (job) => {
    workerLog('webhook-notification', `Job ${job.id} (${job.name}) completed`);
  });

  worker.on('failed', (job, error) => {
    if (job) {
      workerError('webhook-notification', `Job ${job.id} (${job.name}) failed`, error);
    } else {
      workerError('webhook-notification', 'Job failed (job object is null)', error);
    }
  });

  workerLog('webhook-notification', `Worker started (concurrency=${concurrency})`);
  return worker;
}

export default createWebhookNotificationWorker;
