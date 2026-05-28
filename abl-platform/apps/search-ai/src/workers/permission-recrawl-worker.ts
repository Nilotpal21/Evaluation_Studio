/**
 * Permission Recrawl Worker
 *
 * Background worker that periodically recrawls permissions for all connectors
 * with permission mode enabled.
 *
 * Schedule: Weekly (every Sunday at 2 AM)
 * Purpose: Keep permissions up-to-date as SharePoint permissions change
 *
 * Process:
 * 1. Find all connectors with permissionConfig.mode !== 'disabled'
 * 2. For each connector, trigger permission recrawl
 * 3. Track metrics (documentsProcessed, averageAccuracy, errors)
 * 4. Update connector's permissionConfig stats
 */

import { Queue, Worker, type Job } from 'bullmq';
import { BULLMQ_CLUSTER_SAFE_PREFIX, type RedisConnectionHandle } from '@agent-platform/redis';
import { createLogger } from '@abl/compiler/platform';
import { ConnectorConfig } from '@agent-platform/database';
import {
  QUEUE_CONNECTOR_PERMISSION_CRAWL,
  type ConnectorPermissionCrawlJobData,
} from './connector-permission-crawl-worker.js';
import { createQueue } from './shared.js';

const log = createLogger('permission-recrawl-worker');

// ============================================================================
// Job Data Types
// ============================================================================

export interface PermissionRecrawlJobData {
  connectorId: string;
  tenantId: string;
  trigger: 'scheduled' | 'manual' | 'post-sync';
}

export interface PermissionRecrawlResult {
  success: boolean;
  connectorId: string;
  documentsProcessed: number;
  averageAccuracy: number;
  durationMs: number;
  errors: string[];
}

// ============================================================================
// Queue Configuration
// ============================================================================

const QUEUE_NAME = 'permission-recrawl';
const WORKER_CONCURRENCY = 3; // Process 3 connectors concurrently

export function createPermissionRecrawlQueue(): Queue<PermissionRecrawlJobData> {
  return createQueue(QUEUE_NAME) as Queue<PermissionRecrawlJobData>;
}

// ============================================================================
// Worker Implementation
// ============================================================================

export function createPermissionRecrawlWorker(
  handle: RedisConnectionHandle,
): Worker<PermissionRecrawlJobData, PermissionRecrawlResult> {
  return new Worker<PermissionRecrawlJobData, PermissionRecrawlResult>(
    QUEUE_NAME,
    async (job: Job<PermissionRecrawlJobData>) => {
      const { connectorId, tenantId, trigger } = job.data;
      const startTime = Date.now();

      log.info('Starting recrawl', { connectorId, trigger });

      try {
        // Load connector config
        const config = await ConnectorConfig.findOne({
          _id: connectorId,
          tenantId,
        });

        if (!config) {
          throw new Error(`Connector ${connectorId} not found`);
        }

        // Verify permission mode is enabled
        if (config.permissionConfig.mode === 'disabled') {
          log.info('Skipping connector — permissions disabled', { connectorId });
          return {
            success: true,
            connectorId,
            documentsProcessed: 0,
            averageAccuracy: 0,
            durationMs: Date.now() - startTime,
            errors: [],
          };
        }

        // Trigger the existing permission crawl worker
        // This way we reuse all the existing logic and don't need to duplicate SharePoint-specific code
        const { createQueue: _createQueue } = await import('./shared.js');
        const crawlQueue = _createQueue(QUEUE_CONNECTOR_PERMISSION_CRAWL);

        const crawlJob = await crawlQueue.add(
          'permission-crawl',
          {
            connectorId,
            tenantId,
            mode: config.permissionConfig.mode,
          } as ConnectorPermissionCrawlJobData,
          {
            jobId: `recrawl-${connectorId}-${Date.now()}`,
            priority: trigger === 'manual' ? 1 : 5,
          },
        );

        // Wait for the crawl job to complete
        const { QueueEvents } = await import('bullmq');
        const queueEvents = new QueueEvents(QUEUE_CONNECTOR_PERMISSION_CRAWL, {
          connection: handle.duplicate({ maxRetriesPerRequest: null }),
          prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
        });
        await crawlJob.waitUntilFinished(queueEvents);
        await queueEvents.close();

        // Reload config to get updated stats
        const updatedConfig = await ConnectorConfig.findOne({
          _id: connectorId,
          tenantId,
        });

        if (!updatedConfig) {
          throw new Error(`Connector ${connectorId} not found after crawl`);
        }

        const result: PermissionRecrawlResult = {
          success: true,
          connectorId,
          documentsProcessed: updatedConfig.permissionConfig.documentsProcessed,
          averageAccuracy: updatedConfig.permissionConfig.averageAccuracy,
          durationMs: Date.now() - startTime,
          errors: updatedConfig.permissionConfig.lastCrawlError
            ? [updatedConfig.permissionConfig.lastCrawlError]
            : [],
        };

        log.info('Completed recrawl', {
          connectorId,
          documentsProcessed: result.documentsProcessed,
          averageAccuracy: result.averageAccuracy,
          durationMs: result.durationMs,
        });

        return result;
      } catch (error) {
        log.error('Failed to recrawl connector', {
          connectorId,
          error: error instanceof Error ? error.message : String(error),
        });

        // Update connector error state
        try {
          const config = await ConnectorConfig.findOne({ _id: connectorId, tenantId });
          if (config) {
            config.permissionConfig.crawlInProgress = false;
            config.permissionConfig.currentJobId = null;
            config.permissionConfig.lastCrawlError =
              error instanceof Error ? error.message : String(error);
            await config.save();
          }
        } catch (updateError) {
          log.error('Failed to update connector error state', {
            connectorId,
            error: updateError instanceof Error ? updateError.message : String(updateError),
          });
        }

        throw error;
      }
    },
    {
      connection: handle.duplicate({ maxRetriesPerRequest: null }),
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      concurrency: WORKER_CONCURRENCY,
      limiter: {
        max: 10, // Max 10 jobs per interval
        duration: 60000, // 1 minute
      },
    },
  );
}

