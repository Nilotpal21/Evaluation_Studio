/**
 * Queue Configuration
 *
 * Exports BullMQ queues for the search-ai ingestion pipeline.
 * All workers use these shared queue instances for job enqueueing.
 *
 * **Lazy Initialization:**
 * Queues are created on-demand when first accessed. If Redis is unavailable,
 * queue getters return null and callers must handle gracefully.
 */

export {
  // Queue getters (lazy, return Queue | null)
  getIngestionQueue,
  getExtractionQueue,
  getDoclingExtractionQueue,
  getPageProcessingQueue,
  getCanonicalMapQueue,
  getQuestionSynthesisQueue,
  getVisualEnrichmentQueue,
  getEnrichmentQueue,
  getEmbeddingQueue,
  getTreeBuildingQueue,
  getMultimodalQueue,
  getScopeClassificationQueue,
  getCleanupQueue,
  // Utilities
  isRedisAvailable,
  closeAllQueues,
  resetQueueFactory,
} from './queue-factory.js';
