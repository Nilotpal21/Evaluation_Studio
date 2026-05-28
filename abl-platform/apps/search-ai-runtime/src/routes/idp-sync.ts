/**
 * IdP Sync API Routes
 *
 * Endpoints for triggering and monitoring IdP user/group sync jobs.
 * Allows manual sync triggers and sync status checking.
 *
 * Routes:
 * - POST /api/idp/sync/trigger — Manually trigger IdP sync (full or delta)
 * - GET /api/idp/sync/status — Get sync status for tenant
 * - POST /api/idp/sync/schedule — Configure scheduled sync (daily/weekly)
 * - POST /api/idp/sync/invalidate-cache — Clear group membership cache
 */

import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { Queue, type Job } from 'bullmq';
import {
  QUEUE_AZUREAD_USER_SYNC,
  QUEUE_AZUREAD_GROUP_SYNC,
  QUEUE_OKTA_USER_SYNC,
  QUEUE_OKTA_GROUP_SYNC,
  QUEUE_GOOGLE_USER_SYNC,
  QUEUE_GOOGLE_GROUP_SYNC,
} from '@agent-platform/search-ai-sdk';
import { createLogger } from '@abl/compiler/platform';
import { createRedisConnection, resolveRedisOptionsFromEnv } from '@agent-platform/redis';
import {
  createBullMQPair,
  BULLMQ_CLUSTER_SAFE_PREFIX,
  type BullMQConnectionPair,
} from '@agent-platform/redis/bullmq';
import mongoose from 'mongoose';
import type { ILLMCredential } from '@agent-platform/database/models';
import { getGroupMembershipCache } from '../services/cache/group-membership-cache.js';
import { getGlobalRedisClient } from '../services/cache/redis-client.js';

const logger = createLogger('idp-sync-routes');

/**
 * Create a short-lived BullMQ connection pair for enqueuing IDP sync jobs.
 * Returns null if Redis is not configured.
 */
function createIdpQueuePair(): BullMQConnectionPair | null {
  const opts = resolveRedisOptionsFromEnv();
  if (!opts) return null;
  const handle = createRedisConnection(opts);
  return createBullMQPair(handle);
}

