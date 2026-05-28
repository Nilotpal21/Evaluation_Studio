/**
 * Platform-wide default configs per pipeline type.
 *
 * Produced by Zod-parsing an empty object through each schema, so `.default()`
 * values are automatically applied. Used as the 3rd-tier fallback in
 * PipelineConfigService.resolveConfig() when no project or tenant config exists.
 */
import {
  SentimentConfigSchema,
  IntentConfigSchema,
  QualityConfigSchema,
  LLMEvaluationConfigSchema,
  StatisticalConfigSchema,
  AnomalyConfigSchema,
  DriftConfigSchema,
  SharedPipelineConfigSchema,
} from './config-schemas.js';
import type { PipelineDefinition } from './types.js';

/** Static defaults — kept for backward compat during migration. */
export const PLATFORM_DEFAULTS: Record<string, Record<string, unknown>> = {
  sentiment_analysis: SentimentConfigSchema.parse({}) as Record<string, unknown>,
  intent_classification: IntentConfigSchema.parse({}) as Record<string, unknown>,
  quality_evaluation: QualityConfigSchema.parse({}) as Record<string, unknown>,
  hallucination_detection: LLMEvaluationConfigSchema.parse({}) as Record<string, unknown>,
  knowledge_gap: LLMEvaluationConfigSchema.parse({}) as Record<string, unknown>,
  guardrail_analysis: LLMEvaluationConfigSchema.parse({}) as Record<string, unknown>,
  context_preservation: LLMEvaluationConfigSchema.parse({ flagThreshold: 0.6 }) as Record<
    string,
    unknown
  >,
  friction_detection: StatisticalConfigSchema.parse({}) as Record<string, unknown>,
  anomaly_detection: AnomalyConfigSchema.parse({}) as Record<string, unknown>,
  drift_detection: DriftConfigSchema.parse({}) as Record<string, unknown>,
  simulation: SharedPipelineConfigSchema.parse({}) as Record<string, unknown>,
};

/**
 * Derive defaults from a definition's embedded configSchema.
 * Falls back to hardcoded shared defaults for fields not declared in configSchema.
 */
export function getPlatformDefaults(definition: PipelineDefinition): Record<string, unknown> {
  const defaults: Record<string, unknown> = {
    samplingRate: 1.0,
    stepOverrides: {},
    timeoutOverrides: {},
  };

  if (definition.configSchema) {
    for (const field of definition.configSchema.fields) {
      if (field.default !== undefined) {
        defaults[field.name] = field.default;
      }
    }
  }

  return defaults;
}
