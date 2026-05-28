/**
 * Batch Processor (RFC-003 Phase 2.3)
 *
 * Aggregates requests into batches and distributes responses.
 * Enforces tenant isolation throughout the batch lifecycle.
 */

import { randomUUID } from 'crypto';
import type { QueuedRequest, CombinedBatch, BatchMetadata, BatchConfig } from './batch-types.js';
import type { RerankResponse, RerankResult, RerankerProvider } from './reranker-factory.js';
import { StructuredLogger } from '../metrics/structured-logger.js';

// ─── Batch Aggregator ───────────────────────────────────────────────────────

export class BatchAggregator {
  private readonly logger: StructuredLogger;

  constructor() {
    this.logger = new StructuredLogger({ component: 'BatchAggregator' });
  }

  /**
   * Combine multiple requests into a single batch.
   *
   * CRITICAL: All requests must be from same tenant, index, and provider.
   * This is enforced by queue structure, but we validate defensively.
   */
  combineRequests(
    batch: QueuedRequest[],
    tenantId: string,
    indexId: string,
    provider: string,
  ): CombinedBatch {
    if (batch.length === 0) {
      throw new Error('Cannot combine empty batch');
    }

    // CRITICAL: Validate tenant isolation
    this.validateBatchIsolation(batch, tenantId, indexId);

    // Flatten documents from all requests with offset tracking
    const documents: string[] = [];
    const offsets: number[] = [0];

    for (const req of batch) {
      documents.push(...req.request.documents);
      offsets.push(documents.length);
    }

    const metadata: BatchMetadata = {
      batchId: randomUUID(),
      tenantId,
      indexId,
      provider,
      requestCount: batch.length,
      documentCount: documents.length,
      timestamp: Date.now(),
    };

    this.logger.debug('Combined batch', {
      batchId: metadata.batchId,
      tenantId,
      indexId,
      provider,
      requests: batch.length,
      documents: documents.length,
    });

    return { documents, offsets, metadata };
  }

  /**
   * Validate that all requests in batch belong to same tenant and index.
   *
   * CRITICAL SECURITY CHECK: This prevents cross-tenant data leakage.
   */
  private validateBatchIsolation(
    batch: QueuedRequest[],
    expectedTenantId: string,
    expectedIndexId: string,
  ): void {
    for (const req of batch) {
      if (req.tenantId !== expectedTenantId) {
        const error = new Error(
          `CRITICAL SECURITY VIOLATION: Cross-tenant batching detected! ` +
            `Expected tenant ${expectedTenantId}, found ${req.tenantId} in request ${req.id}`,
        );
        this.logger.error('Cross-tenant batching attempt', error, {
          expectedTenantId,
          foundTenantId: req.tenantId,
          requestId: req.id,
        });
        throw error;
      }

      if (req.indexId !== expectedIndexId) {
        const error = new Error(
          `CRITICAL SECURITY VIOLATION: Cross-index batching detected! ` +
            `Expected index ${expectedIndexId}, found ${req.indexId} in request ${req.id}`,
        );
        this.logger.error('Cross-index batching attempt', error, {
          expectedIndexId,
          foundIndexId: req.indexId,
          requestId: req.id,
        });
        throw error;
      }
    }
  }
}

// ─── Response Distributor ───────────────────────────────────────────────────

export class ResponseDistributor {
  private readonly logger: StructuredLogger;

  constructor() {
    this.logger = new StructuredLogger({ component: 'ResponseDistributor' });
  }

  /**
   * Distribute batch response back to individual requests.
   *
   * Maps global indices to per-request indices and prorates costs.
   */
  distribute(batch: QueuedRequest[], combined: CombinedBatch, batchResponse: RerankResponse): void {
    const { offsets, metadata } = combined;

    this.logger.debug('Distributing batch response', {
      batchId: metadata.batchId,
      requests: batch.length,
      results: batchResponse.results.length,
    });

    for (let i = 0; i < batch.length; i++) {
      const req = batch[i];
      const startIdx = offsets[i];
      const endIdx = offsets[i + 1];

      try {
        // Extract results for this specific request
        const requestResults = this.extractRequestResults(batchResponse.results, startIdx, endIdx);

        // Calculate prorated cost
        const requestCost = this.prorateCost(
          req.request.documents.length,
          metadata.documentCount,
          batchResponse.cost,
        );

        // Resolve promise with request-specific response
        req.resolve({
          results: requestResults,
          provider: batchResponse.provider,
          model: batchResponse.model,
          latencyMs: batchResponse.latencyMs,
          cost: requestCost,
        });
      } catch (error) {
        // If distribution fails for this request, reject it
        this.logger.error('Failed to distribute response', error, {
          requestId: req.id,
          batchId: metadata.batchId,
        });
        req.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /**
   * Handle batch-level error by rejecting all requests.
   */
  rejectBatch(batch: QueuedRequest[], error: Error): void {
    for (const req of batch) {
      req.reject(error);
    }
  }

  /**
   * Extract results for a specific request from batch results.
   *
   * Renormalizes indices from global (batch-level) to local (request-level).
   */
  private extractRequestResults(
    batchResults: RerankResult[],
    startIdx: number,
    endIdx: number,
  ): RerankResult[] {
    return batchResults
      .filter((result) => result.index >= startIdx && result.index < endIdx)
      .map((result) => ({
        ...result,
        index: result.index - startIdx, // Renormalize to request-local index
      }))
      .sort((a, b) => b.score - a.score); // Sort by score descending
  }

  /**
   * Prorate batch cost across individual requests based on document count.
   */
  private prorateCost(
    requestDocCount: number,
    totalDocCount: number,
    totalCost: number | undefined,
  ): number | undefined {
    if (totalCost === undefined || totalDocCount === 0) {
      return undefined;
    }

    return totalCost * (requestDocCount / totalDocCount);
  }
}
