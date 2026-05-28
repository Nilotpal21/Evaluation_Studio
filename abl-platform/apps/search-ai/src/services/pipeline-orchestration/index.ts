/**
 * Pipeline Orchestration Module
 *
 * BullMQ Flows integration for pluggable pipeline architecture.
 *
 * ## Quick Start
 *
 * ```typescript
 * import { PipelineFlowBuilder, safeAddFlow } from './pipeline-orchestration';
 * import { FlowProducer, Queue } from 'bullmq';
 *
 * const builder = new PipelineFlowBuilder();
 * const pipeline = await SearchPipelineDefinition.findOne({ indexId });
 *
 * // Build flow structure
 * const result = await builder.buildFlow(pipeline, {
 *   documentId: 'doc-123',
 *   tenantId: 'tenant-456',
 *   sourceId: 'source-789',
 *   indexId: 'index-abc',
 * });
 *
 * if (result.success) {
 *   // Add flow with validation
 *   const flowProducer = new FlowProducer({ connection });
 *   const parentQueue = new Queue(result.flow.queueName, { connection });
 *   const flowNode = await safeAddFlow(flowProducer, result.flow, parentQueue);
 *
 *   console.log('Flow created:', flowNode.job.id);
 * }
 * ```
 *
 * ## Critical Safety Rules
 *
 * 1. Always use safeAddFlow() instead of FlowProducer.add() directly
 * 2. Check backpressure before adding flows
 * 3. All child jobs have failParentOnFailure: true (automatic)
 * 4. All child jobs have removeOnComplete/removeOnFail (automatic)
 * 5. Per-worker lockDuration configured (automatic)
 *
 * Reference: docs/searchai/BULLMQ-FLOWS-PRODUCTION-GUIDE.md
 */

export {
  PipelineFlowBuilder,
  getWorkerLockSettings,
  checkBackpressure,
  safeAddFlow,
} from './flow-builder.js';

export {
  type FlowBuildContext,
  type FlowBuildResult,
  type LockSettings,
  type PipelineJobContext,
  BackpressureError,
  FlowBuildError,
  FlowCreationValidationError,
  FLOW_CHILD_DEFAULTS,
  MAX_QUEUE_DEPTH,
} from './types.js';

export {
  createDefaultPipeline,
  SYSTEM_TEMPLATE_VERSION,
  DEFAULT_FLOW_ID,
  DOCLING_FLOW_ID,
} from './default-pipeline-template.js';

export {
  syncFlowEmbeddingStages,
  syncFlowEmbeddingStagesForFlow,
  type SyncResult,
} from './embedding-sync.js';
