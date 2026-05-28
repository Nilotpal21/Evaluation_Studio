/**
 * Embedding Stage Sync
 *
 * Ensures all flow embedding stages match the pipeline's activeEmbeddingConfig.
 * This is the single source of truth for embedding consistency enforcement.
 *
 * Used by:
 * - PATCH /embedding-config endpoint (when user changes embedding provider)
 * - Future upgrade-template endpoint (when template stages replace flow stages)
 * - Any code path that modifies flow stages and must maintain embedding consistency
 */

import type { ISearchPipelineDefinition, ISearchPipelineFlow } from '@agent-platform/database';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('embedding-sync');

export interface SyncResult {
  /** Number of stages that were updated */
  updatedCount: number;
  /** Flow IDs that had stages updated */
  affectedFlowIds: string[];
}

/**
 * Sync all embedding stages across all flows to match activeEmbeddingConfig.
 *
 * Mutates the pipeline's flow stages in place. Caller is responsible for saving.
 *
 * @param pipeline - Pipeline definition (mutated in place)
 * @returns Summary of what was updated
 *
 * @example
 * ```typescript
 * // After replacing flow stages from a template:
 * flow.stages = newTemplateStages;
 * const result = syncFlowEmbeddingStages(pipeline);
 * await pipeline.save();
 * ```
 */
export function syncFlowEmbeddingStages(pipeline: ISearchPipelineDefinition): SyncResult {
  const config = pipeline.activeEmbeddingConfig;
  if (!config) {
    logger.warn('No activeEmbeddingConfig on pipeline, skipping embedding sync', {
      pipelineId: pipeline._id,
    });
    return { updatedCount: 0, affectedFlowIds: [] };
  }

  let updatedCount = 0;
  const affectedFlowIds: string[] = [];

  for (const flow of pipeline.flows) {
    let flowUpdated = false;

    for (const stage of flow.stages) {
      if (stage.type !== 'embedding') continue;

      const needsUpdate =
        stage.provider !== config.provider ||
        (stage.providerConfig as Record<string, unknown>)?.model !== config.model ||
        (stage.providerConfig as Record<string, unknown>)?.dimensions !== config.dimensions;

      if (needsUpdate) {
        stage.provider = config.provider;
        stage.providerConfig = {
          ...stage.providerConfig,
          model: config.model,
          dimensions: config.dimensions,
        };
        updatedCount++;
        flowUpdated = true;
      }
    }

    if (flowUpdated) {
      affectedFlowIds.push(flow.id);
    }
  }

  if (updatedCount > 0) {
    logger.info('Embedding stages synced to activeEmbeddingConfig', {
      pipelineId: pipeline._id,
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
      updatedCount,
      affectedFlowIds,
    });
  }

  return { updatedCount, affectedFlowIds };
}

/**
 * Sync embedding stages for a single flow.
 *
 * Useful after replacing a single flow's stages (e.g., template upgrade).
 * Mutates the flow's stages in place.
 *
 * @param flow - Pipeline flow (mutated in place)
 * @param pipeline - Pipeline definition (for activeEmbeddingConfig)
 * @returns Number of stages updated
 */
export function syncFlowEmbeddingStagesForFlow(
  flow: ISearchPipelineFlow,
  pipeline: ISearchPipelineDefinition,
): number {
  const config = pipeline.activeEmbeddingConfig;
  if (!config) return 0;

  let updatedCount = 0;

  for (const stage of flow.stages) {
    if (stage.type !== 'embedding') continue;

    stage.provider = config.provider;
    stage.providerConfig = {
      ...stage.providerConfig,
      model: config.model,
      dimensions: config.dimensions,
    };
    updatedCount++;
  }

  return updatedCount;
}
