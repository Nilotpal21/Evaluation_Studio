/**
 * Embedding Checkpoint Handler (Checkpoint 4)
 *
 * Re-embeds chunks by dispatching to the existing embedding queue.
 * Reuses the existing embedding-worker -- no new worker needed.
 *
 * Reference: docs/searchai/pipelines/REINDEXING-OPTIMIZATION-STRATEGY.md section 8.1
 */

import type { Queue } from 'bullmq';
import { createLogger } from '@abl/compiler/platform';
import { checkBackpressure } from '../../pipeline-orchestration/flow-builder.js';
import { FLOW_CHILD_DEFAULTS } from '../../pipeline-orchestration/types.js';
import type { CheckpointHandler, ReindexAction, ReindexEstimate, ReindexParams } from '../types.js';

const logger = createLogger('reindex-embedding');

const BATCH_SIZE = 100;
const COST_PER_CHUNK = 0.00005;
const DURATION_PER_CHUNK_S = 2;

export class EmbeddingCheckpointHandler implements CheckpointHandler {
  readonly checkpoint = 4 as const;

  constructor(private readonly embeddingQueue: Queue) {}

  estimate(actions: ReindexAction[]): ReindexEstimate {
    return {
      totalItems: actions.length,
      estimatedDurationMin: Math.ceil((actions.length * DURATION_PER_CHUNK_S) / 60),
      estimatedCostUsd: parseFloat((actions.length * COST_PER_CHUNK).toFixed(2)),
    };
  }

  async execute(actions: ReindexAction[], params: ReindexParams): Promise<void> {
    logger.info('Executing embedding checkpoint', {
      totalChunks: actions.length,
      batchId: params.batchId,
    });

    // Filter out actions without documentId (invalid state)
    const validActions = actions.filter((action) => {
      if (!action.documentId) {
        logger.warn('Skipping embedding action with missing documentId', {
          chunkId: action.chunkId,
          batchId: params.batchId,
        });
        return false;
      }
      return true;
    });

    for (let i = 0; i < validActions.length; i += BATCH_SIZE) {
      const batch = validActions.slice(i, i + BATCH_SIZE);

      await checkBackpressure(this.embeddingQueue, 'search-embedding');

      const jobs = await this.embeddingQueue.addBulk(
        batch.map((action) => ({
          name: `reembed-${action.chunkId}`,
          data: {
            indexId: params.indexId,
            documentId: action.documentId,
            chunkIds: action.chunkId ? [action.chunkId] : [],
            tenantId: params.tenantId,
            pipelineId: params.pipelineId,
            knowledgeBaseId: params.knowledgeBaseId,
            mode: 'reindex',
            batchId: params.batchId,
          },
          opts: { ...FLOW_CHILD_DEFAULTS },
        })),
      );

      if (jobs.length !== batch.length) {
        logger.warn('addBulk returned fewer jobs than expected', {
          expected: batch.length,
          actual: jobs.length,
          batchIndex: Math.floor(i / BATCH_SIZE),
          batchId: params.batchId,
        });
      }

      logger.info('Dispatched embedding batch', {
        batchIndex: Math.floor(i / BATCH_SIZE),
        batchSize: batch.length,
        batchId: params.batchId,
      });
    }
  }
}
