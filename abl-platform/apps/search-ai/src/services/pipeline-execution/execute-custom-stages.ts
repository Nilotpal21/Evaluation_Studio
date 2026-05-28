/**
 * Custom Pipeline Stage Executor
 *
 * Loads the pipeline definition for a knowledge base and executes any custom
 * enrichment stages (HTTP webhook) that the user configured.
 *
 * This is called by the enrichment worker AFTER standard enrichment and BEFORE
 * embedding. It bridges the gap between pipeline configuration (UI) and actual
 * document processing (workers).
 *
 * Design: Non-breaking — if no pipeline exists or no custom stages are configured,
 * this is a no-op. Existing pipeline behavior is unchanged.
 */

import { getLazyModel } from '../../db/index.js';
import type {
  ISearchPipelineDefinition,
  ISearchPipelineStage,
  IKnowledgeBase,
  ISearchChunk,
} from '@agent-platform/database';
import { ProviderRegistry } from '../provider-registry/provider-registry.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('custom-stage-executor');

const KnowledgeBase = getLazyModel<IKnowledgeBase>('KnowledgeBase');
const SearchPipelineDefinition = getLazyModel<ISearchPipelineDefinition>(
  'SearchPipelineDefinition',
);
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk');

/**
 * Execute custom enrichment stages from the pipeline definition.
 *
 * Called by the enrichment worker after standard enrichment, before embedding.
 * Looks for stages with provider 'http-webhook'
 * in the enrichment stage type and executes them against chunk content.
 *
 * @param tenantId - Tenant ID
 * @param indexId - Search index ID
 * @param documentId - Document ID
 * @param chunkIds - Chunk IDs to process
 * @returns Number of custom stages executed (0 if none)
 */
export async function executeCustomEnrichmentStages(
  tenantId: string,
  indexId: string,
  documentId: string,
  chunkIds: string[],
): Promise<number> {
  try {
    // 1. Find KB from index
    const kb = await KnowledgeBase.findOne({ searchIndexId: indexId, tenantId }).lean();
    if (!kb) {
      return 0; // No KB — skip
    }

    // 2. Find active pipeline for KB
    const pipeline = await SearchPipelineDefinition.findOne(
      { knowledgeBaseId: kb._id, tenantId, status: 'active' },
      null,
      { sort: { isDefault: 1 } },
    ).lean();

    if (!pipeline) {
      return 0; // No pipeline — skip
    }

    // 3. Find the default flow (or first enabled flow)
    const flow =
      pipeline.flows.find((f) => f.isDefault && f.enabled) ?? pipeline.flows.find((f) => f.enabled);

    if (!flow) {
      return 0; // No enabled flow — skip
    }

    // 4. Find custom stages (webhook) of ANY stage type
    // Users may add these as extraction, enrichment, or chunking stages
    const customProviders = new Set<string>(['http-webhook']);
    const customStages = flow.stages.filter((s) => customProviders.has(s.provider));

    if (customStages.length === 0) {
      return 0; // No custom stages — skip
    }

    logger.info('Executing custom pipeline stages', {
      tenantId,
      indexId,
      documentId,
      pipelineId: pipeline._id,
      flowName: flow.name,
      customStageCount: customStages.length,
    });

    // 5. Load chunks
    const chunks = await SearchChunk.find({
      _id: { $in: chunkIds },
      tenantId,
      indexId,
    });

    if (chunks.length === 0) {
      logger.warn('No chunks found for custom enrichment', { documentId, chunkIds });
      return 0;
    }

    const registry = ProviderRegistry.getInstance();
    let executedCount = 0;

    // 6. Execute each custom stage
    for (const stage of customStages) {
      // Check execution condition
      if (stage.executionCondition) {
        try {
          const { Environment } = await import('@marcbachmann/cel-js');
          const env = new Environment({ unlistedVariablesAreDyn: true });
          const result = env.evaluate(stage.executionCondition, {
            document: { name: '', mimeType: '', extension: '', size: 0 },
            source: { connector: '' },
          });
          if (result === false) {
            logger.info('Custom stage skipped (condition false)', {
              stageId: stage.id,
              stageName: stage.name,
              condition: stage.executionCondition,
            });
            continue;
          }
        } catch (condError) {
          logger.warn('Condition evaluation failed, executing stage anyway', {
            stageId: stage.id,
            error: condError instanceof Error ? condError.message : String(condError),
          });
        }
      }

      // Resolve provider
      let provider;
      try {
        provider = registry.get(stage.type, stage.provider);
      } catch {
        logger.error('Provider not found for custom stage', {
          stageId: stage.id,
          provider: stage.provider,
          type: stage.type,
        });
        if (stage.onError === 'continue') continue;
        throw new Error(`Provider '${stage.provider}' not found for stage '${stage.name}'`);
      }

      logger.info('Executing custom stage', {
        stageId: stage.id,
        stageName: stage.name,
        provider: stage.provider,
      });

      // Execute against each chunk
      for (const chunk of chunks) {
        try {
          const input = {
            documentId,
            content: chunk.content,
            contentType: 'text/plain',
            metadata: (chunk.metadata as Record<string, unknown>) ?? {},
          };

          const output = await provider.execute(input, stage.providerConfig);
          const result = output as Record<string, unknown> | null;

          // Apply output to chunk
          if (result) {
            const updateFields: Record<string, unknown> = {};

            if (typeof result.content === 'string' && result.content !== chunk.content) {
              updateFields.content = result.content;
            }

            if (result.metadata && typeof result.metadata === 'object') {
              updateFields.metadata = {
                ...((chunk.metadata as Record<string, unknown>) ?? {}),
                ...(result.metadata as Record<string, unknown>),
              };
            }

            if (Object.keys(updateFields).length > 0) {
              await SearchChunk.findOneAndUpdate(
                { _id: chunk._id, tenantId },
                { $set: updateFields },
              );

              // Update local chunk reference for next stage
              if (updateFields.content) {
                (chunk as any).content = updateFields.content;
              }
            }
          }
        } catch (chunkError) {
          const errMsg = chunkError instanceof Error ? chunkError.message : String(chunkError);
          logger.error('Custom stage failed for chunk', {
            stageId: stage.id,
            chunkId: chunk._id,
            error: errMsg,
          });

          if (stage.onError !== 'continue') {
            throw chunkError;
          }
        }
      }

      executedCount++;
      logger.info('Custom stage completed', {
        stageId: stage.id,
        stageName: stage.name,
        chunksProcessed: chunks.length,
      });
    }

    logger.info('Custom enrichment stages complete', {
      documentId,
      executedCount,
      totalChunks: chunks.length,
    });

    return executedCount;
  } catch (error) {
    logger.error('Failed to execute custom enrichment stages', {
      documentId,
      indexId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Don't break the pipeline — log and continue
    // Custom stages are enhancement, not critical path
    return 0;
  }
}