// ============================================================================
// Batch Scheduler (called by the weekly cron)
// ============================================================================

export async function schedulePermissionRecrawlJobs(
  queue: Queue<PermissionRecrawlJobData>,
): Promise<void> {
  log.info('Starting scheduled permission recrawl scan');

  try {
    // Find all connectors with permission mode enabled
    const connectors = await ConnectorConfig.find({
      'permissionConfig.mode': 'enabled',
      'permissionConfig.crawlInProgress': false, // Don't queue if already in progress
    });

    log.info('Found connectors to recrawl', { count: connectors.length });

    // Enqueue a job for each connector
    for (const connector of connectors) {
      await queue.add(
        'recrawl',
        {
          connectorId: connector._id,
          tenantId: connector.tenantId,
          trigger: 'scheduled',
        },
        {
          jobId: `recrawl-${connector._id}-${Date.now()}`,
          priority: 5, // Lower priority than real-time crawls
        },
      );

      log.info('Enqueued recrawl job', { connectorId: connector._id });
    }

    log.info('Scheduled permission recrawl completed', { jobsEnqueued: connectors.length });
  } catch (error) {
    log.error('Failed to schedule permission recrawl jobs', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// ============================================================================
// Manual Trigger (for API endpoints)
// ============================================================================

export async function triggerManualRecrawl(
  queue: Queue<PermissionRecrawlJobData>,
  connectorId: string,
  tenantId: string,
): Promise<string> {
  log.info('Manual recrawl triggered', { connectorId });

  const job = await queue.add(
    'recrawl',
    {
      connectorId,
      tenantId,
      trigger: 'manual',
    },
    {
      jobId: `manual-recrawl-${connectorId}-${Date.now()}`,
      priority: 1, // High priority for manual triggers
    },
  );

  return job.id!; // jobId is guaranteed to be set from options above
}

// ============================================================================
// Post-Sync Trigger (called after delta/full sync)
// ============================================================================

export async function triggerPostSyncRecrawl(
  queue: Queue<PermissionRecrawlJobData>,
  connectorId: string,
  tenantId: string,
): Promise<void> {
  log.info('Post-sync recrawl triggered', { connectorId });

  // Check if connector has permission mode enabled
  const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId });
  if (!connector || connector.permissionConfig.mode === 'disabled') {
    log.info('Skipping post-sync recrawl — permissions disabled', { connectorId });
    return;
  }

  await queue.add(
    'recrawl',
    {
      connectorId,
      tenantId,
      trigger: 'post-sync',
    },
    {
      jobId: `post-sync-recrawl-${connectorId}-${Date.now()}`,
      priority: 3, // Medium priority
    },
  );
}
