/**
 * Index Registry Utilities
 *
 * Core functions for managing vector store index assignments:
 * - Shared index rotation (auto-create new index at 70% capacity)
 * - Index name generation (strategy-aware)
 * - Index resolution (write path: which index for this app/connector?)
 * - Index lookup (search path: which indices to query for this app?)
 * - Cascade deletion (cleanup indices when app/connector deleted)
 */

import type { IndexStrategy } from '@agent-platform/database';
import type { Model } from 'mongoose';
import type { VectorStoreProvider } from './interface.js';
import { deriveShardConfig } from './opensearch.js';
import { createLogger } from '@agent-platform/shared-observability';

const logger = createLogger('index-registry');

// ─── Model Provider ─────────────────────────────────────────────────────────
// The search-ai-internal package cannot import from apps/search-ai/src/db/.
// Instead, the host app (search-ai) calls configureIndexRegistryModels() at
// startup to inject correctly-bound Mongoose models.

interface IndexRegistryModels {
  IndexRegistry: Model<any>;
  SharedIndexTracker: Model<any>;
}

let _models: IndexRegistryModels | null = null;

/**
 * Configure the Mongoose models used by index-registry functions.
 * Must be called after bindModelsForSearchAI() completes in the host app.
 */
export function configureIndexRegistryModels(models: IndexRegistryModels): void {
  _models = models;
}

function getIndexRegistryModels(): IndexRegistryModels {
  if (!_models) {
    throw new Error(
      'IndexRegistry models not configured. ' +
        'Call configureIndexRegistryModels() after initMongoBackend().',
    );
  }
  return _models;
}

// ─── Configuration ───────────────────────────────────────────────────────────

export interface SharedIndexConfig {
  maxVectors: number;
  maxSizeGB: number;
  capacityThreshold: number;
  autoRotate: boolean;
  maxShards: number;
  replicaCount: number;
}

// Derive shard/replica from cluster topology at module load time
const _clusterShardConfig = deriveShardConfig();

const DEFAULT_SHARED_CONFIG: SharedIndexConfig = {
  maxVectors: parseInt(process.env.SEARCH_INDEX_MAX_VECTORS || '10000000', 10), // 10M
  maxSizeGB: parseInt(process.env.SEARCH_INDEX_MAX_SIZE_GB || '50', 10),
  capacityThreshold: parseFloat(process.env.SEARCH_INDEX_CAPACITY_THRESHOLD || '0.6'), // 60% threshold
  autoRotate: process.env.SEARCH_INDEX_AUTO_ROTATE !== 'false',
  maxShards: parseInt(process.env.SEARCH_INDEX_SHARDS || String(_clusterShardConfig.shards), 10),
  replicaCount: parseInt(
    process.env.SEARCH_INDEX_REPLICAS || String(_clusterShardConfig.replicas),
    10,
  ),
};

// ─── Index Name Generation ───────────────────────────────────────────────────

/**
 * Sanitize an ID for use in vector store index names.
 * vector store index names must be lowercase, alphanumeric + hyphen only.
 */
export function sanitizeId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Generate vector store index name based on strategy.
 *
 * @param strategy - Index strategy
 * @param tenantId - Tenant identifier
 * @param appId - App identifier
 * @param connectorId - Connector identifier (required for per-connector)
 * @returns vector store index name
 */
export function generateIndexName(
  strategy: IndexStrategy,
  tenantId: string,
  appId: string,
  connectorId?: string,
): string {
  const prefix = process.env.SEARCH_INDEX_PREFIX || 'search';

  switch (strategy) {
    case 'shared':
      // Shared indices managed by SharedIndexTracker
      throw new Error('Use getActiveSharedIndex() for shared strategy');

    case 'per-app':
      return `${prefix}-${sanitizeId(tenantId)}-${sanitizeId(appId)}`;

    case 'per-connector':
      if (!connectorId) {
        throw new Error('connectorId required for per-connector strategy');
      }
      return `${prefix}-${sanitizeId(tenantId)}-${sanitizeId(appId)}-${sanitizeId(connectorId)}`;

    default:
      throw new Error(`Unknown index strategy: ${strategy}`);
  }
}

// ─── Shared Index Management ─────────────────────────────────────────────────

/**
 * Get active shared index name for a given dimension, creating new version if needed.
 * Auto-rotates at capacity threshold (default: 60%).
 *
 * Indexes are pooled by dimension: `search-vectors-{dims}-v{N}`.
 * Different embedding models at the same dimension coexist in one index
 * because kNN pre-filters by indexId before computing similarity.
 *
 * @param vectorStore - Vector store provider
 * @param dimensions - Vector dimensions (e.g., 1024, 1536)
 * @param config - Shared index configuration
 * @returns Active shared index name
 */
