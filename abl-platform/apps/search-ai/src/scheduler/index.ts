/**
 * Scheduled Jobs Orchestrator
 *
 * Manages recurring background jobs using BullMQ's repeat functionality.
 * Jobs are scheduled using cron expressions and run automatically.
 *
 * Current jobs:
 * - Connector delta sync (every hour)
 * - Delta token cleanup (weekly)
 * - Webhook subscription renewal (every 12 hours)
 * - Webhook subscription cleanup (daily at 2 AM)
 * - Attribute reconciliation (daily at 4 AM)
 */

import { Queue, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import type { IAttributeRegistry } from '@agent-platform/database/models';
import { createBullMQPair, BULLMQ_CLUSTER_SAFE_PREFIX } from '@agent-platform/redis/bullmq';
import type { BullMQConnectionPair } from '@agent-platform/redis/bullmq';
import { getSharedRedisHandle } from '../workers/shared.js';
import type { ReconciliationJobData } from '../workers/shared.js';
import { processReconciliationJob } from '../workers/reconciliation-processor.js';
import {
  renewExpiringWebhookSubscriptions,
  cleanupExpiredWebhookSubscriptions,
} from './webhook-renewal.js';
import { triggerStaleDeltaSyncs, cleanupOrphanedDeltaTokens } from './connector-delta-sync.js';
import { createLogger } from '@abl/compiler/platform';

// ─── Queue Names ────────────────────────────────────────────────────────

const QUEUE_DELTA_SYNC = 'scheduled-delta-sync';
const QUEUE_DELTA_CLEANUP = 'scheduled-delta-cleanup';
const QUEUE_WEBHOOK_RENEWAL = 'scheduled-webhook-renewal';
const QUEUE_WEBHOOK_CLEANUP = 'scheduled-webhook-cleanup';
const QUEUE_RECONCILIATION = 'scheduled-reconciliation';
const QUEUE_AUTO_PROMOTION = 'scheduled-auto-promotion';

// ─── Queue Instances ────────────────────────────────────────────────────

let deltaSyncQueue: Queue | null = null;
let deltaCleanupQueue: Queue | null = null;
let renewalQueue: Queue | null = null;
let cleanupQueue: Queue | null = null;
let deltaSyncWorker: Worker | null = null;
let deltaCleanupWorker: Worker | null = null;
let renewalWorker: Worker | null = null;
let cleanupWorker: Worker | null = null;
let reconciliationQueue: Queue | null = null;
let reconciliationWorker: Worker | null = null;
let autoPromotionQueue: Queue | null = null;
let autoPromotionWorker: Worker | null = null;

// ─── BullMQ Connection Pairs (one per queue/worker pair) ────────────────
// Each pair holds two dedicated Redis connections: one for the Queue (non-blocking)
// and one for the Worker (blocking BRPOPLPUSH). Sharing a single connection
// across Workers will starve normal commands in cluster mode.

let deltaSyncPair: BullMQConnectionPair | null = null;
let deltaCleanupPair: BullMQConnectionPair | null = null;
let renewalPair: BullMQConnectionPair | null = null;
let cleanupPair: BullMQConnectionPair | null = null;
let reconciliationPair: BullMQConnectionPair | null = null;
let autoPromotionPair: BullMQConnectionPair | null = null;

const schedulerLog = createLogger('scheduler');

// ─── Job Processors ─────────────────────────────────────────────────────

async function processDeltaSyncJob(job: Job): Promise<any> {
  schedulerLog.info(`Processing delta sync job ${job.id}`);
  return await triggerStaleDeltaSyncs();
}

async function processDeltaCleanupJob(job: Job): Promise<any> {
  schedulerLog.info(`Processing delta cleanup job ${job.id}`);
  return await cleanupOrphanedDeltaTokens();
}

async function processRenewalJob(job: Job): Promise<any> {
  schedulerLog.info(`Processing webhook renewal job ${job.id}`);
  return await renewExpiringWebhookSubscriptions();
}

async function processCleanupJob(job: Job): Promise<any> {
  schedulerLog.info(`Processing webhook cleanup job ${job.id}`);
  return await cleanupExpiredWebhookSubscriptions();
}

async function processAutoPromotionJob(job: Job): Promise<unknown> {
  schedulerLog.info('Processing auto-promotion job', { jobId: job.id });

  const { withTenantContext } = await import('@agent-platform/database/mongo');
  const { AttributeRegistry } = await import('@agent-platform/database/models');
  const { InteractionAggregator } =
    await import('../services/reconciliation/interaction-aggregator.js');
  const { evaluatePromotion } = await import('../services/reconciliation/auto-promoter.js');
  const { DEFAULT_RECONCILIATION_CONFIG } = await import('../services/reconciliation/types.js');

  const config = DEFAULT_RECONCILIATION_CONFIG;
  const aggregator = new InteractionAggregator();

  // Find distinct (tenantId, indexId) pairs with beta or approved attributes
  const pairs: Array<{ _id: { tenantId: string; indexId: string } }> =
    await AttributeRegistry.aggregate([
      { $match: { tier: { $in: ['beta', 'approved'] }, discoverySource: { $ne: 'admin_manual' } } },
      { $group: { _id: { tenantId: '$tenantId', indexId: '$indexId' } } },
      { $limit: 1000 },
    ]);

  let promoted = 0;
  let demoted = 0;
  let unchanged = 0;

  for (const pair of pairs) {
    const { tenantId, indexId } = pair._id;
    try {
      await withTenantContext({ tenantId }, async () => {
        const stats = await aggregator.aggregateInteractions(
          tenantId,
          indexId,
          config.interactionWindowDays,
        );

        const attributes = await AttributeRegistry.find({
          tenantId,
          indexId,
          tier: { $in: ['beta', 'approved'] },
          discoverySource: { $ne: 'admin_manual' },
        }).lean();

        for (const attr of attributes) {
          const interactionStat = stats.get(attr.attributeId);
          const decision = evaluatePromotion(attr as IAttributeRegistry, config, interactionStat);

          // Build a single $set to merge tier change + interaction stats in one write
          const updateFields: Record<string, unknown> = {};

          if (decision.action === 'promote' && attr.tier !== 'approved') {
            updateFields.tier = 'approved';
            promoted++;
          } else if (decision.action === 'demote' && attr.tier === 'approved') {
            updateFields.tier = 'beta';
            demoted++;
          } else {
            unchanged++;
          }

          if (interactionStat) {
            updateFields.uniqueUsers = interactionStat.uniqueUsers;
            updateFields.totalInteractions = interactionStat.impressions + interactionStat.clicks;
          }

          // Single updateOne: tier change + interaction stats in one write
          if (Object.keys(updateFields).length > 0) {
            await AttributeRegistry.updateOne({ _id: attr._id, tenantId }, { $set: updateFields });
          }
        }
      });
    } catch (error) {
      schedulerLog.error('Auto-promotion failed for index', {
        tenantId,
        indexId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  schedulerLog.info('Auto-promotion sweep complete', {
    promoted,
    demoted,
    unchanged,
    indexCount: pairs.length,
  });
  return { success: true, promoted, demoted, unchanged };
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Start all scheduled jobs.
 * Sets up repeating jobs with cron expressions.
 */
export async function startScheduledJobs(): Promise<void> {
  const handle = getSharedRedisHandle();
  if (!handle) throw new Error('[scheduler] Redis not configured');

  schedulerLog.info('Starting scheduled jobs');

  // ── 1. Connector Delta Sync (every hour) ────────────────────────────
  deltaSyncPair = createBullMQPair(handle);
  deltaSyncQueue = new Queue(QUEUE_DELTA_SYNC, {
    connection: deltaSyncPair.queueConnection,
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
  });
  deltaSyncWorker = new Worker(QUEUE_DELTA_SYNC, processDeltaSyncJob, {
    connection: deltaSyncPair.workerConnection,
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    concurrency: 1, // Only one delta sync job at a time
  });

  // Add repeating job (every hour at minute 0)
  await deltaSyncQueue.add(
    'trigger-delta-syncs',
    {},
    {
      repeat: {
        pattern: '0 * * * *', // Every hour
      },
      jobId: 'delta-sync-recurring', // Prevents duplicates
    },
  );

  deltaSyncWorker.on('completed', (job) => {
    schedulerLog.info(`Delta sync job ${job.id} completed`);
  });

  deltaSyncWorker.on('failed', (job, error) => {
    schedulerLog.error(`Delta sync job ${job?.id} failed`, { error: error.message });
  });

  schedulerLog.info('Delta sync job scheduled (every hour)');

  // ── 2. Delta Token Cleanup (weekly on Sunday at 3 AM) ───────────────
  deltaCleanupPair = createBullMQPair(handle);
  deltaCleanupQueue = new Queue(QUEUE_DELTA_CLEANUP, {
    connection: deltaCleanupPair.queueConnection,
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
  });
  deltaCleanupWorker = new Worker(QUEUE_DELTA_CLEANUP, processDeltaCleanupJob, {
    connection: deltaCleanupPair.workerConnection,
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    concurrency: 1, // Only one cleanup job at a time
  });

  // Add repeating job (weekly on Sunday at 3:00 AM)
  await deltaCleanupQueue.add(
    'cleanup-delta-tokens',
    {},
    {
      repeat: {
        pattern: '0 3 * * 0', // Sunday at 3 AM
      },
      jobId: 'delta-cleanup-recurring', // Prevents duplicates
    },
  );

  deltaCleanupWorker.on('completed', (job) => {
    schedulerLog.info(`Delta cleanup job ${job.id} completed`);
  });

  deltaCleanupWorker.on('failed', (job, error) => {
    schedulerLog.error(`Delta cleanup job ${job?.id} failed`, { error: error.message });
  });

  schedulerLog.info('Delta cleanup job scheduled (weekly on Sunday at 3 AM)');

  // ── 3. Webhook Renewal (every 12 hours) ─────────────────────────────
  renewalPair = createBullMQPair(handle);
  renewalQueue = new Queue(QUEUE_WEBHOOK_RENEWAL, {
    connection: renewalPair.queueConnection,
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
  });
  renewalWorker = new Worker(QUEUE_WEBHOOK_RENEWAL, processRenewalJob, {
    connection: renewalPair.workerConnection,
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    concurrency: 1, // Only one renewal job at a time
  });

  // Add repeating job (every 12 hours at minute 0)
  await renewalQueue.add(
    'renew-webhooks',
    {},
    {
      repeat: {
        pattern: '0 */12 * * *', // Every 12 hours
      },
      jobId: 'webhook-renewal-recurring', // Prevents duplicates
    },
  );

  renewalWorker.on('completed', (job) => {
    schedulerLog.info(`Webhook renewal job ${job.id} completed`);
  });

  renewalWorker.on('failed', (job, error) => {
    schedulerLog.error(`Webhook renewal job ${job?.id} failed`, { error: error.message });
  });

  schedulerLog.info('Webhook renewal job scheduled (every 12 hours)');

  // ── 4. Webhook Cleanup (daily at 2 AM) ──────────────────────────────
  cleanupPair = createBullMQPair(handle);
  cleanupQueue = new Queue(QUEUE_WEBHOOK_CLEANUP, {
    connection: cleanupPair.queueConnection,
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
  });
  cleanupWorker = new Worker(QUEUE_WEBHOOK_CLEANUP, processCleanupJob, {
    connection: cleanupPair.workerConnection,
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    concurrency: 1, // Only one cleanup job at a time
  });

  // Add repeating job (daily at 2:00 AM)
  await cleanupQueue.add(
    'cleanup-webhooks',
    {},
    {
      repeat: {
        pattern: '0 2 * * *', // Daily at 2 AM
      },
      jobId: 'webhook-cleanup-recurring', // Prevents duplicates
    },
  );

  cleanupWorker.on('completed', (job) => {
    schedulerLog.info(`Webhook cleanup job ${job.id} completed`);
  });

  cleanupWorker.on('failed', (job, error) => {
    schedulerLog.error(`Webhook cleanup job ${job?.id} failed`, { error: error.message });
  });

  schedulerLog.info('Webhook cleanup job scheduled (daily at 2 AM)');

  // ── 5. Reconciliation (daily at 4 AM) ──────────────────────────────
  reconciliationPair = createBullMQPair(handle);
  reconciliationQueue = new Queue(QUEUE_RECONCILIATION, {
    connection: reconciliationPair.queueConnection,
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
  });
  reconciliationWorker = new Worker(QUEUE_RECONCILIATION, processReconciliationJob, {
    connection: reconciliationPair.workerConnection,
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    concurrency: 1, // Only one reconciliation job at a time
  });

  await reconciliationQueue.add(
    'reconcile-attributes',
    {},
    {
      repeat: {
        pattern: '0 4 * * *', // Daily at 4 AM
      },
      jobId: 'reconciliation-recurring', // Prevents duplicates
    },
  );

  reconciliationWorker.on('completed', (job) => {
    schedulerLog.info(`Reconciliation job ${job.id} completed`, {
      returnvalue: job.returnvalue,
    });
  });

  reconciliationWorker.on('failed', (job, error) => {
    schedulerLog.error(`Reconciliation job ${job?.id} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  schedulerLog.info('Reconciliation job scheduled (daily at 4 AM)');

  // ── 6. Auto-Promotion (daily at 5 AM) ──────────────────────────────
  autoPromotionPair = createBullMQPair(handle);
  autoPromotionQueue = new Queue(QUEUE_AUTO_PROMOTION, {
    connection: autoPromotionPair.queueConnection,
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
  });
  autoPromotionWorker = new Worker(QUEUE_AUTO_PROMOTION, processAutoPromotionJob, {
    connection: autoPromotionPair.workerConnection,
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    concurrency: 1,
  });

  await autoPromotionQueue.add(
    'auto-promote-attributes',
    {},
    {
      repeat: {
        pattern: '0 5 * * *', // Daily at 5 AM
      },
      jobId: 'auto-promotion-recurring',
    },
  );

  autoPromotionWorker.on('completed', (job) => {
    schedulerLog.info(`Auto-promotion job ${job.id} completed`, {
      returnvalue: job.returnvalue,
    });
  });

  autoPromotionWorker.on('failed', (job, error) => {
    schedulerLog.error(`Auto-promotion job ${job?.id} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  schedulerLog.info('Auto-promotion job scheduled (daily at 5 AM)');
}

/**
 * Stop all scheduled jobs and close workers.
 */
export async function stopScheduledJobs(): Promise<void> {
  schedulerLog.info('Stopping scheduled jobs');

  // Remove repeating jobs
  if (deltaSyncQueue) {
    await deltaSyncQueue.removeRepeatable('trigger-delta-syncs', {
      pattern: '0 * * * *',
    });
  }

  if (deltaCleanupQueue) {
    await deltaCleanupQueue.removeRepeatable('cleanup-delta-tokens', {
      pattern: '0 3 * * 0',
    });
  }

  if (renewalQueue) {
    await renewalQueue.removeRepeatable('renew-webhooks', {
      pattern: '0 */12 * * *',
    });
  }

  if (cleanupQueue) {
    await cleanupQueue.removeRepeatable('cleanup-webhooks', {
      pattern: '0 2 * * *',
    });
  }

  if (reconciliationQueue) {
    await reconciliationQueue.removeRepeatable('reconcile-attributes', {
      pattern: '0 4 * * *',
    });
  }

  if (autoPromotionQueue) {
    await autoPromotionQueue.removeRepeatable('auto-promote-attributes', {
      pattern: '0 5 * * *',
    });
  }

  // Close workers
  if (deltaSyncWorker) {
    await deltaSyncWorker.close();
    deltaSyncWorker = null;
  }

  if (deltaCleanupWorker) {
    await deltaCleanupWorker.close();
    deltaCleanupWorker = null;
  }

  if (renewalWorker) {
    await renewalWorker.close();
    renewalWorker = null;
  }

  if (cleanupWorker) {
    await cleanupWorker.close();
    cleanupWorker = null;
  }

  if (reconciliationWorker) {
    await reconciliationWorker.close();
    reconciliationWorker = null;
  }

  if (autoPromotionWorker) {
    await autoPromotionWorker.close();
    autoPromotionWorker = null;
  }

  // Close queues
  if (deltaSyncQueue) {
    await deltaSyncQueue.close();
    deltaSyncQueue = null;
  }

  if (deltaCleanupQueue) {
    await deltaCleanupQueue.close();
    deltaCleanupQueue = null;
  }

  if (renewalQueue) {
    await renewalQueue.close();
    renewalQueue = null;
  }

  if (cleanupQueue) {
    await cleanupQueue.close();
    cleanupQueue = null;
  }

  if (reconciliationQueue) {
    await reconciliationQueue.close();
    reconciliationQueue = null;
  }

  if (autoPromotionQueue) {
    await autoPromotionQueue.close();
    autoPromotionQueue = null;
  }

  // Disconnect per-pair connections after queues/workers are closed
  await deltaSyncPair?.disconnect();
  deltaSyncPair = null;
  await deltaCleanupPair?.disconnect();
  deltaCleanupPair = null;
  await renewalPair?.disconnect();
  renewalPair = null;
  await cleanupPair?.disconnect();
  cleanupPair = null;
  await reconciliationPair?.disconnect();
  reconciliationPair = null;
  await autoPromotionPair?.disconnect();
  autoPromotionPair = null;

  schedulerLog.info('All scheduled jobs stopped');
}

/**
 * Get status of scheduled jobs.
 */
export function getScheduledJobsStatus(): {
  running: boolean;
  jobs: Array<{ name: string; active: boolean }>;
} {
  return {
    running:
      deltaSyncWorker !== null ||
      deltaCleanupWorker !== null ||
      renewalWorker !== null ||
      cleanupWorker !== null ||
      reconciliationWorker !== null ||
      autoPromotionWorker !== null,
    jobs: [
      { name: 'delta-sync', active: deltaSyncWorker !== null },
      { name: 'delta-cleanup', active: deltaCleanupWorker !== null },
      { name: 'webhook-renewal', active: renewalWorker !== null },
      { name: 'webhook-cleanup', active: cleanupWorker !== null },
      { name: 'reconciliation', active: reconciliationWorker !== null },
      { name: 'auto-promotion', active: autoPromotionWorker !== null },
    ],
  };
}
