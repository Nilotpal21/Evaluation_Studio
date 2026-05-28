/**
 * Vector Index Migration Service
 *
 * Handles vector index resolution and migration when embedding dimensions change.
 * Used by both pipeline publish and embedding model config endpoints to ensure
 * consistent behavior across all embedding change flows.
 */

import { createLogger } from '@abl/compiler/platform';
import type { ISearchIndex } from '@agent-platform/database/models';

const logger = createLogger('vector-index-migration');

interface VectorIndexMigrationParams {
  tenantId: string;
  indexId: string;
  newDimensions: number;
  provider: string;
  model: string;
  currentVectorIndex?: string;
  currentDimensions?: number;
}

interface VectorIndexMigrationResult {
  targetVectorIndex: string;
  dimensionsChanged: boolean;
  strategy: 'shared' | 'per-app';
}

/**
 * Resolve the correct vector index for the given embedding dimensions.
 */
export async function resolveVectorIndex(
  params: VectorIndexMigrationParams,
): Promise<VectorIndexMigrationResult> {
  const {
    tenantId,
    indexId,
    newDimensions,
    provider,
    model,
    currentVectorIndex,
    currentDimensions,
  } = params;

  const dimensionsChanged = currentDimensions !== newDimensions;

  if (!dimensionsChanged && currentVectorIndex) {
    return {
      targetVectorIndex: currentVectorIndex,
      dimensionsChanged: false,
      strategy: 'shared',
    };
  }

  const { createVectorStore, getActiveSharedIndex, ensureIndexExists } =
    await import('@agent-platform/search-ai-internal');

  const vectorStore = createVectorStore({
    provider: 'opensearch',
    url: (process.env.OPENSEARCH_URL || process.env.VECTOR_STORE_URL)!,
    apiKey: process.env.OPENSEARCH_PASSWORD || process.env.VECTOR_STORE_API_KEY,
  });

  const STANDARD_DIMENSIONS = new Set([1024, 1536, 2048, 3072]);
  const isCustomWithNonStandardDims =
    provider === 'custom' && !STANDARD_DIMENSIONS.has(newDimensions);

  let targetVectorIndex: string;
  let strategy: 'shared' | 'per-app';

  if (isCustomWithNonStandardDims) {
    targetVectorIndex = await ensureIndexExists(vectorStore, tenantId, indexId, '', 'per-app');
    strategy = 'per-app';
    logger.info('Resolved per-app vector index', {
      indexId,
      dimensions: newDimensions,
      targetVectorIndex,
    });
  } else {
    targetVectorIndex = await getActiveSharedIndex(vectorStore, newDimensions);
    strategy = 'shared';
    logger.info('Resolved shared vector index', {
      indexId,
      dimensions: newDimensions,
      targetVectorIndex,
    });
  }

  return { targetVectorIndex, dimensionsChanged, strategy };
}

/**
 * Update SearchIndex and IndexRegistry with new vector index.
 */
export async function updateVectorIndexPointers(
  SearchIndex: any,
  indexId: string,
  tenantId: string,
  migration: VectorIndexMigrationResult,
  embeddingConfig: { provider: string; model: string; dimensions: number },
): Promise<ISearchIndex> {
  const { targetVectorIndex, dimensionsChanged } = migration;
  const { provider, model, dimensions } = embeddingConfig;

  const updatePayload: any = {
    $set: {
      embeddingModel: model,
      embeddingDimensions: dimensions,
      activeVectorIndex: targetVectorIndex,
      updatedAt: new Date(),
    },
  };

  if (dimensionsChanged) {
    updatePayload.$push = {
      vectorIndexHistory: {
        indexName: targetVectorIndex,
        dimensions,
        provider,
        model,
        createdAt: new Date(),
      },
    };
  }

  const updatedIndex = await SearchIndex.findOneAndUpdate(
    { _id: indexId, tenantId },
    updatePayload,
    { upsert: true, new: true, runValidators: true },
  ).lean();

  if (dimensionsChanged) {
    const { getLazyModel } = await import('../db/index.js');
    const IndexRegistry = getLazyModel('IndexRegistry');
    await IndexRegistry.findOneAndUpdate(
      { appId: indexId, tenantId },
      { $set: { indexName: targetVectorIndex, dimensions, updatedAt: new Date() } },
      { upsert: true },
    );
  }

  return updatedIndex;
}
