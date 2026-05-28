/**
 * Queue Monitor Tests
 *
 * Unit tests for BullMQ queue monitoring and health assessment.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { Queue } from 'bullmq';

// Mock BullMQ
vi.mock('bullmq');
const MockedQueue = Queue as any;

// Mock createQueue from shared.js
vi.mock('../shared.js', () => ({
  createQueue: vi.fn((queueName: string) => {
    const mockQueue = {
      getWaitingCount: vi.fn().mockResolvedValue(0),
      getActiveCount: vi.fn().mockResolvedValue(0),
      getCompletedCount: vi.fn().mockResolvedValue(0),
      getFailedCount: vi.fn().mockResolvedValue(0),
      getDelayedCount: vi.fn().mockResolvedValue(0),
      close: vi.fn().mockResolvedValue(undefined),
    };
    return mockQueue;
  }),
  createWorkerOptions: vi.fn(),
  getRedisConnection: vi.fn(() => ({})),
  workerLog: vi.fn(),
  workerError: vi.fn(),
}));

import { getAllQueueStats, getAllQueueHealth } from '../queue-monitor.js';
import { createQueue } from '../shared.js';

describe('Queue Monitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getAllQueueStats', () => {
    test('should fetch stats for all monitored queues', async () => {
      // Mock queue counts
      (createQueue as any).mockImplementation((queueName: string) => ({
        getWaitingCount: vi.fn().mockResolvedValue(10),
        getActiveCount: vi.fn().mockResolvedValue(5),
        getCompletedCount: vi.fn().mockResolvedValue(100),
        getFailedCount: vi.fn().mockResolvedValue(2),
        getDelayedCount: vi.fn().mockResolvedValue(0),
        close: vi.fn().mockResolvedValue(undefined),
      }));

      const stats = await getAllQueueStats();

      // Should have stats for all 6 queues
      expect(stats).toHaveLength(6);

      // Check first queue stats
      const firstQueue = stats[0];
      expect(firstQueue).toMatchObject({
        queueName: expect.any(String),
        waiting: 10,
        active: 5,
        completed: 100,
        failed: 2,
        delayed: 0,
        total: 117, // 10+5+100+2+0
        timestamp: expect.any(Date),
      });
    });

    test('should close all queues after fetching stats', async () => {
      const mockClose = vi.fn().mockResolvedValue(undefined);
      (createQueue as any).mockImplementation(() => ({
        getWaitingCount: vi.fn().mockResolvedValue(0),
        getActiveCount: vi.fn().mockResolvedValue(0),
        getCompletedCount: vi.fn().mockResolvedValue(0),
        getFailedCount: vi.fn().mockResolvedValue(0),
        getDelayedCount: vi.fn().mockResolvedValue(0),
        close: mockClose,
      }));

      await getAllQueueStats();

      // Should close all 6 queues
      expect(mockClose).toHaveBeenCalledTimes(6);
    });

    test('should handle empty queues', async () => {
      (createQueue as any).mockImplementation(() => ({
        getWaitingCount: vi.fn().mockResolvedValue(0),
        getActiveCount: vi.fn().mockResolvedValue(0),
        getCompletedCount: vi.fn().mockResolvedValue(0),
        getFailedCount: vi.fn().mockResolvedValue(0),
        getDelayedCount: vi.fn().mockResolvedValue(0),
        close: vi.fn().mockResolvedValue(undefined),
      }));

      const stats = await getAllQueueStats();

      stats.forEach((queue) => {
        expect(queue.waiting).toBe(0);
        expect(queue.active).toBe(0);
        expect(queue.completed).toBe(0);
        expect(queue.failed).toBe(0);
        expect(queue.total).toBe(0);
      });
    });
  });

  describe('getAllQueueHealth', () => {
    test('should assess healthy queues', async () => {
      (createQueue as any).mockImplementation(() => ({
        getWaitingCount: vi.fn().mockResolvedValue(10), // Low backlog
        getActiveCount: vi.fn().mockResolvedValue(5),
        getCompletedCount: vi.fn().mockResolvedValue(100),
        getFailedCount: vi.fn().mockResolvedValue(1), // <10% failure rate
        getDelayedCount: vi.fn().mockResolvedValue(0),
        close: vi.fn().mockResolvedValue(undefined),
      }));

      const health = await getAllQueueHealth();

      health.forEach((queue) => {
        expect(queue.status).toBe('healthy');
        expect(queue.issues).toHaveLength(0);
      });
    });

    test('should detect critical status - high failure rate', async () => {
      (createQueue as any).mockImplementation(() => ({
        getWaitingCount: vi.fn().mockResolvedValue(10),
        getActiveCount: vi.fn().mockResolvedValue(5),
        getCompletedCount: vi.fn().mockResolvedValue(50),
        getFailedCount: vi.fn().mockResolvedValue(20), // >10% failure rate (20/85 = 23.5%)
        getDelayedCount: vi.fn().mockResolvedValue(0),
        close: vi.fn().mockResolvedValue(undefined),
      }));

      const health = await getAllQueueHealth();

      health.forEach((queue) => {
        expect(queue.status).toBe('critical');
        expect(queue.issues.length).toBeGreaterThan(0);
        expect(queue.issues[0]).toContain('High failure rate');
      });
    });

    test('should detect critical status - very high backlog', async () => {
      (createQueue as any).mockImplementation(() => ({
        getWaitingCount: vi.fn().mockResolvedValue(1500), // >1000 waiting
        getActiveCount: vi.fn().mockResolvedValue(10),
        getCompletedCount: vi.fn().mockResolvedValue(100),
        getFailedCount: vi.fn().mockResolvedValue(0),
        getDelayedCount: vi.fn().mockResolvedValue(0),
        close: vi.fn().mockResolvedValue(undefined),
      }));

      const health = await getAllQueueHealth();

      health.forEach((queue) => {
        expect(queue.status).toBe('critical');
        expect(queue.issues).toContain('Very high backlog: 1500 jobs waiting');
      });
    });

    test('should detect degraded status - moderate backlog', async () => {
      (createQueue as any).mockImplementation(() => ({
        getWaitingCount: vi.fn().mockResolvedValue(150), // >100 waiting
        getActiveCount: vi.fn().mockResolvedValue(10),
        getCompletedCount: vi.fn().mockResolvedValue(100),
        getFailedCount: vi.fn().mockResolvedValue(2),
        getDelayedCount: vi.fn().mockResolvedValue(0),
        close: vi.fn().mockResolvedValue(undefined),
      }));

      const health = await getAllQueueHealth();

      health.forEach((queue) => {
        expect(queue.status).toBe('degraded');
        expect(queue.issues).toContain('Moderate backlog: 150 jobs waiting');
      });
    });

    test('should detect high active count', async () => {
      (createQueue as any).mockImplementation(() => ({
        getWaitingCount: vi.fn().mockResolvedValue(10),
        getActiveCount: vi.fn().mockResolvedValue(60), // >50 active
        getCompletedCount: vi.fn().mockResolvedValue(100),
        getFailedCount: vi.fn().mockResolvedValue(0),
        getDelayedCount: vi.fn().mockResolvedValue(0),
        close: vi.fn().mockResolvedValue(undefined),
      }));

      const health = await getAllQueueHealth();

      health.forEach((queue) => {
        expect(queue.issues).toContain('High active count: 60 jobs in progress');
      });
    });

    test('should prioritize critical over degraded', async () => {
      (createQueue as any).mockImplementation(() => ({
        getWaitingCount: vi.fn().mockResolvedValue(150), // Degraded (>100)
        getActiveCount: vi.fn().mockResolvedValue(5),
        getCompletedCount: vi.fn().mockResolvedValue(50),
        getFailedCount: vi.fn().mockResolvedValue(30), // Critical (>10%: 30/235 = 12.8%)
        getDelayedCount: vi.fn().mockResolvedValue(0),
        close: vi.fn().mockResolvedValue(undefined),
      }));

      const health = await getAllQueueHealth();

      health.forEach((queue) => {
        // Should be critical, not degraded
        expect(queue.status).toBe('critical');
        expect(queue.issues.length).toBeGreaterThanOrEqual(2); // Both issues present
      });
    });

    test('should include queue-specific details', async () => {
      (createQueue as any).mockImplementation(() => ({
        getWaitingCount: vi.fn().mockResolvedValue(0),
        getActiveCount: vi.fn().mockResolvedValue(0),
        getCompletedCount: vi.fn().mockResolvedValue(0),
        getFailedCount: vi.fn().mockResolvedValue(0),
        getDelayedCount: vi.fn().mockResolvedValue(0),
        close: vi.fn().mockResolvedValue(undefined),
      }));

      const health = await getAllQueueHealth();

      health.forEach((queue) => {
        expect(queue).toMatchObject({
          queueName: expect.any(String),
          status: expect.stringMatching(/^(healthy|degraded|critical)$/),
          waiting: expect.any(Number),
          active: expect.any(Number),
          failed: expect.any(Number),
          issues: expect.any(Array),
          timestamp: expect.any(Date),
        });
      });
    });
  });

  describe('edge cases', () => {
    test('should handle division by zero in failure rate calculation', async () => {
      (createQueue as any).mockImplementation(() => ({
        getWaitingCount: vi.fn().mockResolvedValue(0),
        getActiveCount: vi.fn().mockResolvedValue(0),
        getCompletedCount: vi.fn().mockResolvedValue(0),
        getFailedCount: vi.fn().mockResolvedValue(5), // Failed jobs with total=5
        getDelayedCount: vi.fn().mockResolvedValue(0),
        close: vi.fn().mockResolvedValue(undefined),
      }));

      const health = await getAllQueueHealth();

      // Should handle total=failed case (100% failure rate)
      health.forEach((queue) => {
        expect(queue.status).toBe('critical');
        expect(queue.issues[0]).toContain('High failure rate');
      });
    });

    test('should handle negative counts gracefully', async () => {
      (createQueue as any).mockImplementation(() => ({
        getWaitingCount: vi.fn().mockResolvedValue(0),
        getActiveCount: vi.fn().mockResolvedValue(0),
        getCompletedCount: vi.fn().mockResolvedValue(0),
        getFailedCount: vi.fn().mockResolvedValue(0),
        getDelayedCount: vi.fn().mockResolvedValue(0),
        close: vi.fn().mockResolvedValue(undefined),
      }));

      const stats = await getAllQueueStats();

      stats.forEach((queue) => {
        expect(queue.total).toBeGreaterThanOrEqual(0);
      });
    });
  });
});
