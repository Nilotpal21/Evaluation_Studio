/**
 * Reindexing Service
 *
 * 4-checkpoint reindexing system for pipeline changes.
 *
 * Reference: docs/searchai/pipelines/REINDEXING-OPTIMIZATION-STRATEGY.md
 */

export { identifyChanges, hasRoutingChanged, findStageChanges } from './change-identifier.js';
export { buildReindexPlan } from './router.js';
export { ReindexOrchestrator } from './orchestrator.js';
export type { AnalyzeResult } from './orchestrator.js';
export { createReindexOrchestrator } from './factory.js';
export type { OrchestratorOptions } from './factory.js';

export {
  STAGE_ORDER,
  getDownstreamStages,
  stageToCheckpoint,
  findEarliestDifferingStage,
  buildFlowContext,
  deepEqual,
  buildSummary,
} from './helpers.js';

export type {
  ChangeSet,
  FlowStageChange,
  PersistedChangeSet,
  ReindexAction,
  ReindexEstimate,
  ReindexPlan,
  ReindexSummary,
  ReindexParams,
  ReindexResult,
  ChangeStore,
  CheckpointHandler,
  ReindexTrigger,
  TriggerContext,
} from './types.js';

export { EmbeddingCheckpointHandler } from './handlers/embedding.js';
export { PreChunkCheckpointHandler } from './handlers/pre-chunk.js';
export { PostChunkCheckpointHandler } from './handlers/post-chunk.js';
export { MongoChangeStore } from './stores/mongo.js';
