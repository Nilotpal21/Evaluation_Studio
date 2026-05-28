/**
 * Lazy Queue Factory
 *
 * Creates BullMQ queues on-demand with graceful Redis connection handling.
 * Queues are only instantiated when first accessed, and if Redis is unavailable,
 * operations degrade gracefully rather than crashing at module import time.
 *
 * Uses @agent-platform/redis for connection management — the shared package
 * handles URL parsing, port defaults, TLS, and BullMQ-specific configuration
 * (maxRetriesPerRequest: null for blocking commands).
 */

import { Queue } from 'bullmq';
import {
  QUEUE_INGESTION,
  QUEUE_EXTRACTION,
  QUEUE_DOCLING_EXTRACTION,
  QUEUE_WORKFLOW_DOCLING_EXTRACTION,
  QUEUE_PAGE_PROCESSING,
  QUEUE_TREE_BUILDING,
  QUEUE_CANONICAL_MAP,
  QUEUE_ENRICHMENT,
  QUEUE_EMBEDDING,
  QUEUE_MULTIMODAL,
  QUEUE_QUESTION_SYNTHESIS,
  QUEUE_SCOPE_CLASSIFICATION,
  QUEUE_VISUAL_ENRICHMENT,
  QUEUE_CLEANUP,
} from '@agent-platform/search-ai-sdk';
import {
  BULLMQ_CLUSTER_SAFE_PREFIX,
  createRedisConnection,
  resolveRedisOptionsFromEnv,
  type RedisConnectionHandle,
  type RedisClient,
} from '@agent-platform/redis';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('queue-factory');

// =============================================================================
// REDIS CONNECTION (cluster-aware handle)
// =============================================================================

let _handle: RedisConnectionHandle | null | undefined;

function getHandle(): RedisConnectionHandle | null {
  if (_handle !== undefined) return _handle;
  const opts = resolveRedisOptionsFromEnv();
  if (!opts) {
    log.warn('Redis explicitly disabled (REDIS_ENABLED=false), queues unavailable');
    _handle = null;
    return null;
  }
  _handle = createRedisConnection(opts);
  return _handle;
}

/**
 * Check if Redis is available for queue operations
 */
export function isRedisAvailable(): boolean {
  return getHandle() !== null;
}

function newBullMQConnection(): RedisClient | null {
  const handle = getHandle();
  if (!handle) return null;
  return handle.duplicate({ maxRetriesPerRequest: null });
}

// =============================================================================
// QUEUE CACHE
// =============================================================================

const queueCache = new Map<string, Queue | null>();

/**
 * Create or retrieve a cached queue instance.
 * Returns null if Redis is unavailable (graceful degradation).
 */
function getOrCreateQueue(name: string): Queue | null {
  if (queueCache.has(name)) {
    return queueCache.get(name)!;
  }

  const conn = newBullMQConnection();
  if (!conn) {
    log.warn(`Queue '${name}' unavailable (Redis not configured)`);
    queueCache.set(name, null);
    return null;
  }

  try {
    const queue = new Queue(name, { connection: conn, prefix: BULLMQ_CLUSTER_SAFE_PREFIX });
    queueCache.set(name, queue);
    return queue;
  } catch (error) {
    log.error(`Failed to create queue '${name}'`, {
      error: error instanceof Error ? error.message : String(error),
    });
    // Disconnect the connection we created since we won't be using it
    try {
      conn.disconnect();
    } catch {
      /* ignore */
    }
    queueCache.set(name, null);
    return null;
  }
}

// =============================================================================
// LAZY QUEUE GETTERS
// =============================================================================

// Phase 1: Ingestion & Extraction
export function getIngestionQueue(): Queue | null {
  return getOrCreateQueue(QUEUE_INGESTION);
}

export function getExtractionQueue(): Queue | null {
  return getOrCreateQueue(QUEUE_EXTRACTION);
}

export function getDoclingExtractionQueue(): Queue | null {
  return getOrCreateQueue(QUEUE_DOCLING_EXTRACTION);
}

export function getWorkflowDoclingExtractionQueue(): Queue | null {
  return getOrCreateQueue(QUEUE_WORKFLOW_DOCLING_EXTRACTION);
}

// Phase 2: Page Processing & Text Analysis
export function getPageProcessingQueue(): Queue | null {
  return getOrCreateQueue(QUEUE_PAGE_PROCESSING);
}

export function getCanonicalMapQueue(): Queue | null {
  return getOrCreateQueue(QUEUE_CANONICAL_MAP);
}

export function getQuestionSynthesisQueue(): Queue | null {
  return getOrCreateQueue(QUEUE_QUESTION_SYNTHESIS);
}

// Phase 3: Visual Enrichment
export function getVisualEnrichmentQueue(): Queue | null {
  return getOrCreateQueue(QUEUE_VISUAL_ENRICHMENT);
}

// Phase 4: Parallel Workers
export function getEnrichmentQueue(): Queue | null {
  return getOrCreateQueue(QUEUE_ENRICHMENT);
}

export function getEmbeddingQueue(): Queue | null {
  return getOrCreateQueue(QUEUE_EMBEDDING);
}

// Optional Workers
export function getTreeBuildingQueue(): Queue | null {
  return getOrCreateQueue(QUEUE_TREE_BUILDING);
}

export function getMultimodalQueue(): Queue | null {
  return getOrCreateQueue(QUEUE_MULTIMODAL);
}

export function getScopeClassificationQueue(): Queue | null {
  return getOrCreateQueue(QUEUE_SCOPE_CLASSIFICATION);
}

export function getCleanupQueue(): Queue | null {
  return getOrCreateQueue(QUEUE_CLEANUP);
}

// =============================================================================
// CLEANUP
// =============================================================================

/**
 * Close all queue connections.
 * Safe to call even if queues were never created.
 */
export async function closeAllQueues(): Promise<void> {
  const closePromises: Promise<void>[] = [];

  for (const [name, queue] of queueCache.entries()) {
    if (queue) {
      closePromises.push(
        queue.close().catch((err) => {
          log.warn(`Failed to close queue '${name}'`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      );
    }
  }

  await Promise.allSettled(closePromises);
  queueCache.clear();
  log.info('All queues closed');
}

/**
 * Reset factory state (for testing)
 */
export function resetQueueFactory(): void {
  queueCache.clear();
  _handle = undefined;
}
