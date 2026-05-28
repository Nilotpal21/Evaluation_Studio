/**
 * Reindex Orchestrator Factory
 *
 * Wires default implementations: MongoChangeStore + 3 checkpoint handlers.
 * Accepts optional overrides for testing or custom deployments.
 *
 * Reference: docs/searchai/pipelines/REINDEXING-OPTIMIZATION-STRATEGY.md section 8
 */

import type { Queue } from 'bullmq';
import { getEmbeddingQueue, getEnrichmentQueue } from '../../queues/index.js';
import { EmbeddingCheckpointHandler } from './handlers/embedding.js';
import { PreChunkCheckpointHandler } from './handlers/pre-chunk.js';
import { PostChunkCheckpointHandler } from './handlers/post-chunk.js';
import { MongoChangeStore } from './stores/mongo.js';
import { ReindexOrchestrator } from './orchestrator.js';
import type { ChangeStore, CheckpointHandler } from './types.js';

export interface OrchestratorOptions {
  store?: ChangeStore;
  handlers?: CheckpointHandler[];
  embeddingQueue?: Queue;
  enrichmentQueue?: Queue;
}

/**
 * Create a ReindexOrchestrator with default wiring.
 *
 * Default store: MongoChangeStore
 * Default handlers: PreChunk (2), PostChunk (3), Embedding (4)
 * Checkpoint 1 (routing) is handled by the router producing actions that
 * map to checkpoint 2/3/4 based on the earliest differing stage.
 */
export function createReindexOrchestrator(options: OrchestratorOptions = {}): ReindexOrchestrator {
  const store = options.store ?? new MongoChangeStore();

  const eQueue = options.embeddingQueue ?? getEmbeddingQueue();
  const enQueue = options.enrichmentQueue ?? getEnrichmentQueue();

  if (!eQueue || !enQueue) {
    throw new Error(
      'Cannot create ReindexOrchestrator: Redis queues unavailable. ' +
        'Ensure Redis is configured (REDIS_URL or REDIS_HOST).',
    );
  }

  const handlers = options.handlers ?? [
    new PreChunkCheckpointHandler(),
    new PostChunkCheckpointHandler(enQueue),
    new EmbeddingCheckpointHandler(eQueue),
  ];

  return new ReindexOrchestrator(store, handlers);
}
