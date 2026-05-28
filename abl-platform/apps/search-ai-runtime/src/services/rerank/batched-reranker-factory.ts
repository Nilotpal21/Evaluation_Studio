/**
 * Batched Reranker Factory (RFC-003 Phase 2.3)
 *
 * Drop-in replacement for RerankerFactory with tenant-isolated batch processing.
 * - Aggregates concurrent requests into batches
 * - Maintains separate queues per tenant-index-provider
 * - Caches identical queries with tenant scoping
 * - Automatic failover between providers
 */

import { randomUUID } from 'crypto';
import type {
  RerankRequest,
  RerankResponse,
  RerankerProvider,
  RerankerConfig,
} from './reranker-factory.js';
import { VoyageReranker, CohereReranker, JinaReranker } from './reranker-factory.js';
import type { BatchConfig, QueuedRequest, CallerContext, BatchStats } from './batch-types.js';
import { DEFAULT_BATCH_CONFIG } from './batch-types.js';
import { RequestCache } from './request-cache.js';
import { BatchQueue } from './batch-queue.js';
import { BatchAggregator, ResponseDistributor } from './batch-processor.js';
import { StructuredLogger } from '../metrics/structured-logger.js';

export class BatchedRerankerFactory {
  private readonly config: BatchConfig;
  private readonly providers: RerankerProvider[];
  private readonly cache: RequestCache;
  private readonly queue: BatchQueue;
  private readonly aggregator: BatchAggregator;
  private readonly distributor: ResponseDistributor;
  private readonly logger: StructuredLogger;

  // Circuit breaker state
  private failureCount = new Map<string, number>();
  private circuitOpenedAt = new Map<string, number>();
  private readonly maxFailures = 3;
  private static readonly CB_RESET_TIMEOUT_MS = 60_000;

  // Batch timers (per queue)
  private batchTimers = new Map<string, NodeJS.Timeout>();

  // Cleanup interval
  private cleanupInterval?: NodeJS.Timeout;

  // Statistics
  private stats = {
    totalRequests: 0,
    batchedRequests: 0,
    batchCount: 0,
    totalBatchWaitMs: 0,
    totalBatchExecutionMs: 0,
    estimatedAPICalls: 0,
    actualAPICalls: 0,
  };

  constructor(config?: Partial<BatchConfig>, rerankerConfig?: RerankerConfig) {
    this.config = { ...DEFAULT_BATCH_CONFIG, ...config };
    this.logger = new StructuredLogger({ component: 'BatchedRerankerFactory' });

    // Initialize components
    this.cache = new RequestCache(this.config);
    this.queue = new BatchQueue(this.config);
    this.aggregator = new BatchAggregator();
    this.distributor = new ResponseDistributor();

    // Initialize providers — use rerankerConfig API keys if provided, else env vars
    this.providers = [];

    const voyageKey = rerankerConfig?.voyageApiKey || process.env.VOYAGE_API_KEY;
    const cohereKey = rerankerConfig?.cohereApiKey || process.env.COHERE_API_KEY;
    const jinaKey = rerankerConfig?.jinaApiKey || process.env.JINA_API_KEY;

    if (voyageKey) {
      this.providers.push(
        new VoyageReranker({
          apiKey: voyageKey,
          model: rerankerConfig?.preferredProvider === 'voyage' ? rerankerConfig.model : undefined,
        }),
      );
    }

    if (cohereKey) {
      this.providers.push(
        new CohereReranker({
          apiKey: cohereKey,
          model: rerankerConfig?.preferredProvider === 'cohere' ? rerankerConfig.model : undefined,
        }),
      );
    }

    if (jinaKey) {
      this.providers.push(
        new JinaReranker({
          apiKey: jinaKey,
          model: rerankerConfig?.preferredProvider === 'jina' ? rerankerConfig.model : undefined,
        }),
      );
    }

    // Reorder so preferred provider comes first
    if (rerankerConfig?.preferredProvider && this.providers.length > 1) {
      const preferredIdx = this.providers.findIndex(
        (p) => p.name === rerankerConfig.preferredProvider,
      );
      if (preferredIdx > 0) {
        const [preferred] = this.providers.splice(preferredIdx, 1);
        this.providers.unshift(preferred);
      }
    }

    if (this.providers.length === 0) {
      this.logger.warn('No reranker API keys found. Reranking will be disabled.');
    }

    // Start periodic cleanup
    if (this.config.queueCleanupIntervalMs > 0) {
      this.cleanupInterval = setInterval(() => {
        this.periodicCleanup();
      }, this.config.queueCleanupIntervalMs);
    }
  }

