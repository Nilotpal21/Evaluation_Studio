/**
 * Pipeline Config Resolution
 *
 * Resolves pipeline configuration from:
 *   Agent IR execution.pipeline → Project config → hardcoded defaults
 */

import type { IRExecutionConfig } from '@abl/compiler';
import { DEFAULT_PIPELINE_CONFIG, type IntentBridgeConfig, type PipelineConfig } from './types.js';

type PipelineConfigOverride = {
  enabled?: boolean;
  mode?: PipelineConfig['mode'];
  modelSource?: PipelineConfig['modelSource'];
  tenantModelId?: string;
  /** @deprecated Ignored — use modelSource + tenantModelId instead */
  model?: string;
  shortCircuit?: Partial<PipelineConfig['shortCircuit']>;
  toolFilter?: Partial<PipelineConfig['toolFilter']>;
  keywordVeto?: Partial<PipelineConfig['keywordVeto']>;
  intentBridge?: Partial<IntentBridgeConfig>;
};

/**
 * Resolve pipeline configuration from agent-level and project-level overrides.
 * Agent-level fields override project-level where specified. Unset fields
 * fall through to project, then to defaults.
 */
export function resolvePipelineConfig(
  agentExecution?: IRExecutionConfig,
  projectPipeline?: PipelineConfigOverride,
): PipelineConfig {
  const agent = agentExecution?.pipeline;
  const project = projectPipeline;

  return {
    enabled: agent?.enabled ?? project?.enabled ?? DEFAULT_PIPELINE_CONFIG.enabled,
    mode: agent?.mode ?? project?.mode ?? DEFAULT_PIPELINE_CONFIG.mode,
    modelSource: agent?.modelSource ?? project?.modelSource ?? DEFAULT_PIPELINE_CONFIG.modelSource,
    tenantModelId: agent?.tenantModelId ?? project?.tenantModelId ?? undefined,
    shortCircuit: {
      enabled:
        agent?.shortCircuit?.enabled ??
        project?.shortCircuit?.enabled ??
        DEFAULT_PIPELINE_CONFIG.shortCircuit.enabled,
      confidenceThreshold:
        agent?.shortCircuit?.confidenceThreshold ??
        project?.shortCircuit?.confidenceThreshold ??
        DEFAULT_PIPELINE_CONFIG.shortCircuit.confidenceThreshold,
    },
    toolFilter: {
      enabled:
        agent?.toolFilter?.enabled ??
        project?.toolFilter?.enabled ??
        DEFAULT_PIPELINE_CONFIG.toolFilter.enabled,
      maxTools:
        agent?.toolFilter?.maxTools ??
        project?.toolFilter?.maxTools ??
        DEFAULT_PIPELINE_CONFIG.toolFilter.maxTools,
    },
    keywordVeto: {
      enabled:
        agent?.keywordVeto?.enabled ??
        project?.keywordVeto?.enabled ??
        DEFAULT_PIPELINE_CONFIG.keywordVeto.enabled,
      keywords:
        agent?.keywordVeto?.keywords ??
        project?.keywordVeto?.keywords ??
        DEFAULT_PIPELINE_CONFIG.keywordVeto.keywords,
    },
    intentBridge: {
      enabled:
        agent?.intentBridge?.enabled ??
        project?.intentBridge?.enabled ??
        DEFAULT_PIPELINE_CONFIG.intentBridge.enabled,
      programmaticThreshold:
        agent?.intentBridge?.programmaticThreshold ??
        project?.intentBridge?.programmaticThreshold ??
        DEFAULT_PIPELINE_CONFIG.intentBridge.programmaticThreshold,
      guidedThreshold:
        agent?.intentBridge?.guidedThreshold ??
        project?.intentBridge?.guidedThreshold ??
        DEFAULT_PIPELINE_CONFIG.intentBridge.guidedThreshold,
      outOfScopeDecline:
        agent?.intentBridge?.outOfScopeDecline ??
        project?.intentBridge?.outOfScopeDecline ??
        DEFAULT_PIPELINE_CONFIG.intentBridge.outOfScopeDecline,
      multiIntentSignal:
        agent?.intentBridge?.multiIntentSignal ??
        project?.intentBridge?.multiIntentSignal ??
        DEFAULT_PIPELINE_CONFIG.intentBridge.multiIntentSignal,
    },
  };
}