export async function getActiveSharedIndex(
  vectorStore: VectorStoreProvider,
  dimensions: number,
  config: SharedIndexConfig = DEFAULT_SHARED_CONFIG,
): Promise<string> {
  // 1. Find current active shared index for this dimension
  const { SharedIndexTracker } = getIndexRegistryModels();
  const existingTracker = await SharedIndexTracker.findOne({
    dimensions,
    status: 'active',
  }).sort({
    version: -1,
  });

  if (!existingTracker) {
    // First shared index for this dimension - create v1
    const newTracker = await createSharedIndex(vectorStore, 1, dimensions, config);
    return newTracker.indexName;
  }

  // 2. Sync stats from vector store
  await syncSharedIndexStats(vectorStore, existingTracker, dimensions);

  // 3. Check capacity and rotate if needed
  if (config.autoRotate && existingTracker.capacityPercent >= config.capacityThreshold) {
    // Mark current as full
    existingTracker.status = 'full';
    await existingTracker.save();

    // Create new version
    const newVersion = existingTracker.version + 1;
    const newTracker = await createSharedIndex(vectorStore, newVersion, dimensions, config);

    logger.info('Rotated shared index', {
      dimensions,
      oldVersion: newVersion - 1,
      newVersion,
      capacityPercent: (existingTracker.capacityPercent * 100).toFixed(1),
    });

    return newTracker.indexName;
  }

  return existingTracker.indexName;
}

/**
 * Create a new shared index with tracking.
 * Index name format: `search-vectors-{dimensions}-v{version}`
 */
async function createSharedIndex(
  vectorStore: VectorStoreProvider,
  version: number,
  dimensions: number,
  config: SharedIndexConfig,
): Promise<any> {
  const { SharedIndexTracker } = getIndexRegistryModels();
  const indexName = `search-vectors-${dimensions}-v${version}`;

  // 1. Create vector store index
  const exists = await vectorStore.collectionExists(indexName);
  if (!exists) {
    await vectorStore.createCollection({
      name: indexName,
      dimensions,
      distance: 'cosine',
    });
  }

  // 2. Create tracker
  const tracker = await SharedIndexTracker.create({
    indexName,
    version,
    dimensions,
    status: 'active',
    maxVectors: config.maxVectors,
    maxSizeGB: config.maxSizeGB,
  });

  logger.info('Created shared index', { indexName, dimensions, version });

  return tracker;
}

/**
 * Sync vector count and size from vector store for a single tracker.
 */
async function syncSharedIndexStats(
  vectorStore: VectorStoreProvider,
  tracker: any,
  dimensions: number,
): Promise<void> {
  const info = await vectorStore.getCollectionInfo(tracker.indexName);

  if (info) {
    tracker.vectorCount = info.vectorCount;
    // Estimate size: dimensions × 4 bytes per float + ~256 bytes metadata overhead per vector
    tracker.estimatedSizeGB = (info.vectorCount * (dimensions * 4 + 256)) / 1024 ** 3;
    tracker.capacityPercent = tracker.vectorCount / tracker.maxVectors;
    tracker.lastSyncedAt = new Date();
    await tracker.save();
  }
}

/**
 * Sync stats for ALL active/full shared index trackers from OpenSearch.
 *
 * OpenSearch is the source of truth for vector counts. This function queries
 * each tracked index and updates the MongoDB tracker with real counts.
 *
 * Call this from admin endpoints or periodic sync jobs — NOT from the
 * embedding hot path (adds latency, and individual increments are fragile
 * with retries/failures).
 *
 * @param vectorStore - Vector store provider
 * @returns Summary of synced trackers
 */
