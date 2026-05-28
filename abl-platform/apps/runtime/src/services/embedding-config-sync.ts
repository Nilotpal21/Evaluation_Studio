/**
 * Embedding Config Sync Service
 *
 * Syncs tenant-level embedding model changes to SearchAI pipeline configurations.
 * When an embedding model is updated in LLM Models, this service ensures all
 * pipelines using that model are updated and reindexing is triggered.
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('embedding-config-sync');

interface EmbeddingModelUpdate {
  provider?: string;
  modelId?: string;
  dimensions?: number;
}

interface PipelineEmbeddingUpdate {
  provider: string;
  model: string;
  dimensions: number;
  confirm: boolean;
}

/**
 * Sync embedding model changes to all affected SearchAI pipelines.
 *
 * Finds all pipelines using the updated model and triggers the
 * PATCH /embedding-config endpoint for each, which handles:
 * - Updating activeEmbeddingConfig
 * - Syncing all flow embedding stages
 * - Triggering reindexing
 *
 * @param tenantId - Tenant ID
 * @param modelId - ID of the updated tenant model
 * @param updates - Fields that were updated (provider, modelId, dimensions)
 * @returns Summary of sync results
 */
export async function syncEmbeddingModelToPipelines(
  tenantId: string,
  modelId: string,
  updates: EmbeddingModelUpdate,
): Promise<{
  success: boolean;
  syncedCount: number;
  failedCount: number;
  errors: Array<{ pipelineId: string; error: string }>;
}> {
  log.info('Starting embedding model sync to pipelines', {
    tenantId,
    modelId,
    updates,
  });

  // Skip if no embedding-relevant fields were updated
  if (!updates.provider && !updates.modelId && !updates.dimensions) {
    log.debug('No embedding-relevant fields updated, skipping pipeline sync', { modelId });
    return { success: true, syncedCount: 0, failedCount: 0, errors: [] };
  }

  try {
    // First, fetch the TenantModel to get the actual model name
    const { TenantModel, SearchPipelineDefinition } =
      await import('@agent-platform/database/models');

    const tenantModel = await TenantModel.findOne({ _id: modelId, tenantId }).lean();
    if (!tenantModel) {
      log.warn('TenantModel not found, skipping pipeline sync', { tenantId, modelId });
      return { success: true, syncedCount: 0, failedCount: 0, errors: [] };
    }

    const actualModelName = (tenantModel as any).modelId; // This is the actual model name like "bge-m3" or "text-embedding-3-large"

    log.info('Resolved TenantModel', {
      tenantId,
      tenantModelId: modelId,
      actualModelName,
      provider: (tenantModel as any).provider,
    });

    // Find all pipelines using this model name
    const pipelines = await SearchPipelineDefinition.find({
      tenantId,
      'activeEmbeddingConfig.model': actualModelName,
    }).select('_id knowledgeBaseId activeEmbeddingConfig');

    if (pipelines.length === 0) {
      log.info('No pipelines using this model, skipping sync', {
        tenantId,
        tenantModelId: modelId,
        actualModelName,
      });
      return { success: true, syncedCount: 0, failedCount: 0, errors: [] };
    }

    log.info('Found pipelines to sync', {
      tenantId,
      tenantModelId: modelId,
      actualModelName,
      pipelineCount: pipelines.length,
    });

    // Get project context for each pipeline
    const { KnowledgeBase } = await import('@agent-platform/database/models');
    const kbIds = [...new Set(pipelines.map((p: any) => p.knowledgeBaseId))];
    const kbs = await KnowledgeBase.find({ _id: { $in: kbIds } }).select('_id projectId');
    const kbProjectMap = new Map(kbs.map((kb: any) => [kb._id, kb.projectId]));

    const searchAiUrl = process.env.SEARCH_AI_URL || 'http://localhost:3005';

    let syncedCount = 0;
    let failedCount = 0;
    const errors: Array<{ pipelineId: string; error: string }> = [];

    // Sync each pipeline sequentially (to avoid overwhelming SearchAI)
    for (const pipeline of pipelines) {
      const projectId = kbProjectMap.get((pipeline as any).knowledgeBaseId);
      if (!projectId) {
        log.warn('Could not resolve projectId for pipeline', {
          pipelineId: (pipeline as any)._id,
          knowledgeBaseId: (pipeline as any).knowledgeBaseId,
        });
        failedCount++;
        errors.push({
          pipelineId: (pipeline as any)._id,
          error: 'Could not resolve projectId',
        });
        continue;
      }

      try {
        // Build the update payload with new values merged with existing config
        const currentConfig = (pipeline as any).activeEmbeddingConfig;
        const updatePayload: PipelineEmbeddingUpdate = {
          provider: updates.provider || currentConfig.provider,
          model: updates.modelId || currentConfig.model,
          dimensions: updates.dimensions || currentConfig.dimensions,
          confirm: true, // Auto-confirm
        };

        const baseUrl = `${searchAiUrl}/api/projects/${projectId}/knowledge-bases/${(pipeline as any).knowledgeBaseId}/pipelines/${(pipeline as any)._id}`;

        log.debug('Syncing pipeline embedding config', {
          pipelineId: (pipeline as any)._id,
          kbId: (pipeline as any).knowledgeBaseId,
          projectId,
          updatePayload,
        });

        // Step 1: PATCH /embedding-config to update the config
        const patchResponse = await fetch(`${baseUrl}/embedding-config`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-Tenant-Id': tenantId,
          },
          body: JSON.stringify(updatePayload),
        });

        if (!patchResponse.ok) {
          const errorData = (await patchResponse
            .json()
            .catch(() => ({ error: 'Unknown error' }))) as {
            error?: { message?: string } | string;
          };
          const errorMessage =
            typeof errorData.error === 'object'
              ? errorData.error?.message
              : errorData.error || `HTTP ${patchResponse.status}`;
          throw new Error(errorMessage);
        }

        const patchResult = (await patchResponse.json()) as {
          data?: { reindexRequired?: boolean };
        };

        log.info('Pipeline embedding config updated', {
          pipelineId: (pipeline as any)._id,
          reindexRequired: patchResult.data?.reindexRequired || false,
        });

        // Step 2: POST /reindex to trigger actual reindexing
        if (patchResult.data?.reindexRequired) {
          const reindexResponse = await fetch(`${baseUrl}/reindex`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Tenant-Id': tenantId,
            },
          });

          if (!reindexResponse.ok) {
            const errorData = (await reindexResponse
              .json()
              .catch(() => ({ error: 'Unknown error' }))) as {
              error?: string;
            };
            throw new Error(errorData.error || `Reindex failed: HTTP ${reindexResponse.status}`);
          }

          const reindexResult = (await reindexResponse.json()) as {
            batchId?: string;
            totalItems?: number;
          };

          log.info('Pipeline reindexing triggered successfully', {
            pipelineId: (pipeline as any)._id,
            batchId: reindexResult.batchId,
            totalItems: reindexResult.totalItems,
          });
        }

        syncedCount++;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.error('Failed to sync pipeline embedding config', {
          pipelineId: (pipeline as any)._id,
          error: errorMsg,
        });
        failedCount++;
        errors.push({
          pipelineId: (pipeline as any)._id,
          error: errorMsg,
        });
      }
    }

    log.info('Embedding model sync to pipelines completed', {
      tenantId,
      modelId,
      total: pipelines.length,
      syncedCount,
      failedCount,
    });

    return {
      success: failedCount === 0,
      syncedCount,
      failedCount,
      errors,
    };
  } catch (err) {
    log.error('Failed to sync embedding model to pipelines', {
      tenantId,
      modelId,
      error: err instanceof Error ? err.message : String(err),
    });

    return {
      success: false,
      syncedCount: 0,
      failedCount: 0,
      errors: [{ pipelineId: 'ALL', error: err instanceof Error ? err.message : String(err) }],
    };
  }
}
