import {
  ANOMALY_PIPELINE_ID,
  anomalyPipelineDefinition,
  DRIFT_PIPELINE_ID,
  driftPipelineDefinition,
  EVAL_PIPELINE_ID,
  evalPipelineDefinition,
  FRICTION_PIPELINE_ID,
  frictionPipelineDefinition,
  GUARDRAIL_PIPELINE_ID,
  guardrailPipelineDefinition,
  HALLUCINATION_PIPELINE_ID,
  hallucinationPipelineDefinition,
  INTENT_PIPELINE_ID,
  intentPipelineDefinition,
  KNOWLEDGE_GAP_PIPELINE_ID,
  knowledgeGapPipelineDefinition,
  QUALITY_PIPELINE_ID,
  qualityPipelineDefinition,
  SENTIMENT_PIPELINE_ID,
  sentimentPipelineDefinition,
} from '@agent-platform/pipeline-engine';

const BUILTIN_PIPELINE_ENTRIES = [
  {
    canonicalId: SENTIMENT_PIPELINE_ID,
    pipelineType: requirePipelineType(
      SENTIMENT_PIPELINE_ID,
      sentimentPipelineDefinition.pipelineType,
    ),
  },
  {
    canonicalId: INTENT_PIPELINE_ID,
    pipelineType: requirePipelineType(INTENT_PIPELINE_ID, intentPipelineDefinition.pipelineType),
  },
  {
    canonicalId: QUALITY_PIPELINE_ID,
    pipelineType: requirePipelineType(QUALITY_PIPELINE_ID, qualityPipelineDefinition.pipelineType),
  },
  {
    canonicalId: HALLUCINATION_PIPELINE_ID,
    pipelineType: requirePipelineType(
      HALLUCINATION_PIPELINE_ID,
      hallucinationPipelineDefinition.pipelineType,
    ),
  },
  {
    canonicalId: KNOWLEDGE_GAP_PIPELINE_ID,
    pipelineType: requirePipelineType(
      KNOWLEDGE_GAP_PIPELINE_ID,
      knowledgeGapPipelineDefinition.pipelineType,
    ),
  },
  {
    canonicalId: GUARDRAIL_PIPELINE_ID,
    pipelineType: requirePipelineType(
      GUARDRAIL_PIPELINE_ID,
      guardrailPipelineDefinition.pipelineType,
    ),
  },
  {
    canonicalId: FRICTION_PIPELINE_ID,
    pipelineType: requirePipelineType(
      FRICTION_PIPELINE_ID,
      frictionPipelineDefinition.pipelineType,
    ),
  },
  {
    canonicalId: ANOMALY_PIPELINE_ID,
    pipelineType: requirePipelineType(ANOMALY_PIPELINE_ID, anomalyPipelineDefinition.pipelineType),
  },
  {
    canonicalId: DRIFT_PIPELINE_ID,
    pipelineType: requirePipelineType(DRIFT_PIPELINE_ID, driftPipelineDefinition.pipelineType),
  },
  {
    canonicalId: EVAL_PIPELINE_ID,
    pipelineType: requirePipelineType(EVAL_PIPELINE_ID, evalPipelineDefinition.pipelineType),
  },
] as const;

function requirePipelineType(canonicalId: string, pipelineType: string | undefined): string {
  if (!pipelineType) {
    throw new Error(`Builtin pipeline ${canonicalId} is missing pipelineType`);
  }
  return pipelineType;
}

const BUILTIN_PIPELINE_ID_BY_TYPE = new Map<string, string>(
  BUILTIN_PIPELINE_ENTRIES.map(({ canonicalId, pipelineType }) => [pipelineType, canonicalId]),
);

const BUILTIN_PIPELINE_TYPE_BY_ID = new Map<string, string>(
  BUILTIN_PIPELINE_ENTRIES.map(({ canonicalId, pipelineType }) => [canonicalId, pipelineType]),
);

/**
 * Studio addresses builtin pipelines by pipelineType (for example
 * "friction_detection"), while runs and definitions persist the canonical
 * definition id (for example "builtin:friction-detection").
 */
export function toStoredObservabilityPipelineId(pipelineId: string): string {
  return BUILTIN_PIPELINE_ID_BY_TYPE.get(pipelineId) ?? pipelineId;
}

/**
 * Convert stored builtin definition ids back to the pipelineType used by
 * Studio navigation and builtin pipeline cards.
 */
export function toExternalObservabilityPipelineId(pipelineId: string): string {
  return BUILTIN_PIPELINE_TYPE_BY_ID.get(pipelineId) ?? pipelineId;
}
