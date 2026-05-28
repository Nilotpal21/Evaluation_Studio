/**
 * Pipeline Flow Builder
 *
 * Converts SearchPipelineDefinition into BullMQ FlowJob structures with proper
 * configuration for production use.
 *
 * ## Critical Safety Rules (from BullMQ Flows Production Guide):
 *
 * 1. Always set failParentOnFailure: true on EVERY child
 * 2. Set removeOnComplete/removeOnFail on EVERY child (parent settings don't cascade)
 * 3. Validate FlowProducer.add() succeeded (Issue #3851: silent failures)
 * 4. Check queue depth before adding flows (no built-in backpressure)
 * 5. Set per-worker lockDuration (default 30s too short for long jobs)
 *
 * Reference: docs/searchai/BULLMQ-FLOWS-PRODUCTION-GUIDE.md
 */

import type { FlowJob, FlowProducer, JobsOptions, Queue, Job } from 'bullmq';
import { type JobNode } from 'bullmq';
import type {
  ISearchPipelineDefinition,
  ISearchPipelineFlow,
  ISearchPipelineStage,
} from '@agent-platform/database';
import { createLogger } from '@abl/compiler/platform';
import { FlowSelectionService } from '../flow-selection/flow-selection.service.js';
import {
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

const logger = createLogger('flow-builder');

// ─── Per-Worker Lock Duration Settings ───────────────────────────────────

/**
 * Get lock duration settings for a worker based on stage type.
 *
 * Default lockDuration (30s) is too short for several workers.
 * This function returns appropriate durations based on expected job duration.
 *
 * Reference: docs/searchai/BULLMQ-FLOWS-PRODUCTION-GUIDE.md (lines 596-622)
 *
 * @param queueName - Queue name (e.g., 'search-docling-extraction')
 * @returns Lock duration and stalled interval in milliseconds
 */
export function getWorkerLockSettings(queueName: string): LockSettings {
  switch (queueName) {
    // CPU/long-running stages
    case 'search-docling-extraction':
      return { lockDuration: 600_000, stalledInterval: 300_000 }; // 10 min / 5 min

    case 'search-kg-enrichment':
    case 'search-tree-building':
      return { lockDuration: 300_000, stalledInterval: 150_000 }; // 5 min / 2.5 min

    // I/O-bound LLM stages
    case 'search-enrichment':
    case 'search-question-synthesis':
    case 'search-scope-classification':
      return { lockDuration: 120_000, stalledInterval: 60_000 }; // 2 min / 1 min

    // Embedding/multimodal (batch API calls)
    case 'search-embedding':
    case 'search-multimodal':
    case 'search-visual-enrichment':
      return { lockDuration: 180_000, stalledInterval: 90_000 }; // 3 min / 1.5 min

    // Fast stages
    default:
      return { lockDuration: 60_000, stalledInterval: 30_000 }; // 1 min / 30s
  }
}

// ─── Stage Type to Queue Name Mapping ────────────────────────────────────

/**
 * Map pipeline stage type to BullMQ queue name.
 *
 * Pipeline definitions store `type` (e.g., 'extraction') and `provider`
 * (e.g., 'docling'). The queue name depends on BOTH fields for extraction:
 *   - extraction + provider=docling → search-docling-extraction
 *   - extraction + any other provider → search-extraction (legacy)
 *
 * @param stageType - Stage type from pipeline definition
 * @param provider - Provider for the stage (used to disambiguate extraction queues)
 * @returns Queue name
 */
function getQueueName(stageType: string, provider?: string): string {
  // Extraction queue depends on provider (docling vs legacy)
  if (stageType === 'extraction') {
    return provider === 'docling' ? 'search-docling-extraction' : 'search-extraction';
  }

  // Direct mapping for all other stages
  const queueMap: Record<string, string> = {
    'docling-extraction': 'search-docling-extraction',
    'page-processing': 'search-page-processing',
    chunking: 'search-page-processing', // Pipeline defs use 'chunking'; queue is page-processing
    'canonical-mapper': 'search-canonical-mapper',
    enrichment: 'search-enrichment',
    'content-intelligence': 'search-enrichment',
    'visual-analysis': 'search-visual-enrichment',
    'kg-enrichment': 'search-kg-enrichment',
    embedding: 'search-embedding',
    multimodal: 'search-multimodal',
    'visual-enrichment': 'search-visual-enrichment',
    'tree-building': 'search-tree-building',
    'question-synthesis': 'search-question-synthesis',
    'scope-classification': 'search-scope-classification',
    'field-mapping': 'search-field-mapping',
    'api-webhook': 'search-api-webhook',
    'llm-stage': 'search-llm-stage',
    cleanup: 'search-cleanup',
  };

  return queueMap[stageType] || `search-${stageType}`;
}

// ─── Backpressure Check ──────────────────────────────────────────────────

/**
 * Check if queue depth exceeds backpressure threshold.
 *
 * BullMQ has NO built-in backpressure mechanism. This prevents Redis OOM
 * when downstream services are slow.
 *
 * Reference: docs/searchai/BULLMQ-FLOWS-PRODUCTION-GUIDE.md (lines 291-302)
 *
 * @param queue - BullMQ queue instance
 * @param queueName - Queue name for logging
 * @throws BackpressureError if queue depth exceeds threshold
 */
export async function checkBackpressure(queue: Queue, queueName: string): Promise<void> {
  const waitingCount = await queue.getWaitingCount();
  const maxDepth = MAX_QUEUE_DEPTH[queueName] ?? 500;

  if (waitingCount > maxDepth) {
    throw new BackpressureError(
      `Queue ${queueName} depth ${waitingCount} exceeds limit ${maxDepth}`,
      queueName,
      waitingCount,
      maxDepth,
      30_000, // Retry after 30 seconds
    );
  }
}

// ─── Flow Builder ────────────────────────────────────────────────────────

/**
 * Pipeline Flow Builder
 *
 * Converts SearchPipelineDefinition into BullMQ FlowJob structures.
 */
export class PipelineFlowBuilder {
  private readonly flowSelection: FlowSelectionService;

  constructor(flowSelection?: FlowSelectionService) {
    this.flowSelection = flowSelection ?? new FlowSelectionService();
  }

  /**
   * Build a BullMQ flow from pipeline definition.
   *
   * Algorithm:
   * 1. Select matching flow based on document context via FlowSelectionService
   * 2. Convert PipelineFlow.stages[] into BullMQ FlowJob structure
   * 3. Apply FLOW_CHILD_DEFAULTS to every child
   * 4. Apply per-worker lockDuration overrides
   * 5. Add pipeline context to job data
   *
   * @param pipeline - Pipeline definition from MongoDB
   * @param context - Document and tenant context (includes document metadata for flow selection)
   * @returns Flow build result with FlowJob structure
   *
   * @example
   * ```typescript
   * const builder = new PipelineFlowBuilder();
   * const result = await builder.buildFlow(pipeline, {
   *   documentId: 'doc-123',
   *   tenantId: 'tenant-456',
   *   sourceId: 'source-789',
   *   indexId: 'index-abc',
   *   document: { extension: 'pdf', mimeType: 'application/pdf', size: 1048576, name: 'report.pdf' },
   *   source: { connector: 'google-drive' },
   * });
   *
   * if (result.success) {
   *   const flowJobId = await flowProducer.add(result.flow);
   * }
   * ```
   */
  async buildFlow(
    pipeline: ISearchPipelineDefinition,
    context: FlowBuildContext,
  ): Promise<FlowBuildResult> {
    const startTime = Date.now();

    logger.info('Building flow from pipeline', {
      pipelineId: pipeline._id,
      pipelineVersion: pipeline.version,
      documentId: context.documentId,
      tenantId: context.tenantId,
      documentMimeType: context.document.mimeType,
      documentExtension: context.document.extension,
    });

    try {
      // Select matching flow based on document context
      const selectionResult = await this.flowSelection.selectFlow(pipeline.flows, context);

      if (!selectionResult.success || !selectionResult.flow) {
        return {
          success: false,
          error: selectionResult.error || 'No flow matched document',
          details: {
            pipelineId: pipeline._id as string,
            stageCount: 0,
            queueNames: [],
          },
        };
      }

      const selectedFlow = selectionResult.flow;

      // Build pipeline context (added to every job.data)
      const pipelineContext: PipelineJobContext = {
        pipelineId: pipeline._id as string,
        pipelineVersion: pipeline.version,
        flowJobId: '', // Will be set after FlowProducer.add()
        documentId: context.documentId,
        tenantId: context.tenantId,
        sourceId: context.sourceId,
        indexId: context.indexId,
      };

      // Build flow structure
      const flow = this.buildFlowJob(selectedFlow, pipelineContext, context);

      // Collect queue names for details
      const queueNames = this.collectQueueNames(flow);

      const duration = Date.now() - startTime;

      logger.info('Flow built successfully', {
        pipelineId: pipeline._id,
        flowName: selectedFlow.name,
        stageCount: selectedFlow.stages.length,
        duration,
      });

      return {
        success: true,
        flow,
        details: {
          pipelineId: pipeline._id as string,
          selectedFlowId: selectedFlow.id,
          stageCount: selectedFlow.stages.length,
          queueNames,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error('Flow build failed', {
        pipelineId: pipeline._id,
        error: error instanceof Error ? error.message : String(error),
        duration,
      });

      throw new FlowBuildError(
        `Failed to build flow: ${error instanceof Error ? error.message : String(error)}`,
        pipeline._id as string,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Build FlowJob structure from PipelineFlow.
   *
   * Matches the document-upload.ts pattern exactly:
   * 1. Routes extraction to the correct queue based on provider (docling vs legacy)
   * 2. Attaches pipelineStage config (extraction worker reads it for provenance)
   * 3. Attaches downstream stage configs (_chunkingStage, _enrichmentStage, _embeddingStage)
   *    so each worker can propagate them through the chain
   *
   * @param flow - Pipeline flow definition
   * @param pipelineContext - Pipeline context for job data
   * @param context - Build context
   * @returns FlowJob structure
   */
  private buildFlowJob(
    flow: ISearchPipelineFlow,
    pipelineContext: PipelineJobContext,
    context: FlowBuildContext,
  ): FlowJob {
    // Get first stage (entry point — always extraction)
    const firstStage = flow.stages[0];
    if (!firstStage) {
      throw new FlowBuildError('Flow has no stages', flow.id);
    }

    // Route extraction queue based on provider (docling → search-docling-extraction)
    const queueName = getQueueName(firstStage.type, firstStage.provider);

    // Build job options with FLOW_CHILD_DEFAULTS
    const opts: JobsOptions = {
      ...FLOW_CHILD_DEFAULTS,
    };

    // ── Sequential chaining via job data (NOT BullMQ Flow children) ──────
    // Each worker in the pipeline chains to the next stage independently by
    // enqueuing a job on completion (extraction → page-processing → enrichment
    // → embedding). BullMQ Flow children execute BEFORE the parent, which is
    // the opposite of what the pipeline needs — extraction must finish and
    // create chunks before enrichment/embedding can run.
    //
    // Instead, we inject downstream stage configs into the first stage's job
    // data as _chunkingStage, _enrichmentStage, _embeddingStage. Each worker
    // reads these and passes them forward when chaining. This matches the
    // pattern used by document-upload.ts and ingestion-worker.ts.

    // Build a findStage helper matching document-upload.ts pattern (lines 506-515)
    const findStage = (
      type: string,
    ):
      | { pipelineId: string; flowId: string; provider: string; providerConfig: unknown }
      | undefined => {
      const s = flow.stages.find((st) => st.type === type);
      if (!s) return undefined;
      return {
        pipelineId: pipelineContext.pipelineId,
        flowId: flow.id,
        provider: s.provider,
        providerConfig: s.providerConfig,
      };
    };

    // Resolve stage configs exactly like document-upload.ts (lines 516-519)
    const extractionStage = findStage('extraction');
    const chunkingStage = findStage('chunking');
    const enrichmentStage = findStage('enrichment');
    const embeddingStage = findStage('embedding');

    // Build job data matching DoclingExtractionJobData / ExtractionJobData shape
    const jobData: Record<string, unknown> = {
      ...pipelineContext,
      // sourceUrl is required by both extraction workers (docling reads from S3/URL)
      sourceUrl: context.sourceUrl || '',
      stageType: firstStage.type,
      provider: firstStage.provider,
      providerConfig: firstStage.providerConfig,
      // pipelineStage: extraction worker reads this for provenance tracking
      pipelineStage: extractionStage,
    };

    // Attach downstream stage configs for worker chain propagation
    // (docling-extraction-worker reads these at lines 448-456 and forwards to page-processing)
    if (chunkingStage) jobData._chunkingStage = chunkingStage;
    if (enrichmentStage) jobData._enrichmentStage = enrichmentStage;
    if (embeddingStage) jobData._embeddingStage = embeddingStage;

    // Add V2 pipeline fields
    jobData.executionCondition = firstStage.executionCondition || null;
    jobData.onError = firstStage.onError || 'fail';
    jobData.fallbackProvider = firstStage.fallbackProvider || null;
    jobData.fallbackConfig = firstStage.fallbackConfig || null;

    return {
      name: `${context.documentId}-${flow.name}`,
      queueName,
      data: jobData,
      opts,
      // No children — workers chain sequentially via their own queue.add() calls
    };
  }

  /**
   * Build children FlowJob array from remaining stages.
   *
   * @param stages - Remaining stages after first
   * @param pipelineContext - Pipeline context for job data
   * @returns Array of FlowJob children
   */
  private buildChildren(
    stages: ISearchPipelineStage[],
    pipelineContext: PipelineJobContext,
  ): FlowJob[] | undefined {
    if (stages.length === 0) {
      return undefined;
    }

    // Convert each stage to a FlowJob
    return stages.map((stage) => {
      const queueName = getQueueName(stage.type, stage.provider);

      const opts: JobsOptions = {
        ...FLOW_CHILD_DEFAULTS,
      };

      return {
        name: `${pipelineContext.documentId}-${stage.type}`,
        queueName,
        data: {
          ...pipelineContext,
          stageType: stage.type,
          provider: stage.provider,
          providerConfig: stage.providerConfig,
          executionCondition: stage.executionCondition || null,
          onError: stage.onError || 'fail',
          fallbackProvider: stage.fallbackProvider || null,
          fallbackConfig: stage.fallbackConfig || null,
        },
        opts,
      };
    });
  }

  /**
   * Collect all queue names used in flow (for logging/debugging).
   *
   * @param flow - FlowJob structure
   * @returns Array of unique queue names
   */
  private collectQueueNames(flow: FlowJob): string[] {
    const names = new Set<string>([flow.queueName]);

    if (flow.children) {
      for (const child of flow.children) {
        names.add(child.queueName);
      }
    }

    return Array.from(names);
  }
}

// ─── Flow Producer Validation Wrapper ────────────────────────────────────

/**
 * Safely add a flow with validation.
 *
 * CRITICAL: FlowProducer.add() fails silently during Redis READONLY maintenance.
 * Issue #3851 (OPEN, March 2026): No upstream fix coming soon.
 *
 * This wrapper verifies the parent job actually exists in Redis after creation.
 *
 * Reference: docs/searchai/BULLMQ-FLOWS-PRODUCTION-GUIDE.md (lines 167-186)
 *
 * @param flowProducer - FlowProducer instance
 * @param flow - FlowJob to add
 * @param parentQueue - Queue for parent job verification
 * @returns Job node from FlowProducer.add()
 * @throws FlowCreationValidationError if parent job doesn't exist
 *
 * @example
 * ```typescript
 * const flowProducer = new FlowProducer({ connection });
 * const parentQueue = new Queue(flow.queueName, { connection });
 *
 * try {
 *   const result = await safeAddFlow(flowProducer, flow, parentQueue);
 *   logger.info('Flow created', { flowJobId: result.job.id });
 * } catch (error) {
 *   if (error instanceof FlowCreationValidationError) {
 *     // Redis may be in READONLY mode
 *     logger.error('Flow creation failed silently');
 *   }
 * }
 * ```
 */
export async function safeAddFlow(
  flowProducer: FlowProducer,
  flow: FlowJob,
  parentQueue: Queue,
): Promise<JobNode> {
  // Add flow
  const result = await flowProducer.add(flow);

  // Verify the parent job actually exists in Redis
  const jobId = result.job.id;
  if (!jobId) {
    throw new FlowCreationValidationError(
      `Flow creation failed silently for ${flow.name}. Redis may be in READONLY mode.`,
      flow.name,
      '',
    );
  }

  const job = await parentQueue.getJob(jobId);

  if (!job) {
    throw new FlowCreationValidationError(
      `Flow creation failed silently for ${flow.name}. Redis may be in READONLY mode.`,
      flow.name,
      jobId,
    );
  }

  logger.info('Flow created and validated', {
    flowName: flow.name,
    flowJobId: jobId,
    queueName: flow.queueName,
  });

  return result;
}
