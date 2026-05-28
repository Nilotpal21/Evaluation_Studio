import type { LanguageModel } from 'ai';
import { createLogger } from '@abl/compiler/platform';
import { DEFAULT_PIPELINE_CONFIG } from '../pipeline/types.js';
import { resolvePipelineModel } from '../pipeline/model-resolver.js';
import type { OperationType } from '../llm/model-resolution.js';
import type { ResolvedFillerRuntimeConfig } from './types.js';

const log = createLogger('filler-model-resolver');

interface FillerModelSession {
  llmClient?: {
    resolveLanguageModel(operationType: OperationType): Promise<LanguageModel | null>;
    resolveLanguageModelForModelOverride?(
      modelId: string,
      operationType: OperationType,
    ): Promise<LanguageModel | null>;
  };
  tenantId?: string;
  projectId?: string;
}

export async function resolveFillerModel(
  config: ResolvedFillerRuntimeConfig,
  session: FillerModelSession,
): Promise<LanguageModel | null> {
  const preferredOperationType: OperationType = config.promptRef
    ? 'response_gen'
    : 'tool_selection';
  log.debug('Resolving filler model', {
    modelSource: config.modelSource,
    modelId: config.modelId,
    tenantModelId: config.tenantModelId,
    preferredOperationType,
  });

  if (config.modelSource === 'project' && config.modelId) {
    if (!session.llmClient?.resolveLanguageModelForModelOverride) {
      log.warn('Project model override requested for filler but LLM client cannot resolve it', {
        modelId: config.modelId,
        projectId: session.projectId,
      });
      return session.llmClient?.resolveLanguageModel(preferredOperationType) ?? null;
    }

    const model = await session.llmClient.resolveLanguageModelForModelOverride(
      config.modelId,
      preferredOperationType,
    );
    if (model) return model;

    log.warn('Project model resolution failed for filler, falling back to system model', {
      modelId: config.modelId,
      projectId: session.projectId,
    });
    return session.llmClient?.resolveLanguageModel(preferredOperationType) ?? null;
  }

  if (config.modelSource === 'tenant' && config.tenantModelId) {
    return resolvePipelineModel(
      {
        ...DEFAULT_PIPELINE_CONFIG,
        modelSource: 'tenant',
        tenantModelId: config.tenantModelId,
      },
      session,
    );
  }

  const preferredModel = await session.llmClient?.resolveLanguageModel(preferredOperationType);
  if (preferredModel || preferredOperationType === 'tool_selection') {
    return preferredModel ?? null;
  }

  return session.llmClient?.resolveLanguageModel('tool_selection') ?? null;
}