export async function syncAllSharedIndexStats(
  vectorStore: VectorStoreProvider,
): Promise<{ synced: number; errors: number }> {
  const { SharedIndexTracker } = getIndexRegistryModels();
  const trackers = await SharedIndexTracker.find({
    status: { $in: ['active', 'full'] },
  });

  let synced = 0;
  let errors = 0;

  for (const tracker of trackers) {
    try {
      await syncSharedIndexStats(vectorStore, tracker, tracker.dimensions);
      synced++;
    } catch (error) {
      errors++;
      logger.warn('Failed to sync stats for shared index', {
        indexName: tracker.indexName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('Synced all shared index stats', { synced, errors });
  return { synced, errors };
}

/**
 * Manually trigger shared index rotation (admin API).
 * Forces rotation regardless of capacity threshold.
 *
 * @param vectorStore - Vector store provider
 * @param dimensions - Vector dimensions for the pool to rotate
 * @param config - Shared index configuration
 * @returns New shared index name and rotation details
 */
export async function forceRotateSharedIndex(
  vectorStore: VectorStoreProvider,
  dimensions: number,
  config: SharedIndexConfig = DEFAULT_SHARED_CONFIG,
): Promise<{
  success: boolean;
  oldIndex: string;
  newIndex: string;
  oldVersion: number;
  newVersion: number;
  capacityPercent: number;
}> {
  // Find current active shared index for this dimension
  const { SharedIndexTracker } = getIndexRegistryModels();
  const existingTracker = await SharedIndexTracker.findOne({
    dimensions,
    status: 'active',
  }).sort({
    version: -1,
  });

  if (!existingTracker) {
    throw new Error(`No active shared index found for ${dimensions}d to rotate`);
  }

  // Sync stats before rotation
  await syncSharedIndexStats(vectorStore, existingTracker, dimensions);

  // Mark current as full
  existingTracker.status = 'full';
  await existingTracker.save();

  // Create new version
  const newVersion = existingTracker.version + 1;
  const newTracker = await createSharedIndex(vectorStore, newVersion, dimensions, config);

  logger.info('Manual rotation', {
    dimensions,
    oldVersion: existingTracker.version,
    newVersion,
    capacityPercent: (existingTracker.capacityPercent * 100).toFixed(1),
  });

  return {
    success: true,
    oldIndex: existingTracker.indexName,
    newIndex: newTracker.indexName,
    oldVersion: existingTracker.version,
    newVersion: newTracker.version,
    capacityPercent: existingTracker.capacityPercent,
  };
}

// ─── Index Resolution (Write Path) ───────────────────────────────────────────

/**
 * Resolve which vector store index to write to for a given app/connector.
 * Supports hybrid strategy: connector override > app default > shared.
 *
 * @param vectorStore - Vector store provider
 * @param tenantId - Tenant identifier
 * @param appId - App identifier
 * @param connectorId - Connector identifier
 * @param dimensions - Vector dimensions (default: 1024 for legacy compatibility)
 * @returns vector store index name
 */
export async function resolveIndexForWrite(
  vectorStore: VectorStoreProvider,
  tenantId: string,
  appId: string,
  connectorId: string,
  dimensions: number = 1024,
): Promise<string> {
  const { IndexRegistry } = getIndexRegistryModels();

  // 1. Check for connector-specific override (hybrid strategy)
  const connectorRegistry = await IndexRegistry.findOne({
    tenantId,
    appId,
    connectorId,
    status: 'active',
  });

  if (connectorRegistry) {
    return connectorRegistry.indexName;
  }

  // 2. Fall back to app-level default
  const appRegistry = await IndexRegistry.findOne({
    tenantId,
    appId,
    connectorId: null, // null = app default
    status: 'active',
  });

  if (appRegistry) {
    return appRegistry.indexName;
  }

  // 3. No registry entry - create with shared strategy (default)
  return await ensureSharedIndex(vectorStore, tenantId, appId, dimensions);
}

/**
 * Ensure an app has a shared index entry, creating if needed.
 */
async function ensureSharedIndex(
  vectorStore: VectorStoreProvider,
  tenantId: string,
  appId: string,
  dimensions: number = 1024,
): Promise<string> {
  const { IndexRegistry, SharedIndexTracker } = getIndexRegistryModels();

  // Get active shared index for this dimension (auto-rotates if needed)
  const sharedIndexName = await getActiveSharedIndex(vectorStore, dimensions);

  // Check if registry entry already exists for this tenant+app
  let registry = await IndexRegistry.findOne({
    tenantId,
    appId,
    strategy: 'shared',
    status: 'active',
  });

  if (!registry) {
    // Create registry entry
    registry = await IndexRegistry.create({
      tenantId,
      appId,
      connectorId: null,
      indexName: sharedIndexName,
      strategy: 'shared',
      status: 'active',
    });

    // Increment app count on shared index tracker
    await SharedIndexTracker.findOneAndUpdate(
      { indexName: sharedIndexName },
      { $inc: { appCount: 1 } },
    );

    logger.info('Assigned app to shared index', { appId, sharedIndexName, dimensions });
  }

  return registry.indexName;
}

/**
 * Ensure an index exists for the given strategy, creating if needed.
 * Used by embedding worker when first document is indexed.
 *
 * @param vectorStore - Vector store provider
 * @param tenantId - Tenant identifier
 * @param appId - App identifier
 * @param connectorId - Connector identifier
 * @param strategy - Index strategy
 * @returns vector store index name
 */
export async function ensureIndexExists(
  vectorStore: VectorStoreProvider,
  tenantId: string,
  appId: string,
  connectorId: string,
  strategy: IndexStrategy,
  dimensions: number = 1024,
): Promise<string> {
  if (strategy === 'shared') {
    return await ensureSharedIndex(vectorStore, tenantId, appId, dimensions);
  }

  const { IndexRegistry } = getIndexRegistryModels();

  // For per-app or per-connector, check if registry entry exists
  const query: any = {
    tenantId,
    appId,
    status: 'active',
  };

  if (strategy === 'per-connector') {
    query.connectorId = connectorId;
  } else {
    query.connectorId = null; // per-app uses null connectorId
  }

  let registry = await IndexRegistry.findOne(query);

  if (!registry) {
    // Generate index name
    const indexName = generateIndexName(strategy, tenantId, appId, connectorId);

    // Create vector store index if doesn't exist
    const exists = await vectorStore.collectionExists(indexName);
    if (!exists) {
      await vectorStore.createCollection({
        name: indexName,
        dimensions,
        distance: 'cosine',
      });

      logger.info('Created index', { strategy, indexName, dimensions });
    }

    // Create registry entry
    registry = await IndexRegistry.create({
      tenantId,
      appId,
      connectorId: strategy === 'per-connector' ? connectorId : null,
      indexName: indexName,
      strategy,
      status: 'active',
    });
  }

  return registry.indexName;
}

// ─── Index Lookup (Search Path) ──────────────────────────────────────────────

/**
 * Get all vector store indices for an app (for multi-index search).
 * Returns unique index names (handles hybrid strategy with base + overrides).
 *
 * @param tenantId - Tenant identifier
 * @param appId - App identifier
 * @returns Array of vector store index names
 */
export async function getAppIndices(tenantId: string, appId: string): Promise<string[]> {
  const { IndexRegistry } = getIndexRegistryModels();
  const registries = await IndexRegistry.find({
    tenantId,
    appId,
    status: 'active',
  })
    .select('indexName')
    .lean();

  // Deduplicate (in case of multiple connectors on same shared index)
  const uniqueIndices = [...new Set(registries.map((r: any) => r.indexName as string))];

  return uniqueIndices;
}

// ─── Cascade Deletion ────────────────────────────────────────────────────────

/**
 * Delete all vector store indices for an app.
 * Used when app is deleted.
 *
 * @param vectorStore - Vector store provider
 * @param tenantId - Tenant identifier
 * @param appId - App identifier
 */
export async function deleteAppIndices(
  vectorStore: VectorStoreProvider,
  tenantId: string,
  appId: string,
): Promise<void> {
  const { IndexRegistry, SharedIndexTracker } = getIndexRegistryModels();
  const registries = await IndexRegistry.find({
    tenantId,
    appId,
    status: 'active',
  });

  for (const registry of registries) {
    // Mark as deleting
    registry.status = 'deleting';
    await registry.save();

    // For shared indices, only delete vectors, not the index itself
    if (registry.strategy === 'shared') {
      // Delete all vectors for this app from shared index
      await vectorStore.deleteByFilter(registry.indexName, [
        { field: 'sys.appId', operator: 'eq', value: appId },
      ]);

      // Decrement app count
      await SharedIndexTracker.findOneAndUpdate(
        { indexName: registry.indexName },
        { $inc: { appCount: -1 } },
      );
    } else {
      // For dedicated indices, delete entire index
      await vectorStore.deleteCollection(registry.indexName);
    }

    // Delete registry entry
    await IndexRegistry.findOneAndDelete({ _id: registry._id });

    logger.info('Deleted index for app', {
      strategy: registry.strategy,
      appId,
      indexName: registry.indexName,
    });
  }
}

/**
 * Delete vector store index for a specific connector.
 * Used when connector is deleted (only for per-connector strategy).
 *
 * @param vectorStore - Vector store provider
 * @param tenantId - Tenant identifier
 * @param appId - App identifier
 * @param connectorId - Connector identifier
 */
export async function deleteConnectorIndex(
  vectorStore: VectorStoreProvider,
  tenantId: string,
  appId: string,
  connectorId: string,
): Promise<void> {
  const { IndexRegistry } = getIndexRegistryModels();
  const registry = await IndexRegistry.findOne({
    tenantId,
    appId,
    connectorId,
    status: 'active',
  });

  if (!registry) {
    return; // No dedicated index for this connector
  }

  // Mark as deleting
  registry.status = 'deleting';
  await registry.save();

  // For shared/per-app indices, only delete vectors
  if (registry.strategy === 'shared' || registry.strategy === 'per-app') {
    await vectorStore.deleteByFilter(registry.indexName, [
      { field: 'sys.appId', operator: 'eq', value: appId },
      { field: 'sys.connectorId', operator: 'eq', value: connectorId },
    ]);
  } else {
    // For per-connector, delete entire index
    await vectorStore.deleteCollection(registry.indexName);
  }

  // Delete registry entry
  await IndexRegistry.findOneAndDelete({ _id: registry._id });

  logger.info('Deleted connector index', {
    indexName: registry.indexName,
    connectorId,
  });
}
