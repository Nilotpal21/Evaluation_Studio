/**
 * Quick Setup Orchestrator
 *
 * Orchestrates the three-step quick setup flow:
 *   1. Auto-discover resources
 *   2. Generate recommendations
 *   3. Apply accepted recommendations to connector config
 *
 * Does NOT auto-sync without user approval — the one-click quick-setup endpoint
 * explicitly accepts recommendations and optionally triggers sync.
 */

import type {
  IConnectorConfig,
  IConnectorDiscovery,
  IConnectorRecommendation,
  ISearchSource,
} from '@agent-platform/database/models';
import { QUEUE_SCHEMA_DISCOVERY } from '@agent-platform/search-ai-sdk';
import { getLazyModel } from '../../db/index.js';
import { createQueue } from '../../workers/shared.js';
import { RecommendationEngineService } from '../recommendation/recommendation-engine.service.js';
import { QUEUE_CONNECTOR_DISCOVERY } from '../../workers/connector-discovery-worker.js';
import type { ConnectorDiscoveryJobData } from '../../workers/connector-discovery-worker.js';
import type { SchemaDiscoveryJobData } from '../../workers/schema-discovery-worker.js';

// Models bound to platform database
const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
const ConnectorDiscovery = getLazyModel<IConnectorDiscovery>('ConnectorDiscovery');
const ConnectorRecommendation = getLazyModel<IConnectorRecommendation>('ConnectorRecommendation');
const SearchSource = getLazyModel<ISearchSource>('SearchSource');

const recommendationEngine = new RecommendationEngineService();

// ─── Orchestrator Functions ─────────────────────────────────────────────

/**
 * Trigger discovery job and return the discovery record ID.
 * The actual discovery runs asynchronously in the worker.
 */
export async function triggerDiscovery(
  connectorId: string,
  tenantId: string,
  connectorType: string,
  mode: 'discover_only' | 'discover_and_profile' | 'quick_setup' = 'discover_and_profile',
  sampleSize?: number,
): Promise<{ discoveryId: string; jobId: string }> {
  // Create discovery record
  const discovery = await ConnectorDiscovery.create({
    tenantId,
    connectorId,
    status: 'pending',
  });

  // Queue discovery job
  const discoveryQueue = createQueue(QUEUE_CONNECTOR_DISCOVERY);
  const job = await discoveryQueue.add(
    'connector-discovery',
    {
      connectorId,
      tenantId,
      connectorType,
      mode,
      sampleSize,
      discoveryId: discovery._id,
    } as ConnectorDiscoveryJobData,
    {
      jobId: `${connectorId}-discovery-${Date.now()}`,
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 604800 },
    },
  );

  // Link job to discovery record
  await ConnectorDiscovery.findOneAndUpdate(
    { _id: discovery._id, tenantId },
    { jobId: job.id as string },
  );

  return { discoveryId: discovery._id, jobId: job.id as string };
}

/**
 * Generate recommendations from a completed discovery.
 */
export async function generateRecommendations(
  connectorId: string,
  tenantId: string,
  discoveryId: string,
): Promise<IConnectorRecommendation> {
  const discovery = await ConnectorDiscovery.findOne({
    _id: discoveryId,
    tenantId,
    connectorId,
  });

  if (!discovery) {
    throw new Error('Discovery not found');
  }

  if (discovery.status !== 'completed') {
    throw new Error(`Discovery is not completed (status: ${discovery.status})`);
  }

  // Run recommendation engine
  const recommendation = recommendationEngine.generateRecommendation(
    discovery.resources as any[],
    discovery.profiles as any[],
  );

  // Save recommendation record
  const savedRecommendation = await ConnectorRecommendation.create({
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

  return savedRecommendation;
}

/**
 * Accept a recommendation and apply it to the connector configuration.
 * Optionally trigger initial sync.
 */
export async function acceptRecommendation(
  connectorId: string,
  tenantId: string,
  recommendationId: string,
  overrides?: Record<string, unknown>,
  startSync?: boolean,
): Promise<{ connector: IConnectorConfig; jobId?: string }> {
  const recommendation = await ConnectorRecommendation.findOne({
    _id: recommendationId,
    tenantId,
    connectorId,
  });

  if (!recommendation) {
    throw new Error('Recommendation not found');
  }

  if (recommendation.status !== 'generated') {
    throw new Error(`Recommendation cannot be accepted (status: ${recommendation.status})`);
  }

  // Mark recommendation as accepted
  recommendation.status = 'accepted';
  recommendation.userDecision = {
    action: overrides ? 'modified' : 'accepted',
    overrides: overrides || {},
    decidedAt: new Date(),
  };
  await recommendation.save();

  // Build filter config from recommendation (map recommendation's IFilterConfigDoc to new structured schema)
  const recFilter = recommendation.filterConfig;
  const filterConfig = {
    standard: {
      contentCategories: recFilter.contentTypes ?? ['files'],
      fileExtensions: null,
      maxFileSizeBytes: null,
      minFileSizeBytes: null,
      modifiedAfter: recFilter.modifiedSince ?? null,
      modifiedBefore: null,
      createdAfter: null,
      createdBefore: null,
    },
    scope:
      recFilter.mode === 'include' && recFilter.resourceIds?.length > 0
        ? {
            siteMode: 'selected',
            siteIds: recFilter.resourceIds,
            sitePatterns: [],
            libraryMode: 'all',
            libraryNames: [],
            libraryPatterns: [],
            folderPaths: { include: [], exclude: [] },
          }
        : {},
    advancedFilters: {
      enabled: false,
      rootOperator: 'AND' as const,
      conditions: [],
      groups: [],
    },
    version: 1,
  };

  // Apply overrides if any
  if (overrides?.filterConfig) {
    Object.assign(filterConfig, overrides.filterConfig);
  }

  // Update connector config
  const connector = await ConnectorConfig.findOneAndUpdate(
    { _id: connectorId, tenantId },
    {
      filterConfig,
      'permissionConfig.mode': overrides?.permissionMode || recommendation.permissionMode.mode,
      configurationSource: 'quick_setup',
      discoveryId: recommendation.discoveryId,
      recommendationId: recommendation._id,
      autoConfiguredAt: new Date(),
    },
    { new: true },
  );

  if (!connector) {
    throw new Error('Connector not found');
  }

  // Optionally trigger initial sync
  let jobId: string | undefined;
  if (startSync) {
    const { QUEUE_CONNECTOR_SYNC } = await import('../../workers/connector-sync-worker.js');
    const syncQueue = createQueue(QUEUE_CONNECTOR_SYNC);
    const job = await syncQueue.add(
      'full-sync',
      {
        connectorId,
        tenantId,
        syncType: 'full',
      },
      {
        jobId: `${connectorId}-full-${Date.now()}`,
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 604800 },
      },
    );
    jobId = job.id as string;
  }

  // Trigger schema discovery → field mapping suggestion pipeline
  // so the Fields tab is populated after the connector wizard completes.
  const source = await SearchSource.findOne({ _id: connector.sourceId, tenantId });
  if (source) {
    const schemaDiscoveryQueue = createQueue(QUEUE_SCHEMA_DISCOVERY);
    await schemaDiscoveryQueue.add(
      'schema-discovery',
      {
        connectorId,
        tenantId,
        knowledgeBaseId: source.indexId,
        connectorType: connector.connectorType,
        discoveryTrigger: 'activation',
      } as SchemaDiscoveryJobData,
      {
        jobId: `${connectorId}-schema-discovery-${Date.now()}`,
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 604800 },
      },
    );
  }

  return { connector: connector.toObject(), jobId };
}
