/**
 * Connector Discovery Worker
 *
 * Background worker for auto-discovering connector resources and profiling content.
 * Follows the same patterns as connector-sync-worker.ts.
 *
 * Job modes:
 * - discover_only — Discover resources only (fast)
 * - discover_and_profile — Discover + profile each resource
 * - quick_setup — Discover + profile + generate recommendations
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import type {
  IConnectorConfig,
  IConnectorDiscovery,
  IConnectorRecommendation,
  IEndUserOAuthToken,
} from '@agent-platform/database/models';
import { withTenantContext } from '@agent-platform/database/mongo';
import { getLazyModel } from '../db/index.js';
import { createWorkerOptions, workerLog, workerError, withTraceContext } from './shared.js';
import { getSharedRedisClient } from './shared.js';
import { SharePointConnector } from '@agent-platform/connector-sharepoint';
import { DistributedLockManager } from '@agent-platform/shared-observability';
import { RecommendationEngineService } from '../services/recommendation/recommendation-engine.service.js';
import type {
  IResourceDiscovery,
  ContentProfile,
  DiscoveredResource,
} from '@agent-platform/connectors-base';

// Models bound to platform database via dual-connection
const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
const ConnectorDiscovery = getLazyModel<IConnectorDiscovery>('ConnectorDiscovery');
const ConnectorRecommendation = getLazyModel<IConnectorRecommendation>('ConnectorRecommendation');
const EndUserOAuthToken = getLazyModel<IEndUserOAuthToken>('EndUserOAuthToken');

// ============================================================================
// Queue Name
// ============================================================================

export const QUEUE_CONNECTOR_DISCOVERY = 'connector-discovery';

// ============================================================================
// Job Data Interface
// ============================================================================

export interface ConnectorDiscoveryJobData {
  connectorId: string;
  tenantId: string;
  connectorType: string;
  mode: 'discover_only' | 'discover_and_profile' | 'quick_setup';
  sampleSize?: number;
  discoveryId: string;
}

// ============================================================================
// Distributed Lock Setup
// ============================================================================

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

async function processDiscoveryJob(job: Job<ConnectorDiscoveryJobData>): Promise<void> {
  const { connectorId, tenantId, connectorType, mode, sampleSize, discoveryId } = job.data;

  workerLog('connector-discovery', `Processing discovery job ${job.id}`, {
    connectorId,
    tenantId,
    mode,
  });

  await withTraceContext(job.data as unknown as Record<string, unknown>, () =>
    withTenantContext({ tenantId }, async () => {
      // 1. Acquire distributed lock
      const lockMgr = ensureLockManager();
      const lockResourceId = connectorId;
      const lock = await lockMgr.acquire(lockResourceId, {
        keyPrefix: 'discovery-lock',
        ttlMs: 600000, // 10 minutes
        retryAttempts: 0,
      });

      if (!lock) {
        workerError(
          'connector-discovery',
          `Discovery already in progress for connector ${connectorId}`,
          new Error('Lock contention'),
        );
        throw new Error(`Discovery already in progress for connector ${connectorId}`);
      }

      try {
        // 2. Load connector config
        const config = await ConnectorConfig.findOne({ _id: connectorId, tenantId });
        if (!config) {
          throw new Error(`Connector ${connectorId} not found`);
        }

        // 3. Initialize connector and get discovery interface
        let discovery: IResourceDiscovery;

        switch (connectorType) {
          case 'sharepoint': {
            const connector = new SharePointConnector(config.toObject(), EndUserOAuthToken);
            await connector.initialize();
            const resourceDiscovery = connector.getResourceDiscovery?.();
            if (!resourceDiscovery) {
              throw new Error('SharePoint connector does not support resource discovery');
            }
            discovery = resourceDiscovery;
            break;
          }
          default:
            throw new Error(`Unsupported connector type for discovery: ${connectorType}`);
        }

        const startTime = Date.now();

        // 4. Discover resources
        await ConnectorDiscovery.findOneAndUpdate(
          { _id: discoveryId, tenantId },
          { status: 'discovering' },
        );

        const resources = await discovery.discoverResources((progress) => {
          job.updateProgress(progress.percentComplete * 0.5); // 0-50%
        });

        workerLog('connector-discovery', `Discovered ${resources.length} resources`, {
          connectorId,
        });

        // 5. Profile content (if requested)
        const profiles: ContentProfile[] = [];

        if (mode !== 'discover_only') {
          await ConnectorDiscovery.findOneAndUpdate(
            { _id: discoveryId, tenantId },
            { status: 'profiling' },
          );

          const driveResources = resources.filter((r) => r.resourceType === 'drive');
          for (let i = 0; i < driveResources.length; i++) {
            try {
              const profile = await discovery.profileContent(driveResources[i].id, sampleSize);
              profiles.push(profile);
            } catch (error: unknown) {
              const errMsg = error instanceof Error ? error.message : String(error);
              workerLog(
                'connector-discovery',
                `Failed to profile resource ${driveResources[i].id}: ${errMsg}`,
                { connectorId },
              );
            }

            const profileProgress = 50 + ((i + 1) / driveResources.length) * 40; // 50-90%
            await job.updateProgress(Math.round(profileProgress));
          }
        }

        const durationMs = Date.now() - startTime;

        // 6. Save discovery results
        await ConnectorDiscovery.findOneAndUpdate(
          { _id: discoveryId, tenantId },
          {
            status: 'completed',
            resources,
            profiles,
            totalResources: resources.length,
            discoveredAt: new Date(),
            durationMs,
          },
        );

        // 7. Generate recommendations (if quick_setup mode)
        if (mode === 'quick_setup') {
          const engine = new RecommendationEngineService();
          const recommendation = engine.generateRecommendation(resources, profiles);

          await ConnectorRecommendation.create({
            tenantId,
            connectorId,
            discoveryId,
            status: 'generated',
            resourceScores: recommendation.resourceScores,
            syncStrategy: recommendation.syncStrategy,
            permissionMode: recommendation.permissionMode,
            filterConfig: recommendation.filterConfig,
            costEstimate: recommendation.costEstimate,
            overallConfidence: recommendation.overallConfidence,
            generatedAt: recommendation.generatedAt,
          });
        }

        await job.updateProgress(100);

        workerLog('connector-discovery', `Discovery completed in ${durationMs}ms`, {
          connectorId,
          resources: resources.length,
          profiles: profiles.length,
          mode,
        });
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);

        // Update discovery record with error
        await ConnectorDiscovery.findOneAndUpdate(
          { _id: discoveryId, tenantId },
          { status: 'failed', error: errMsg },
        );

        workerError('connector-discovery', 'Discovery failed', error);
        throw error;
      } finally {
        // Always release lock
        const released = await lockMgr.release(lock);
        if (!released) {
          workerError(
            'connector-discovery',
            `Failed to release discovery lock for ${connectorId}`,
            new Error('Lock may have expired'),
          );
        }
      }
    }),
  );
}

// ============================================================================
// Worker Instance
// ============================================================================

export const connectorDiscoveryWorker = new Worker(
  QUEUE_CONNECTOR_DISCOVERY,
  processDiscoveryJob,
  createWorkerOptions(2), // Discovery is lighter than sync
);

connectorDiscoveryWorker.on('completed', (job) => {
  workerLog('connector-discovery', `Job ${job.id} completed`);
});

connectorDiscoveryWorker.on('failed', (job, err) => {
  workerError('connector-discovery', `Job ${job?.id} failed`, err);
});

// ============================================================================
// Graceful Shutdown
// ============================================================================

process.on('SIGTERM', async () => {
  workerLog('connector-discovery', 'Received SIGTERM, initiating graceful shutdown');
  try {
    await connectorDiscoveryWorker.close();
    workerLog('connector-discovery', 'Worker closed gracefully');
  } catch (error) {
    workerError('connector-discovery', 'Error during graceful shutdown', error);
  }
});

export default connectorDiscoveryWorker;
