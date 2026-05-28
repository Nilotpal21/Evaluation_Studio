/**
 * Batch Processor Tests (RFC-003 Phase 2.3)
 *
 * Tests batch aggregation with tenant isolation validation and response distribution.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BatchAggregator, ResponseDistributor } from '../batch-processor.js';
import type { QueuedRequest } from '../batch-types.js';
import type { RerankResponse } from '../reranker-factory.js';

describe('BatchAggregator', () => {
  let aggregator: BatchAggregator;

  const createMockRequest = (
    tenantId: string,
    indexId: string,
    documents: string[],
    id: string = 'test-id',
  ): QueuedRequest => ({
    id,
    tenantId,
    indexId,
    callerContext: { identityTier: 'user', channel: 'web' },
    request: { query: 'test', documents },
    provider: 'voyage',
    timestamp: Date.now(),
    resolve: vi.fn(),
    reject: vi.fn(),
  });

  beforeEach(() => {
    aggregator = new BatchAggregator();
  });

  describe('Tenant Isolation Validation', () => {
    it('should accept batch with same tenant and index', () => {
      const batch = [
        createMockRequest('tenant-a', 'index-1', ['doc1', 'doc2'], 'req-1'),
        createMockRequest('tenant-a', 'index-1', ['doc3', 'doc4'], 'req-2'),
        createMockRequest('tenant-a', 'index-1', ['doc5'], 'req-3'),
      ];

      expect(() => {
        aggregator.combineRequests(batch, 'tenant-a', 'index-1', 'voyage');
      }).not.toThrow();
    });

    it('should reject batch with mismatched tenant (CRITICAL SECURITY)', () => {
      const batch = [
        createMockRequest('tenant-a', 'index-1', ['doc1', 'doc2'], 'req-1'),
        createMockRequest('tenant-b', 'index-1', ['doc3', 'doc4'], 'req-2'), // Wrong tenant!
        createMockRequest('tenant-a', 'index-1', ['doc5'], 'req-3'),
      ];

      expect(() => {
        aggregator.combineRequests(batch, 'tenant-a', 'index-1', 'voyage');
      }).toThrow(/CRITICAL SECURITY VIOLATION.*Cross-tenant batching detected/);
    });

    it('should reject batch with mismatched index (CRITICAL SECURITY)', () => {
      const batch = [
        createMockRequest('tenant-a', 'index-1', ['doc1', 'doc2'], 'req-1'),
        createMockRequest('tenant-a', 'index-2', ['doc3', 'doc4'], 'req-2'), // Wrong index!
        createMockRequest('tenant-a', 'index-1', ['doc5'], 'req-3'),
      ];

      expect(() => {
        aggregator.combineRequests(batch, 'tenant-a', 'index-1', 'voyage');
      }).toThrow(/CRITICAL SECURITY VIOLATION.*Cross-index batching detected/);
    });

    it('should include request ID in security violation error', () => {
      const batch = [
        createMockRequest('tenant-a', 'index-1', ['doc1'], 'req-1'),
        createMockRequest('tenant-b', 'index-1', ['doc2'], 'malicious-req'),
      ];

      expect(() => {
        aggregator.combineRequests(batch, 'tenant-a', 'index-1', 'voyage');
      }).toThrow(/malicious-req/);
    });

    it('should reject empty batch', () => {
      expect(() => {
        aggregator.combineRequests([], 'tenant-a', 'index-1', 'voyage');
      }).toThrow(/Cannot combine empty batch/);
    });
  });

  describe('Document Aggregation', () => {
    it('should flatten documents from multiple requests', () => {
      const batch = [
        createMockRequest('tenant-a', 'index-1', ['doc1', 'doc2'], 'req-1'),
        createMockRequest('tenant-a', 'index-1', ['doc3', 'doc4', 'doc5'], 'req-2'),
        createMockRequest('tenant-a', 'index-1', ['doc6'], 'req-3'),
      ];

      const combined = aggregator.combineRequests(batch, 'tenant-a', 'index-1', 'voyage');

      expect(combined.documents).toEqual(['doc1', 'doc2', 'doc3', 'doc4', 'doc5', 'doc6']);
      expect(combined.metadata.documentCount).toBe(6);
    });

    it('should track document offsets correctly', () => {
      const batch = [
        createMockRequest('tenant-a', 'index-1', ['doc1', 'doc2'], 'req-1'),
        createMockRequest('tenant-a', 'index-1', ['doc3', 'doc4', 'doc5'], 'req-2'),
        createMockRequest('tenant-a', 'index-1', ['doc6'], 'req-3'),
      ];

      const combined = aggregator.combineRequests(batch, 'tenant-a', 'index-1', 'voyage');

      // Offsets mark start of each request's documents (plus final end marker)
      expect(combined.offsets).toEqual([0, 2, 5, 6]);
    });

    it('should include batch metadata', () => {
      const batch = [
        createMockRequest('tenant-a', 'index-1', ['doc1', 'doc2'], 'req-1'),
        createMockRequest('tenant-a', 'index-1', ['doc3'], 'req-2'),
      ];

      const combined = aggregator.combineRequests(batch, 'tenant-a', 'index-1', 'voyage');

      expect(combined.metadata.tenantId).toBe('tenant-a');
      expect(combined.metadata.indexId).toBe('index-1');
      expect(combined.metadata.provider).toBe('voyage');
      expect(combined.metadata.requestCount).toBe(2);
      expect(combined.metadata.documentCount).toBe(3);
      expect(combined.metadata.batchId).toBeTruthy();
      expect(combined.metadata.timestamp).toBeGreaterThan(0);
    });
  });
});

describe('ResponseDistributor', () => {
  let distributor: ResponseDistributor;

  const createMockRequest = (documents: string[], id: string = 'test-id'): QueuedRequest => ({
    id,
    tenantId: 'tenant-a',
    indexId: 'index-1',
    callerContext: { identityTier: 'user', channel: 'web' },
    request: { query: 'test', documents },
    provider: 'voyage',
    timestamp: Date.now(),
    resolve: vi.fn(),
    reject: vi.fn(),
  });

  beforeEach(() => {
    distributor = new ResponseDistributor();
  });

  describe('Response Distribution', () => {
    it('should distribute batch response to individual requests', () => {
      const batch = [
        createMockRequest(['doc1', 'doc2'], 'req-1'),
        createMockRequest(['doc3', 'doc4', 'doc5'], 'req-2'),
        createMockRequest(['doc6'], 'req-3'),
      ];

      const combined = {
        documents: ['doc1', 'doc2', 'doc3', 'doc4', 'doc5', 'doc6'],
        offsets: [0, 2, 5, 6],
        metadata: {
          batchId: 'batch-1',
          tenantId: 'tenant-a',
          indexId: 'index-1',
          provider: 'voyage',
          requestCount: 3,
          documentCount: 6,
          timestamp: Date.now(),
        },
      };

      const batchResponse: RerankResponse = {
        results: [
          { index: 1, score: 0.95 }, // doc2 (req-1)
          { index: 0, score: 0.9 }, // doc1 (req-1)
          { index: 4, score: 0.85 }, // doc5 (req-2)
          { index: 3, score: 0.8 }, // doc4 (req-2)
          { index: 5, score: 0.75 }, // doc6 (req-3)
          { index: 2, score: 0.7 }, // doc3 (req-2)
        ],
        provider: 'voyage',
        model: 'rerank-1',
        latencyMs: 100,
        cost: 0.06,
      };

      distributor.distribute(batch, combined, batchResponse);

      // Verify req-1 received correct results (indices 0, 1 → renormalized to 0, 1)
      expect(batch[0].resolve).toHaveBeenCalledWith({
        results: [
          { index: 1, score: 0.95 },
          { index: 0, score: 0.9 },
        ],
        provider: 'voyage',
        model: 'rerank-1',
        latencyMs: 100,
        cost: expect.any(Number),
      });

      // Verify req-2 received correct results (indices 2, 3, 4 → renormalized to 0, 1, 2)
      expect(batch[1].resolve).toHaveBeenCalledWith({
        results: [
          { index: 2, score: 0.85 },
          { index: 1, score: 0.8 },
          { index: 0, score: 0.7 },
        ],
        provider: 'voyage',
        model: 'rerank-1',
        latencyMs: 100,
        cost: expect.any(Number),
      });

      // Verify req-3 received correct results (index 5 → renormalized to 0)
      expect(batch[2].resolve).toHaveBeenCalledWith({
        results: [{ index: 0, score: 0.75 }],
        provider: 'voyage',
        model: 'rerank-1',
        latencyMs: 100,
        cost: expect.any(Number),
      });
    });

    it('should renormalize indices to request-local', () => {
      const batch = [createMockRequest(['doc1', 'doc2', 'doc3'], 'req-1')];

      const combined = {
        documents: ['doc1', 'doc2', 'doc3'],
        offsets: [0, 3],
        metadata: {
          batchId: 'batch-1',
          tenantId: 'tenant-a',
          indexId: 'index-1',
          provider: 'voyage',
          requestCount: 1,
          documentCount: 3,
          timestamp: Date.now(),
        },
      };

      const batchResponse: RerankResponse = {
        results: [
          { index: 2, score: 0.95 }, // Global index 2 → local 2
          { index: 0, score: 0.9 }, // Global index 0 → local 0
          { index: 1, score: 0.85 }, // Global index 1 → local 1
        ],
        provider: 'voyage',
        model: 'rerank-1',
        latencyMs: 50,
        cost: 0.01,
      };

      distributor.distribute(batch, combined, batchResponse);

      const resolvedResponse = (batch[0].resolve as any).mock.calls[0][0];
      expect(resolvedResponse.results).toEqual([
        { index: 2, score: 0.95 },
        { index: 0, score: 0.9 },
        { index: 1, score: 0.85 },
      ]);
    });

    it('should sort results by score descending', () => {
      const batch = [createMockRequest(['doc1', 'doc2', 'doc3'], 'req-1')];

      const combined = {
        documents: ['doc1', 'doc2', 'doc3'],
        offsets: [0, 3],
        metadata: {
          batchId: 'batch-1',
          tenantId: 'tenant-a',
          indexId: 'index-1',
          provider: 'voyage',
          requestCount: 1,
          documentCount: 3,
          timestamp: Date.now(),
        },
      };

      const batchResponse: RerankResponse = {
        results: [
          { index: 1, score: 0.7 }, // Lowest
          { index: 0, score: 0.95 }, // Highest
          { index: 2, score: 0.85 }, // Middle
        ],
        provider: 'voyage',
        model: 'rerank-1',
        latencyMs: 50,
        cost: 0.01,
      };

      distributor.distribute(batch, combined, batchResponse);

      const resolvedResponse = (batch[0].resolve as any).mock.calls[0][0];
      expect(resolvedResponse.results[0].score).toBe(0.95);
      expect(resolvedResponse.results[1].score).toBe(0.85);
      expect(resolvedResponse.results[2].score).toBe(0.7);
    });

    it('should prorate costs based on document count', () => {
      const batch = [
        createMockRequest(['doc1', 'doc2'], 'req-1'), // 2 docs
        createMockRequest(['doc3', 'doc4', 'doc5', 'doc6'], 'req-2'), // 4 docs
      ];

      const combined = {
        documents: ['doc1', 'doc2', 'doc3', 'doc4', 'doc5', 'doc6'],
        offsets: [0, 2, 6],
        metadata: {
          batchId: 'batch-1',
          tenantId: 'tenant-a',
          indexId: 'index-1',
          provider: 'voyage',
          requestCount: 2,
          documentCount: 6,
          timestamp: Date.now(),
        },
      };

      const batchResponse: RerankResponse = {
        results: [
          { index: 0, score: 0.95 },
          { index: 1, score: 0.9 },
          { index: 2, score: 0.85 },
          { index: 3, score: 0.8 },
          { index: 4, score: 0.75 },
          { index: 5, score: 0.7 },
        ],
        provider: 'voyage',
        model: 'rerank-1',
        latencyMs: 100,
        cost: 0.06, // Total cost
      };

      distributor.distribute(batch, combined, batchResponse);

      // req-1: 2/6 of cost = 0.02
      const cost1 = (batch[0].resolve as any).mock.calls[0][0].cost;
      expect(cost1).toBeCloseTo(0.02, 5);

      // req-2: 4/6 of cost = 0.04
      const cost2 = (batch[1].resolve as any).mock.calls[0][0].cost;
      expect(cost2).toBeCloseTo(0.04, 5);
    });

    it('should handle undefined cost', () => {
      const batch = [createMockRequest(['doc1'], 'req-1')];

      const combined = {
        documents: ['doc1'],
        offsets: [0, 1],
        metadata: {
          batchId: 'batch-1',
          tenantId: 'tenant-a',
          indexId: 'index-1',
          provider: 'voyage',
          requestCount: 1,
          documentCount: 1,
          timestamp: Date.now(),
        },
      };

      const batchResponse: RerankResponse = {
        results: [{ index: 0, score: 0.95 }],
        provider: 'voyage',
        model: 'rerank-1',
        latencyMs: 50,
        // No cost field
      };

      distributor.distribute(batch, combined, batchResponse);

      const resolvedResponse = (batch[0].resolve as any).mock.calls[0][0];
      expect(resolvedResponse.cost).toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    it('should reject batch on error', () => {
      const batch = [
        createMockRequest(['doc1'], 'req-1'),
        createMockRequest(['doc2'], 'req-2'),
        createMockRequest(['doc3'], 'req-3'),
      ];

      const error = new Error('All providers failed');
      distributor.rejectBatch(batch, error);

      expect(batch[0].reject).toHaveBeenCalledWith(error);
      expect(batch[1].reject).toHaveBeenCalledWith(error);
      expect(batch[2].reject).toHaveBeenCalledWith(error);
    });

    it('should handle empty results gracefully', () => {
      const batch = [createMockRequest(['doc1'], 'req-1')];

      // Create batch with no matching results for the request's range
      const combined = {
        documents: ['doc1'],
        offsets: [0, 1],
        metadata: {
          batchId: 'batch-1',
          tenantId: 'tenant-a',
          indexId: 'index-1',
          provider: 'voyage',
          requestCount: 1,
          documentCount: 1,
          timestamp: Date.now(),
        },
      };

      // No results in the response (or results outside the request's range)
      const batchResponse: RerankResponse = {
        results: [],
        provider: 'voyage',
        model: 'rerank-1',
        latencyMs: 50,
        cost: 0.01,
      };

      // Should handle gracefully with empty results
      distributor.distribute(batch, combined, batchResponse);

      // Should have been resolved with empty results (but cost is still prorated)
      expect(batch[0].resolve).toHaveBeenCalledWith({
        results: [],
        provider: 'voyage',
        model: 'rerank-1',
        latencyMs: 50,
        cost: 0.01, // Cost prorated based on document count, not result count
      });
    });
  });
});
