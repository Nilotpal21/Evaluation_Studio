/**
 * Batch Processing Types (RFC-003 Phase 2.3)
 *
 * Types for tenant-isolated batch reranking with deduplication.
 */

import type { RerankRequest, RerankResponse } from './reranker-factory.js';

// ─── Configuration ──────────────────────────────────────────────────────────

export interface BatchConfig {
  /** Enable batch processing (default: true) */
  enabled: boolean;

  /** Maximum requests per batch (default: 100) */
  maxBatchSize: number;

  /** Maximum wait time in ms to fill batch (default: 50) */
  maxWaitMs: number;

  /** Enable request deduplication cache (default: true) */
  deduplicate: boolean;

  /** Cache TTL in ms (default: 5000 - 5 seconds) */
  deduplicationTTL: number;

  /** Maximum cache size (default: 1000) */
  cacheMaxSize: number;

  /** Queue cleanup interval in ms (default: 60000 - 1 minute) */
  queueCleanupIntervalMs: number;

  /** Maximum request age in queue in ms (default: 5000 - 5 seconds) */
  maxRequestAgeMs: number;
}

export const DEFAULT_BATCH_CONFIG: BatchConfig = {
  enabled: true,
  maxBatchSize: 100,
  maxWaitMs: 50,
  deduplicate: true,
  deduplicationTTL: 5000,
  cacheMaxSize: 1000,
  queueCleanupIntervalMs: 60000,
  maxRequestAgeMs: 5000,
};

// ─── Queued Request ─────────────────────────────────────────────────────────

export interface CallerContext {
  identityTier: string;
  channel: string;
  initiatedById?: string;
}

export interface QueuedRequest {
  /** Unique request ID (correlation ID) */
  id: string;

  /** Tenant ID (required for isolation) */
  tenantId: string;

  /** Index/collection ID (required for isolation) */
  indexId: string;

  /** Caller context from edge auth */
  callerContext: CallerContext;

  /** Original rerank request */
  request: RerankRequest;

  /** Target provider */
  provider: string;

  /** Timestamp when enqueued */
  timestamp: number;

  /** Promise resolve callback */
  resolve: (response: RerankResponse) => void;

  /** Promise reject callback */
  reject: (error: Error) => void;
}

// ─── Batch Metadata ─────────────────────────────────────────────────────────

export interface BatchMetadata {
  /** Batch ID */
  batchId: string;

  /** Tenant ID (all requests must match) */
  tenantId: string;

  /** Index ID (all requests must match) */
  indexId: string;

  /** Provider */
  provider: string;

  /** Number of requests in batch */
  requestCount: number;

  /** Total documents across all requests */
  documentCount: number;

  /** Timestamp when batch was created */
  timestamp: number;
}

// ─── Combined Batch Data ────────────────────────────────────────────────────

export interface CombinedBatch {
  /** All documents flattened */
  documents: string[];

  /** Start index for each request's documents */
  offsets: number[];

  /** Batch metadata */
  metadata: BatchMetadata;
}

// ─── Batch Statistics ───────────────────────────────────────────────────────

export interface BatchStats {
  // Batching effectiveness
  totalRequests: number;
  batchedRequests: number;
  batchCount: number;
  avgBatchSize: number;
  batchUtilization: number; // % of maxBatchSize used

  // Cache performance
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;

  // Latency breakdown
  avgBatchWaitMs: number;
  avgBatchExecutionMs: number;
  avgTotalLatencyMs: number;

  // Queue stats
  activeQueues: number;
  totalQueuedRequests: number;
  stalledRequests: number; // Requests waiting > maxRequestAgeMs

  // Cost savings
  estimatedAPICalls: number; // Without batching
  actualAPICalls: number; // With batching
  callReduction: number; // % reduction
}

// ─── Cache Entry ────────────────────────────────────────────────────────────

export interface CacheEntry {
  response: RerankResponse;
  timestamp: number;
  hitCount: number;
  tenantId: string;
  indexId: string;
}
