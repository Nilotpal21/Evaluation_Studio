/**
 * Post-Chunk Checkpoint Handler (Checkpoint 3)
 *
 * Re-enriches existing chunks by dispatching to the enrichment queue.
 * Chunks already exist -- just re-run enrichment + embedding downstream.
 *
 * Reference: docs/searchai/pipelines/REINDEXING-OPTIMIZATION-STRATEGY.md section 7
 */

import type { Queue } from 'bullmq';
import { createLogger } from '@abl/compiler/platform';
import { checkBackpressure } from '../../pipeline-orchestration/flow-builder.js';
import { FLOW_CHILD_DEFAULTS } from '../../pipeline-orchestration/types.js';
import type { CheckpointHandler, ReindexAction, ReindexEstimate, ReindexParams } from '../types.js';

const logger = createLogger('reindex-post-chunk');

const BATCH_SIZE = 100;
const COST_PER_CHUNK = 0.002;
const DURATION_PER_CHUNK_S = 10;

export class PostChunkCheckpointHandler implements CheckpointHandler {
  readonly checkpoint = 3 as const;

  constructor(private readonly enrichmentQueue: Queue) {}

  estimate(actions: ReindexAction[]): ReindexEstimate {
    return {
      totalItems: actions.length,
      estimatedDurationMin: Math.ceil((actions.length * DURATION_PER_CHUNK_S) / 60),
      estimatedCostUsd: parseFloat((actions.length * COST_PER_CHUNK).toFixed(2)),
    };
  }

  async execute(actions: ReindexAction[], params: ReindexParams): Promise<void> {
    logger.info('Executing post-chunk checkpoint', {
      totalChunks: actions.length,
      batchId: params.batchId,
    });

    for (let i = 0; i < actions.length; i += BATCH_SIZE) {
      const batch = actions.slice(i, i + BATCH_SIZE);

      await checkBackpressure(this.enrichmentQueue, 'search-enrichment');

      const jobs = await this.enrichmentQueue.addBulk(
        batch.map((action) => ({
          name: `reenrich-${action.chunkId}`,
          data: {
            chunkId: action.chunkId,
            documentId: action.documentId,
            indexId: params.indexId,
            flowId: action.flowId,
            tenantId: params.tenantId,
            pipelineId: params.pipelineId,
            knowledgeBaseId: params.knowledgeBaseId,
            stages: action.stages,
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

      logger.info('Dispatched enrichment batch', {
        batchIndex: Math.floor(i / BATCH_SIZE),
        batchSize: batch.length,
        batchId: params.batchId,
      });
    }
  }
}
