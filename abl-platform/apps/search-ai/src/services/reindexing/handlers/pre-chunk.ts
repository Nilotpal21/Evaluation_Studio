/**
 * Pre-Chunk Checkpoint Handler (Checkpoint 2)
 *
 * Re-extracts documents from source by dispatching through the existing
 * pipeline flow builder. This destroys existing chunks and creates new ones,
 * then runs all downstream stages (chunking + enrichment + embedding).
 *
 * Reference: docs/searchai/pipelines/REINDEXING-OPTIMIZATION-STRATEGY.md section 7
 */

import { Queue, FlowProducer } from 'bullmq';
import { createLogger } from '@abl/compiler/platform';
import type { ISearchDocument, ISearchPipelineDefinition } from '@agent-platform/database';
import {
  PipelineFlowBuilder,
  checkBackpressure,
  safeAddFlow,
} from '../../pipeline-orchestration/flow-builder.js';
import { getLazyModel } from '../../../db/index.js';

const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');
const SearchPipelineDefinition = getLazyModel<ISearchPipelineDefinition>(
  'SearchPipelineDefinition',
);
import { buildFlowContext } from '../helpers.js';
import type { CheckpointHandler, ReindexAction, ReindexEstimate, ReindexParams } from '../types.js';
import { BULLMQ_CLUSTER_SAFE_PREFIX } from '@agent-platform/redis';
import { getRedisConnection } from '../../../workers/shared.js';

const logger = createLogger('reindex-pre-chunk');

const COST_PER_DOC = 0.005;
const DURATION_PER_DOC_S = 30;

export class PreChunkCheckpointHandler implements CheckpointHandler {
  readonly checkpoint = 2 as const;

  private readonly flowBuilder: PipelineFlowBuilder;
  private readonly flowProducer: FlowProducer;

  constructor(flowBuilder?: PipelineFlowBuilder, flowProducer?: FlowProducer) {
    this.flowBuilder = flowBuilder ?? new PipelineFlowBuilder();
    this.flowProducer =
      flowProducer ??
      new FlowProducer({ connection: getRedisConnection(), prefix: BULLMQ_CLUSTER_SAFE_PREFIX });
  }

  estimate(actions: ReindexAction[]): ReindexEstimate {
    return {
      totalItems: actions.length,
      estimatedDurationMin: Math.ceil((actions.length * DURATION_PER_DOC_S) / 60),
      estimatedCostUsd: parseFloat((actions.length * COST_PER_DOC).toFixed(2)),
    };
  }

  async execute(actions: ReindexAction[], params: ReindexParams): Promise<void> {
    logger.info('Executing pre-chunk checkpoint', {
      totalDocuments: actions.length,
      batchId: params.batchId,
    });

    const pipeline = await SearchPipelineDefinition.findOne({
      _id: params.pipelineId,
      tenantId: params.tenantId,
    }).lean();

    if (!pipeline) {
      throw new Error(
        `Pipeline not found for pre-chunk reindex: pipelineId=${params.pipelineId}, tenantId=${params.tenantId}`,
      );
    }

    const queueCache = new Map<string, Queue>();
    let failureCount = 0;

    try {
      for (const action of actions) {
        if (!action.documentId) continue;

        const doc = await SearchDocument.findOne({
          _id: action.documentId,
          tenantId: params.tenantId,
        }).lean();

        if (!doc) {
          failureCount++;
          logger.warn('Document not found, skipping', {
            documentId: action.documentId,
            batchId: params.batchId,
          });
          continue;
        }

        const context = buildFlowContext(doc);

        const result = await this.flowBuilder.buildFlow(pipeline, {
          documentId: action.documentId,
          tenantId: params.tenantId,
          sourceId: doc.sourceId,
          indexId: params.indexId,
          document: context.document,
          source: context.source,
        });

        if (result.success && result.flow) {
          const queueName = result.flow.queueName;
          if (!queueCache.has(queueName)) {
            queueCache.set(
              queueName,
              new Queue(queueName, {
                connection: getRedisConnection(),
                prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
              }),
            );
          }
          const parentQueue = queueCache.get(queueName)!;

          await checkBackpressure(parentQueue, queueName);
          await safeAddFlow(this.flowProducer, result.flow, parentQueue);

          logger.info('Dispatched pre-chunk reindex flow', {
            documentId: action.documentId,
            flowQueueName: queueName,
            batchId: params.batchId,
          });
        } else {
          failureCount++;
          logger.warn('Failed to build flow for document', {
            documentId: action.documentId,
            error: result.error,
            batchId: params.batchId,
          });
        }
      }
    } finally {
      await Promise.all([...queueCache.values()].map((q) => q.close()));
    }

    if (actions.length > 0 && failureCount === actions.length) {
      throw new Error(`All ${actions.length} documents failed in pre-chunk checkpoint`);
    }
    if (actions.length > 0 && failureCount / actions.length > 0.5) {
      throw new Error(
        `Pre-chunk checkpoint failure rate too high: ${failureCount}/${actions.length} failed`,
      );
    }
  }
}
