/**
 * Pipeline Definitions — Barrel Export
 *
 * Single source of truth for all 10 built-in pipeline definitions.
 * Used by server.ts (auto-seed on startup) and the database seed bootstrap.
 */
import type { PipelineDefinition } from '../types.js';

// Individual definition imports
import { sentimentPipelineDefinition, SENTIMENT_PIPELINE_ID } from './sentiment-pipeline.js';
import { intentPipelineDefinition, INTENT_PIPELINE_ID } from './intent-pipeline.js';
import { qualityPipelineDefinition, QUALITY_PIPELINE_ID } from './quality-pipeline.js';
import {
  hallucinationPipelineDefinition,
  HALLUCINATION_PIPELINE_ID,
} from './hallucination-pipeline.js';
import {
  knowledgeGapPipelineDefinition,
  KNOWLEDGE_GAP_PIPELINE_ID,
} from './knowledge-gap-pipeline.js';
import { guardrailPipelineDefinition, GUARDRAIL_PIPELINE_ID } from './guardrail-pipeline.js';
import {
  contextPreservationPipelineDefinition,
  CONTEXT_PRESERVATION_PIPELINE_ID,
} from './context-preservation-pipeline.js';
import { frictionPipelineDefinition, FRICTION_PIPELINE_ID } from './friction-pipeline.js';
import { anomalyPipelineDefinition, ANOMALY_PIPELINE_ID } from './anomaly-pipeline.js';
import { driftPipelineDefinition, DRIFT_PIPELINE_ID } from './drift-pipeline.js';
import { evalPipelineDefinition, EVAL_PIPELINE_ID } from './eval-pipeline.js';

// Re-export individual constants for convenience
export {
  SENTIMENT_PIPELINE_ID,
  sentimentPipelineDefinition,
  INTENT_PIPELINE_ID,
  intentPipelineDefinition,
  QUALITY_PIPELINE_ID,
  qualityPipelineDefinition,
  HALLUCINATION_PIPELINE_ID,
  hallucinationPipelineDefinition,
  KNOWLEDGE_GAP_PIPELINE_ID,
  knowledgeGapPipelineDefinition,
  GUARDRAIL_PIPELINE_ID,
  guardrailPipelineDefinition,
  CONTEXT_PRESERVATION_PIPELINE_ID,
  contextPreservationPipelineDefinition,
  FRICTION_PIPELINE_ID,
  frictionPipelineDefinition,
  ANOMALY_PIPELINE_ID,
  anomalyPipelineDefinition,
  DRIFT_PIPELINE_ID,
  driftPipelineDefinition,
  EVAL_PIPELINE_ID,
  evalPipelineDefinition,
};

/** All 10 built-in pipeline definitions with their IDs */
export const BUILTIN_DEFINITIONS: Array<{
  id: string;
  definition: Omit<PipelineDefinition, '_id'>;
}> = [
  { id: SENTIMENT_PIPELINE_ID, definition: sentimentPipelineDefinition },
  { id: INTENT_PIPELINE_ID, definition: intentPipelineDefinition },
  { id: QUALITY_PIPELINE_ID, definition: qualityPipelineDefinition },
  { id: HALLUCINATION_PIPELINE_ID, definition: hallucinationPipelineDefinition },
  { id: KNOWLEDGE_GAP_PIPELINE_ID, definition: knowledgeGapPipelineDefinition },
  { id: GUARDRAIL_PIPELINE_ID, definition: guardrailPipelineDefinition },
  { id: CONTEXT_PRESERVATION_PIPELINE_ID, definition: contextPreservationPipelineDefinition },
  { id: FRICTION_PIPELINE_ID, definition: frictionPipelineDefinition },
  { id: ANOMALY_PIPELINE_ID, definition: anomalyPipelineDefinition },
  { id: DRIFT_PIPELINE_ID, definition: driftPipelineDefinition },
  { id: EVAL_PIPELINE_ID, definition: evalPipelineDefinition },
];
