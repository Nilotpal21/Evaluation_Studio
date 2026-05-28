/**
 * Batch Queue Tests (RFC-003 Phase 2.3)
 *
 * Tests tenant-isolated queuing with stale request removal and cleanup.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BatchQueue } from '../batch-queue.js';
import type { QueuedRequest } from '../batch-types.js';

describe('BatchQueue', () => {
  let queue: BatchQueue;

  const createMockRequest = (
    tenantId: string,
    indexId: string,
    id: string = 'test-id',
  ): QueuedRequest => ({
    id,
    tenantId,
    indexId,
    callerContext: { identityTier: 'user', channel: 'web' },
    request: { query: 'test', documents: ['doc1', 'doc2'] },
    provider: 'voyage',
    timestamp: Date.now(),
    resolve: vi.fn(),
    reject: vi.fn(),
  });

  beforeEach(() => {
    queue = new BatchQueue({ maxRequestAgeMs: 5000 });
  });

  describe('Tenant Isolation', () => {
    it('should maintain separate queues per tenant-index-provider', () => {
      const req1 = createMockRequest('tenant-a', 'index-1', 'req-1');
      const req2 = createMockRequest('tenant-b', 'index-1', 'req-2');
      const req3 = createMockRequest('tenant-a', 'index-2', 'req-3');

      queue.enqueue('tenant-a', 'index-1', 'voyage', req1);
      queue.enqueue('tenant-b', 'index-1', 'voyage', req2);
      queue.enqueue('tenant-a', 'index-2', 'voyage', req3);

      expect(queue.size('tenant-a', 'index-1', 'voyage')).toBe(1);
      expect(queue.size('tenant-b', 'index-1', 'voyage')).toBe(1);
      expect(queue.size('tenant-a', 'index-2', 'voyage')).toBe(1);
    });

    it('should separate queues by provider', () => {
      const req1 = createMockRequest('tenant-a', 'index-1', 'req-1');
      const req2 = createMockRequest('tenant-a', 'index-1', 'req-2');

      queue.enqueue('tenant-a', 'index-1', 'voyage', req1);
      queue.enqueue('tenant-a', 'index-1', 'cohere', req2);

      expect(queue.size('tenant-a', 'index-1', 'voyage')).toBe(1);
      expect(queue.size('tenant-a', 'index-1', 'cohere')).toBe(1);
    });

    it('should only dequeue from specified tenant-index-provider', () => {
      const req1 = createMockRequest('tenant-a', 'index-1', 'req-1');
      const req2 = createMockRequest('tenant-b', 'index-1', 'req-2');

      queue.enqueue('tenant-a', 'index-1', 'voyage', req1);
      queue.enqueue('tenant-b', 'index-1', 'voyage', req2);

      const batch = queue.dequeue('tenant-a', 'index-1', 'voyage', 10);

      expect(batch).toHaveLength(1);
      expect(batch[0].id).toBe('req-1');
      expect(batch[0].tenantId).toBe('tenant-a');
    });
  });

  describe('Enqueue and Dequeue', () => {
    it('should enqueue and dequeue requests in FIFO order', () => {
      const req1 = createMockRequest('tenant-a', 'index-1', 'req-1');
      const req2 = createMockRequest('tenant-a', 'index-1', 'req-2');
      const req3 = createMockRequest('tenant-a', 'index-1', 'req-3');

      queue.enqueue('tenant-a', 'index-1', 'voyage', req1);
      queue.enqueue('tenant-a', 'index-1', 'voyage', req2);
      queue.enqueue('tenant-a', 'index-1', 'voyage', req3);

      const batch = queue.dequeue('tenant-a', 'index-1', 'voyage', 10);

      expect(batch).toHaveLength(3);
      expect(batch[0].id).toBe('req-1');
      expect(batch[1].id).toBe('req-2');
      expect(batch[2].id).toBe('req-3');
    });

    it('should respect count limit when dequeuing', () => {
      for (let i = 0; i < 10; i++) {
        const req = createMockRequest('tenant-a', 'index-1', `req-${i}`);
        queue.enqueue('tenant-a', 'index-1', 'voyage', req);
      }

      const batch = queue.dequeue('tenant-a', 'index-1', 'voyage', 5);

      expect(batch).toHaveLength(5);
      expect(queue.size('tenant-a', 'index-1', 'voyage')).toBe(5);
    });

    it('should return empty array for empty queue', () => {
      const batch = queue.dequeue('tenant-a', 'index-1', 'voyage', 10);
      expect(batch).toHaveLength(0);
    });

    it('should return empty array for nonexistent queue', () => {
      const req = createMockRequest('tenant-a', 'index-1', 'req-1');
      queue.enqueue('tenant-a', 'index-1', 'voyage', req);

      const batch = queue.dequeue('tenant-b', 'index-2', 'cohere', 10);
      expect(batch).toHaveLength(0);
    });

    it('should remove queue when fully drained', () => {
      const req = createMockRequest('tenant-a', 'index-1', 'req-1');
      queue.enqueue('tenant-a', 'index-1', 'voyage', req);

      expect(queue.getActiveQueues()).toContain('tenant-a:index-1:voyage');

      queue.dequeue('tenant-a', 'index-1', 'voyage', 10);

      expect(queue.getActiveQueues()).not.toContain('tenant-a:index-1:voyage');
    });
  });

  describe('Stale Request Handling', () => {
    it('should remove stale requests on dequeue', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const shortAgeQueue = new BatchQueue({ maxRequestAgeMs: 1000 });

      const req1 = createMockRequest('tenant-a', 'index-1', 'req-1');
      req1.timestamp = now; // Set explicit timestamp

      shortAgeQueue.enqueue('tenant-a', 'index-1', 'voyage', req1);

      // Advance time to make req1 stale
      vi.advanceTimersByTime(1001);
      vi.setSystemTime(now + 1001);

      const req2 = createMockRequest('tenant-a', 'index-1', 'req-2');
      req2.timestamp = now + 1001; // Set explicit timestamp

      shortAgeQueue.enqueue('tenant-a', 'index-1', 'voyage', req2);

      // Dequeue should remove stale req1 and return only req2
      const batch = shortAgeQueue.dequeue('tenant-a', 'index-1', 'voyage', 10);

      expect(batch).toHaveLength(1);
      expect(batch[0].id).toBe('req-2');

      // Stale request should have been rejected
      expect(req1.reject).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Request stale'),
        }),
      );

      vi.useRealTimers();
    });

    it('should reject all stale requests in a batch', () => {
      vi.useFakeTimers();

      const shortAgeQueue = new BatchQueue({ maxRequestAgeMs: 1000 });

      const staleReqs = [
        createMockRequest('tenant-a', 'index-1', 'req-1'),
        createMockRequest('tenant-a', 'index-1', 'req-2'),
        createMockRequest('tenant-a', 'index-1', 'req-3'),
      ];

      staleReqs.forEach((req) => {
        shortAgeQueue.enqueue('tenant-a', 'index-1', 'voyage', req);
      });

      // Advance time to make all stale
      vi.advanceTimersByTime(1001);

      // Add fresh request
      const freshReq = createMockRequest('tenant-a', 'index-1', 'req-fresh');
      shortAgeQueue.enqueue('tenant-a', 'index-1', 'voyage', freshReq);

      const batch = shortAgeQueue.dequeue('tenant-a', 'index-1', 'voyage', 10);

      expect(batch).toHaveLength(1);
      expect(batch[0].id).toBe('req-fresh');

      // All stale requests should have been rejected
      staleReqs.forEach((req) => {
        expect(req.reject).toHaveBeenCalled();
      });

      vi.useRealTimers();
    });
  });

  describe('Queue Management', () => {
    it('should track active queues', () => {
      const req1 = createMockRequest('tenant-a', 'index-1', 'req-1');
      const req2 = createMockRequest('tenant-b', 'index-2', 'req-2');

      queue.enqueue('tenant-a', 'index-1', 'voyage', req1);
      queue.enqueue('tenant-b', 'index-2', 'cohere', req2);

      const activeQueues = queue.getActiveQueues();

      expect(activeQueues).toContain('tenant-a:index-1:voyage');
      expect(activeQueues).toContain('tenant-b:index-2:cohere');
      expect(activeQueues).toHaveLength(2);
    });

    it('should parse queue keys correctly', () => {
      const parsed = queue.parseQueueKey('tenant-a:index-1:voyage');

      expect(parsed).toEqual({
        tenantId: 'tenant-a',
        indexId: 'index-1',
        provider: 'voyage',
      });
    });

    it('should clear all queues and reject pending requests', () => {
      const req1 = createMockRequest('tenant-a', 'index-1', 'req-1');
      const req2 = createMockRequest('tenant-b', 'index-2', 'req-2');

      queue.enqueue('tenant-a', 'index-1', 'voyage', req1);
      queue.enqueue('tenant-b', 'index-2', 'cohere', req2);

      queue.clear();

      expect(queue.getActiveQueues()).toHaveLength(0);
      expect(req1.reject).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Queue cleared' }),
      );
      expect(req2.reject).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Queue cleared' }),
      );
    });

    it('should clear tenant-specific queues', () => {
      const reqA1 = createMockRequest('tenant-a', 'index-1', 'req-a1');
      const reqA2 = createMockRequest('tenant-a', 'index-2', 'req-a2');
      const reqB = createMockRequest('tenant-b', 'index-1', 'req-b');

      queue.enqueue('tenant-a', 'index-1', 'voyage', reqA1);
      queue.enqueue('tenant-a', 'index-2', 'voyage', reqA2);
      queue.enqueue('tenant-b', 'index-1', 'voyage', reqB);

      queue.clearTenant('tenant-a');

      const activeQueues = queue.getActiveQueues();
      expect(activeQueues).not.toContain('tenant-a:index-1:voyage');
      expect(activeQueues).not.toContain('tenant-a:index-2:voyage');
      expect(activeQueues).toContain('tenant-b:index-1:voyage');

      expect(reqA1.reject).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Tenant queue cleared' }),
      );
      expect(reqA2.reject).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Tenant queue cleared' }),
      );
      expect(reqB.reject).not.toHaveBeenCalled();
    });

    it('should cleanup inactive queues', () => {
      vi.useFakeTimers();

      const req1 = createMockRequest('tenant-a', 'index-1', 'req-1');
      const req2 = createMockRequest('tenant-b', 'index-2', 'req-2');

      queue.enqueue('tenant-a', 'index-1', 'voyage', req1);
      queue.enqueue('tenant-b', 'index-2', 'cohere', req2);

      // Drain tenant-a queue
      queue.dequeue('tenant-a', 'index-1', 'voyage', 10);

      // Advance time beyond cleanup threshold
      vi.advanceTimersByTime(61000); // 61 seconds

      queue.cleanupInactiveQueues(60000); // 60 second threshold

      // tenant-a should be removed (empty and inactive)
      // tenant-b should remain (still has items)
      const activeQueues = queue.getActiveQueues();
      expect(activeQueues).not.toContain('tenant-a:index-1:voyage');
      expect(activeQueues).toContain('tenant-b:index-2:cohere');

      vi.useRealTimers();
    });
  });

  describe('Statistics', () => {
    it('should report accurate queue statistics', () => {
      for (let i = 0; i < 5; i++) {
        const req = createMockRequest('tenant-a', 'index-1', `req-a-${i}`);
        queue.enqueue('tenant-a', 'index-1', 'voyage', req);
      }

      for (let i = 0; i < 3; i++) {
        const req = createMockRequest('tenant-b', 'index-2', `req-b-${i}`);
        queue.enqueue('tenant-b', 'index-2', 'cohere', req);
      }

      const stats = queue.getStats();

      expect(stats.activeQueues).toBe(2);
      expect(stats.totalRequests).toBe(8);
      expect(stats.stalledRequests).toBe(0);
      expect(stats.queueSizes['tenant-a:index-1:voyage']).toBe(5);
      expect(stats.queueSizes['tenant-b:index-2:cohere']).toBe(3);
    });

    it('should count stalled requests', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const shortAgeQueue = new BatchQueue({ maxRequestAgeMs: 1000 });

      const req1 = createMockRequest('tenant-a', 'index-1', 'req-1');
      req1.timestamp = now; // Set explicit timestamp

      shortAgeQueue.enqueue('tenant-a', 'index-1', 'voyage', req1);

      vi.advanceTimersByTime(1001);
      vi.setSystemTime(now + 1001);

      const req2 = createMockRequest('tenant-a', 'index-1', 'req-2');
      req2.timestamp = now + 1001; // Set explicit timestamp

      shortAgeQueue.enqueue('tenant-a', 'index-1', 'voyage', req2);

      const stats = shortAgeQueue.getStats();

      expect(stats.stalledRequests).toBe(1); // req1 is stalled
      expect(stats.totalRequests).toBe(2);

      vi.useRealTimers();
    });
  });
});