export function createIdPSyncRouter(): RouterType {
  const router: RouterType = Router();
  router.use(authMiddleware);
  /**
   * POST /api/idp/sync/trigger
   *
   * Manually trigger IdP sync for a tenant.
   *
   * Body:
   *   provider: 'azuread' | 'okta' | 'google'
   *   syncMode: 'full' | 'delta'
   *   credentialId: string (LLMCredential ID with IdP API token)
   */
  router.post('/trigger', async (req, res) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ success: false, error: 'Missing tenant context' });
        return;
      }
      const tenantId = req.tenantContext.tenantId;
      const { provider, syncMode, credentialId } = req.body;

      // Validate input
      if (!['azuread', 'okta', 'google'].includes(provider)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_PROVIDER',
            message: 'Provider must be azuread, okta, or google',
          },
        });
        return;
      }

      if (!['full', 'delta'].includes(syncMode)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_SYNC_MODE',
            message: 'Sync mode must be full or delta',
          },
        });
        return;
      }

      if (!credentialId) {
        res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_CREDENTIAL_ID',
            message: 'credentialId is required',
          },
        });
        return;
      }

      // Verify credential exists
      const LLMCredential = mongoose.model<ILLMCredential>('LLMCredential');
      const credential = await LLMCredential.findOne({
        _id: credentialId,
        tenantId,
        isActive: true,
      });

      if (!credential) {
        res.status(404).json({
          success: false,
          error: {
            code: 'CREDENTIAL_NOT_FOUND',
            message: `Credential ${credentialId} not found or inactive`,
          },
        });
        return;
      }

      // Get delta token from credential metadata (if delta sync)
      // Note: metadata field not in ILLMCredential interface but exists in DB
      const credentialWithMetadata = credential as any;
      const deltaToken =
        syncMode === 'delta'
          ? provider === 'azuread'
            ? credentialWithMetadata.metadata?.azureadUserSyncDeltaToken
            : provider === 'okta'
              ? credentialWithMetadata.metadata?.oktaUserSyncDeltaToken
              : credentialWithMetadata.metadata?.googleUserSyncDeltaToken
          : undefined;

      // Trigger user sync and group sync jobs
      const userQueueName =
        provider === 'azuread'
          ? QUEUE_AZUREAD_USER_SYNC
          : provider === 'okta'
            ? QUEUE_OKTA_USER_SYNC
            : QUEUE_GOOGLE_USER_SYNC;

      const groupQueueName =
        provider === 'azuread'
          ? QUEUE_AZUREAD_GROUP_SYNC
          : provider === 'okta'
            ? QUEUE_OKTA_GROUP_SYNC
            : QUEUE_GOOGLE_GROUP_SYNC;

      const pair = createIdpQueuePair();
      if (!pair) {
        res.status(503).json({
          success: false,
          error: { code: 'REDIS_UNAVAILABLE', message: 'Queue service unavailable' },
        });
        return;
      }

      const userQueue = new Queue(userQueueName, {
        connection: pair.queueConnection,
        prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      });
      const groupQueue = new Queue(groupQueueName, {
        connection: pair.workerConnection,
        prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      });

      try {
        // Add user sync job
        const userJob = await userQueue.add(
          `${provider}-user-sync`,
          {
            tenantId,
            credentialId,
            syncMode,
            deltaToken,
          },
          {
            jobId: `${provider}-user-sync:${tenantId}:${Date.now()}`,
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 5000,
            },
          },
        );

        // Add group sync job (runs after user sync completes)
        const groupJob = await groupQueue.add(
          `${provider}-group-sync`,
          {
            tenantId,
            credentialId,
            syncMode,
            deltaToken,
          },
          {
            jobId: `${provider}-group-sync:${tenantId}:${Date.now()}`,
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 5000,
            },
          },
        );

        logger.info('IdP sync triggered', {
          tenantId,
          provider,
          syncMode,
          userJobId: userJob.id,
          groupJobId: groupJob.id,
        });

        res.json({
          success: true,
          data: {
            provider,
            syncMode,
            jobs: {
              userSync: { id: userJob.id, queue: userQueueName },
              groupSync: { id: groupJob.id, queue: groupQueueName },
            },
          },
        });
      } finally {
        await userQueue.close();
        await groupQueue.close();
        pair.disconnect();
      }
    } catch (error) {
      logger.error('Failed to trigger IdP sync', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Failed to trigger sync',
        },
      });
    }
  });

  /**
   * GET /api/idp/sync/status
   *
   * Get sync status for tenant (check queue job status).
   *
   * Query params:
   *   provider: 'azuread' | 'okta' | 'google'
   */
  router.get('/status', async (req, res) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ success: false, error: 'Missing tenant context' });
        return;
      }
      const tenantId = req.tenantContext.tenantId;
      const { provider } = req.query;

      if (!provider || !['azuread', 'okta', 'google'].includes(provider as string)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_PROVIDER',
            message: 'Provider query param required (azuread, okta, or google)',
          },
        });
        return;
      }

      const userQueueName =
        provider === 'azuread'
          ? QUEUE_AZUREAD_USER_SYNC
          : provider === 'okta'
            ? QUEUE_OKTA_USER_SYNC
            : QUEUE_GOOGLE_USER_SYNC;

      const groupQueueName =
        provider === 'azuread'
          ? QUEUE_AZUREAD_GROUP_SYNC
          : provider === 'okta'
            ? QUEUE_OKTA_GROUP_SYNC
            : QUEUE_GOOGLE_GROUP_SYNC;

      const pair = createIdpQueuePair();
      if (!pair) {
        res.status(503).json({
          success: false,
          error: { code: 'REDIS_UNAVAILABLE', message: 'Queue service unavailable' },
        });
        return;
      }

      const userQueue = new Queue(userQueueName, {
        connection: pair.queueConnection,
        prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      });
      const groupQueue = new Queue(groupQueueName, {
        connection: pair.workerConnection,
        prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      });

      try {
        // Get recent jobs for this tenant
        const userJobs = await userQueue.getJobs(
          ['active', 'waiting', 'completed', 'failed'],
          0,
          10,
        );
        const groupJobs = await groupQueue.getJobs(
          ['active', 'waiting', 'completed', 'failed'],
          0,
          10,
        );

        // Filter by tenantId
        const userJobStatuses = await Promise.all(
          userJobs
            .filter((job) => job.data.tenantId === tenantId)
            .map(async (job: Job) => ({
              id: job.id,
              state: await job.getState(),
              progress: job.progress,
              timestamp: job.timestamp,
              finishedOn: job.finishedOn,
              failedReason: job.failedReason,
            })),
        );

        const groupJobStatuses = await Promise.all(
          groupJobs
            .filter((job) => job.data.tenantId === tenantId)
            .map(async (job: Job) => ({
              id: job.id,
              state: await job.getState(),
              progress: job.progress,
              timestamp: job.timestamp,
              finishedOn: job.finishedOn,
              failedReason: job.failedReason,
            })),
        );

        res.json({
          success: true,
          data: {
            provider,
            tenantId,
            userSync: {
              queue: userQueueName,
              recentJobs: userJobStatuses,
            },
            groupSync: {
              queue: groupQueueName,
              recentJobs: groupJobStatuses,
            },
          },
        });
      } finally {
        await userQueue.close();
        await groupQueue.close();
        pair.disconnect();
      }
    } catch (error) {
      logger.error('Failed to get sync status', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Failed to get status',
        },
      });
    }
  });

  /**
   * POST /api/idp/sync/invalidate-cache
   *
   * Invalidate group membership cache for tenant.
   * Forces refresh on next query.
   */
  router.post('/invalidate-cache', async (req, res) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ success: false, error: 'Missing tenant context' });
        return;
      }
      const tenantId = req.tenantContext.tenantId;

      const redisClient = getGlobalRedisClient();
      const groupCache = getGroupMembershipCache(redisClient);

      const keysDeleted = await groupCache.invalidateTenant(tenantId);

      logger.info('Group membership cache invalidated', { tenantId, keysDeleted });

      res.json({
        success: true,
        data: {
          tenantId,
          keysDeleted,
        },
      });
    } catch (error) {
      logger.error('Failed to invalidate cache', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Failed to invalidate cache',
        },
      });
    }
  });

  return router;
}

export default createIdPSyncRouter();