  /**
   * Rerank documents with batching and caching.
   *
   * CRITICAL: tenantId and indexId are required for isolation.
   */
  async rerank(
    tenantId: string,
    indexId: string,
    request: RerankRequest,
    callerContext: CallerContext,
  ): Promise<RerankResponse | null> {
    // Check if any providers are available
    if (this.providers.length === 0) {
      return null;
    }

    if (!this.config.enabled) {
      // Batching disabled - use direct provider call
      return this.rerankDirect(request);
    }

    this.stats.totalRequests++;
    this.stats.estimatedAPICalls++;

    // Check cache (tenant-scoped)
    if (this.config.deduplicate) {
      const cached = this.cache.get(tenantId, indexId, request.query, request.documents);
      if (cached) {
        this.logger.debug('Cache hit', { tenantId, indexId });
        return cached;
      }
    }

    // Create promise that will be resolved when batch completes
    return new Promise((resolve, reject) => {
      const queuedRequest: QueuedRequest = {
        id: randomUUID(),
        tenantId,
        indexId,
        callerContext,
        request,
        provider: this.providers[0].name, // Primary provider
        timestamp: Date.now(),
        resolve,
        reject,
      };

      // Add to queue
      this.queue.enqueue(tenantId, indexId, queuedRequest.provider, queuedRequest);

      // Schedule batch execution
      this.scheduleBatchExecution(tenantId, indexId, queuedRequest.provider);
    });
  }

  /**
   * Check if any providers are available.
   */
  isAvailable(): boolean {
    return this.providers.length > 0;
  }

  /**
   * Get batch statistics.
   */
  getBatchStats(): BatchStats {
    const queueStats = this.queue.getStats();
    const cacheStats = this.cache.getStats();

    const avgBatchSize =
      this.stats.batchCount > 0 ? this.stats.batchedRequests / this.stats.batchCount : 0;

    const batchUtilization =
      this.config.maxBatchSize > 0 ? avgBatchSize / this.config.maxBatchSize : 0;

    const callReduction =
      this.stats.estimatedAPICalls > 0
        ? 1 - this.stats.actualAPICalls / this.stats.estimatedAPICalls
        : 0;

    return {
      totalRequests: this.stats.totalRequests,
      batchedRequests: this.stats.batchedRequests,
      batchCount: this.stats.batchCount,
      avgBatchSize,
      batchUtilization,

      cacheHits: cacheStats.hits,
      cacheMisses: cacheStats.misses,
      cacheHitRate: cacheStats.hitRate,

      avgBatchWaitMs:
        this.stats.batchCount > 0 ? this.stats.totalBatchWaitMs / this.stats.batchCount : 0,
      avgBatchExecutionMs:
        this.stats.batchCount > 0 ? this.stats.totalBatchExecutionMs / this.stats.batchCount : 0,
      avgTotalLatencyMs:
        this.stats.batchCount > 0
          ? (this.stats.totalBatchWaitMs + this.stats.totalBatchExecutionMs) / this.stats.batchCount
          : 0,

      activeQueues: queueStats.activeQueues,
      totalQueuedRequests: queueStats.totalRequests,
      stalledRequests: queueStats.stalledRequests,

      estimatedAPICalls: this.stats.estimatedAPICalls,
      actualAPICalls: this.stats.actualAPICalls,
      callReduction,
    };
  }

  /**
   * Flush all pending batches immediately (for shutdown or testing).
   */
  async flushBatches(): Promise<void> {
    const activeQueues = this.queue.getActiveQueues();

    const promises = activeQueues.map((queueKey) => {
      const { tenantId, indexId, provider } = this.queue.parseQueueKey(queueKey);
      return this.executeBatch(tenantId, indexId, provider);
    });

    await Promise.allSettled(promises);
  }

  /**
   * Cleanup and shutdown.
   */
  async shutdown(): Promise<void> {
    // Stop cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Clear all batch timers
    for (const timer of this.batchTimers.values()) {
      clearTimeout(timer);
    }
    this.batchTimers.clear();

    // Flush pending batches
    await this.flushBatches();

    // Clear queues and cache
    this.queue.clear();
    this.cache.clear();
  }

  // ─── Private Methods ────────────────────────────────────────────────────────

  /**
   * Schedule batch execution based on time/size thresholds.
   */
  private scheduleBatchExecution(tenantId: string, indexId: string, provider: string): void {
    const queueKey = `${tenantId}:${indexId}:${provider}`;
    const queueSize = this.queue.size(tenantId, indexId, provider);

    // If batch is full, execute immediately
    if (queueSize >= this.config.maxBatchSize) {
      this.executeBatch(tenantId, indexId, provider).catch((error) => {
        this.logger.error('Batch execution failed', error, { tenantId, indexId, provider });
      });
      return;
    }

    // Otherwise, schedule execution after maxWaitMs
    if (!this.batchTimers.has(queueKey)) {
      const timer = setTimeout(() => {
        this.batchTimers.delete(queueKey);
        this.executeBatch(tenantId, indexId, provider).catch((error) => {
          this.logger.error('Batch execution failed', error, { tenantId, indexId, provider });
        });
      }, this.config.maxWaitMs);

      this.batchTimers.set(queueKey, timer);
    }
  }

