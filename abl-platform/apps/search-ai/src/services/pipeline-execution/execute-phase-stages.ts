/**
 * Phase-Aware Custom Stage Executor
 *
 * Executes custom pipeline stages (http-webhook)
 * at specific points in the pipeline processing chain.
 */

import { getLazyModel } from '../../db/index.js';
import type { ISearchPipelineDefinition, IKnowledgeBase } from '@agent-platform/database';
import { ProviderRegistry } from '../provider-registry/provider-registry.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('phase-stage-executor');

const KnowledgeBase = getLazyModel<IKnowledgeBase>('KnowledgeBase');
const SearchPipelineDefinition = getLazyModel<ISearchPipelineDefinition>(
  'SearchPipelineDefinition',
);

const CUSTOM_PROVIDER_IDS = ['http-webhook'];

type PipelinePhase =
  | 'before-extraction'
  | 'after-extraction'
  | 'after-chunking'
  | 'after-enrichment';

export async function executeCustomStagesForPhase(
  tenantId: string,
  indexId: string,
  documentId: string,
  phase: PipelinePhase,
  content?: string,
): Promise<{ executedCount: number; content?: string }> {
  try {
    const kb = await KnowledgeBase.findOne({ searchIndexId: indexId, tenantId }).lean();
    if (!kb) return { executedCount: 0 };

    const pipeline = await SearchPipelineDefinition.findOne(
      { knowledgeBaseId: kb._id, tenantId, status: 'active' },
      null,
      { sort: { isDefault: 1 } },
    ).lean();
    if (!pipeline) return { executedCount: 0 };

    // Search ALL enabled flows (sorted by priority) for custom stages matching the phase.
    // Only the first matching flow's stage is executed — higher priority wins.
    const enabledFlows = pipeline.flows
      .filter((f) => f.enabled)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    if (enabledFlows.length === 0) return { executedCount: 0 };

    const phaseStages: (typeof enabledFlows)[0]['stages'] = [];
    for (const flow of enabledFlows) {
      for (const s of flow.stages) {
        if (!CUSTOM_PROVIDER_IDS.includes(s.provider)) continue;
        const config = s.providerConfig as Record<string, unknown>;
        if (config?.entryPoint === phase) {
          phaseStages.push(s);
        }
      }
      if (phaseStages.length > 0) break;
    }

    if (phaseStages.length === 0) return { executedCount: 0 };

    logger.info('Executing custom stages for phase', {
      phase,
      documentId,
      stageCount: phaseStages.length,
    });

    const registry = ProviderRegistry.getInstance();
    let executedCount = 0;
    let currentContent = content;

    for (const stage of phaseStages) {
      let provider;
      try {
        provider = registry.get(stage.type, stage.provider);
      } catch {
        logger.error('Provider not found', {
          stageId: stage.id,
          provider: stage.provider,
          type: stage.type,
        });
        if (stage.onError === 'continue') continue;
        break;
      }

      try {
        const input = {
          documentId,
          content: currentContent ?? '',
          contentType: 'text/plain',
          metadata: {},
        };
        const output = await provider.execute(input, stage.providerConfig);
        const result = output as Record<string, unknown> | null;
        if (result && typeof result.content === 'string') {
          currentContent = result.content;
        }
        executedCount++;
        logger.info('Phase stage executed', { stageId: stage.id, phase });
      } catch (execError) {
        const errMsg = execError instanceof Error ? execError.message : String(execError);
        logger.error('Phase stage failed', { stageId: stage.id, phase, error: errMsg });
        if (stage.onError !== 'continue') break;
      }
    }

    return { executedCount, content: currentContent };
  } catch (error) {
    logger.error('Failed to execute phase stages', {
      phase,
      documentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { executedCount: 0 };
  }
}