  /**
   * Execute a batch for a specific tenant-index-provider.
   */
  private async executeBatch(tenantId: string, indexId: string, provider: string): Promise<void> {
    // Clear timer if exists
    const queueKey = `${tenantId}:${indexId}:${provider}`;
    const timer = this.batchTimers.get(queueKey);
    if (timer) {
      clearTimeout(timer);
      this.batchTimers.delete(queueKey);
    }

    // Dequeue batch
    const batch = this.queue.dequeue(tenantId, indexId, provider, this.config.maxBatchSize);

    if (batch.length === 0) {
      return;
    }

    const batchStartTime = Date.now();

    // Calculate wait time (time spent in queue)
    const avgWaitMs =
      batch.reduce((sum, req) => sum + (batchStartTime - req.timestamp), 0) / batch.length;
    this.stats.totalBatchWaitMs += avgWaitMs;

    this.stats.batchedRequests += batch.length;
    this.stats.batchCount++;

    try {
      // Combine requests into batch
      const combined = this.aggregator.combineRequests(batch, tenantId, indexId, provider);

      // Execute batch API call
      const executionStart = Date.now();
      const batchResponse = await this.executeBatchCall(
        provider,
        batch[0].request.query, // Use first query (should be same for best batching)
        combined.documents,
      );

      const executionMs = Date.now() - executionStart;
      this.stats.totalBatchExecutionMs += executionMs;
      this.stats.actualAPICalls++;

      // Cache response if enabled
      if (this.config.deduplicate && batchResponse) {
        for (const req of batch) {
          this.cache.set(
            tenantId,
            indexId,
            req.request.query,
            req.request.documents,
            batchResponse,
          );
        }
      }

      // Distribute response to individual requests
      if (batchResponse) {
        this.distributor.distribute(batch, combined, batchResponse);
      } else {
        // All providers failed - reject all requests
        this.distributor.rejectBatch(batch, new Error('All reranker providers failed'));
      }
    } catch (error) {
      this.logger.error('Batch execution error', error, {
        tenantId,
        indexId,
        provider,
        batchSize: batch.length,
      });
      this.distributor.rejectBatch(
        batch,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * Execute batch API call with provider failover.
   */
  private async executeBatchCall(
    preferredProvider: string,
    query: string,
    documents: string[],
  ): Promise<RerankResponse | null> {
    const errors: Array<{ provider: string; error: string }> = [];

    for (const provider of this.providers) {
      // Skip if circuit breaker is open
      if (this.isCircuitOpen(provider.name)) {
        continue;
      }

      try {
        const result = await provider.rerank({
          query,
          documents,
          topN: documents.length,
        });

        this.recordSuccess(provider.name);
        return result;
      } catch (error) {
        this.recordFailure(provider.name);
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push({ provider: provider.name, error: errorMsg });
      }
    }

    // All providers failed
    this.logger.error('All providers failed for batch', { errors });
    return null;
  }

  /**
   * Direct rerank without batching (fallback).
   */
  private async rerankDirect(request: RerankRequest): Promise<RerankResponse | null> {
    return this.executeBatchCall(this.providers[0].name, request.query, request.documents);
  }

  /**
   * Periodic cleanup of queues and cache.
   */
  private periodicCleanup(): void {
    this.queue.cleanupInactiveQueues(this.config.queueCleanupIntervalMs);
    this.cache.cleanup();
  }

  /**
   * Check if circuit breaker is open for a provider.
   * Transitions to half-open after CB_RESET_TIMEOUT_MS to allow probe requests.
   */
  private isCircuitOpen(providerName: string): boolean {
    const failures = this.failureCount.get(providerName) ?? 0;
    if (failures < this.maxFailures) return false;

    // Check if reset timeout has elapsed — allow a probe request (half-open)
    const openedAt = this.circuitOpenedAt.get(providerName) ?? 0;
    if (Date.now() - openedAt >= BatchedRerankerFactory.CB_RESET_TIMEOUT_MS) {
      this.failureCount.set(providerName, 0);
      this.circuitOpenedAt.delete(providerName);
      return false;
    }

    return true;
  }

  /**
   * Record successful call (resets failure count and clears circuit timer).
   */
  private recordSuccess(providerName: string): void {
    this.failureCount.set(providerName, 0);
    this.circuitOpenedAt.delete(providerName);
  }

  /**
   * Record failed call (increments failure count, records open timestamp).
   */
  private recordFailure(providerName: string): void {
    const current = this.failureCount.get(providerName) ?? 0;
    const next = current + 1;
    this.failureCount.set(providerName, next);
    if (next >= this.maxFailures && !this.circuitOpenedAt.has(providerName)) {
      this.circuitOpenedAt.set(providerName, Date.now());
    }
  }
}
