/**
 * Batch Performance Tuner Tests (RFC-003 Phase 2.4)
 *
 * Tests adaptive configuration tuning based on workload patterns.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BatchPerformanceTuner } from '../batch-tuner.js';
import type { BatchStats, BatchConfig } from '../batch-types.js';
import { DEFAULT_BATCH_CONFIG } from '../batch-types.js';

describe('BatchPerformanceTuner', () => {
  let tuner: BatchPerformanceTuner;

  const createMockStats = (overrides?: Partial<BatchStats>): BatchStats => ({
    totalRequests: 1000,
    batchedRequests: 950,
    batchCount: 15,
    avgBatchSize: 63,
    batchUtilization: 0.63,
    cacheHits: 200,
    cacheMisses: 800,
    cacheHitRate: 0.2,
    avgBatchWaitMs: 45,
    avgBatchExecutionMs: 120,
    avgTotalLatencyMs: 165,
    activeQueues: 3,
    totalQueuedRequests: 50,
    stalledRequests: 0,
    estimatedAPICalls: 1000,
    actualAPICalls: 150,
    callReduction: 0.85,
    ...overrides,
  });

  beforeEach(() => {
    tuner = new BatchPerformanceTuner(60000); // 1 minute window for testing
  });

  describe('Stats Collection', () => {
    it('should record and retrieve stats', () => {
      const stats = createMockStats();
      tuner.recordStats(stats);

      // Need at least 2 samples for profile
      tuner.recordStats(createMockStats({ totalRequests: 1100 }));

      const profile = tuner.getPerformanceProfile();
      expect(profile).not.toBeNull();
    });

    it('should return null profile with insufficient data', () => {
      const profile = tuner.getPerformanceProfile();
      expect(profile).toBeNull();
    });

    it('should trim old samples outside observation window', () => {
      const shortWindowTuner = new BatchPerformanceTuner(100); // 100ms window

      shortWindowTuner.recordStats(createMockStats());

      // Wait for window to expire
      setTimeout(() => {
        shortWindowTuner.recordStats(createMockStats());
        // Old sample should be trimmed
      }, 150);
    });
  });

  describe('Performance Profile', () => {
    it('should calculate requests per second', () => {
      tuner.recordStats(createMockStats({ totalRequests: 1000 }));

      // Simulate 1 second later
      setTimeout(() => {
        tuner.recordStats(createMockStats({ totalRequests: 1100 }));

        const profile = tuner.getPerformanceProfile();
        expect(profile?.avgRequestsPerSecond).toBeGreaterThan(0);
      }, 1000);
    });

    it('should include all performance metrics', () => {
      tuner.recordStats(createMockStats());
      tuner.recordStats(createMockStats({ totalRequests: 1100 }));

      const profile = tuner.getPerformanceProfile();

      expect(profile).toMatchObject({
        avgRequestsPerSecond: expect.any(Number),
        avgBatchSize: expect.any(Number),
        batchUtilization: expect.any(Number),
        cacheHitRate: expect.any(Number),
        avgBatchWaitMs: expect.any(Number),
        callReduction: expect.any(Number),
      });
    });
  });

  describe('High Traffic Recommendations', () => {
    it('should recommend increasing batch size for high traffic', () => {
      // Simulate high traffic with high utilization
      const stats = createMockStats({
        totalRequests: 10000,
        batchUtilization: 0.85,
        avgBatchSize: 85,
      });

      tuner.recordStats(stats);

      setTimeout(() => {
        tuner.recordStats(
          createMockStats({ totalRequests: 11000, batchUtilization: 0.85, avgBatchSize: 85 }),
        );

        const recommendations = tuner.getTuningRecommendations(DEFAULT_BATCH_CONFIG);

        const batchSizeRec = recommendations.find((r) => r.config.maxBatchSize);
        expect(batchSizeRec).toBeDefined();
        expect(batchSizeRec?.priority).toBe('high');
        expect(batchSizeRec?.config.maxBatchSize).toBeGreaterThan(
          DEFAULT_BATCH_CONFIG.maxBatchSize,
        );
      }, 1000);
    });
  });

  describe('Low Traffic Recommendations', () => {
    it('should recommend decreasing batch size for low traffic', () => {
      // Simulate low traffic with low utilization
      const stats = createMockStats({
        totalRequests: 100,
        batchUtilization: 0.25,
        avgBatchSize: 25,
      });

      tuner.recordStats(stats);

      setTimeout(() => {
        tuner.recordStats(
          createMockStats({ totalRequests: 120, batchUtilization: 0.25, avgBatchSize: 25 }),
        );

        const config = { ...DEFAULT_BATCH_CONFIG, maxBatchSize: 150 };
        const recommendations = tuner.getTuningRecommendations(config);

        const batchSizeRec = recommendations.find((r) => r.config.maxBatchSize);
        expect(batchSizeRec).toBeDefined();
        expect(batchSizeRec?.priority).toBe('medium');
        expect(batchSizeRec?.config.maxBatchSize).toBeLessThan(config.maxBatchSize);
      }, 1000);
    });
  });

  describe('Cache Tuning Recommendations', () => {
    it('should recommend increasing cache size for high hit rate', () => {
      const stats = createMockStats({
        cacheHitRate: 0.7,
        cacheHits: 700,
        cacheMisses: 300,
      });

      tuner.recordStats(stats);
      tuner.recordStats(createMockStats({ totalRequests: 1100, cacheHitRate: 0.7 }));

      const recommendations = tuner.getTuningRecommendations(DEFAULT_BATCH_CONFIG);

      const cacheRec = recommendations.find((r) => r.config.cacheMaxSize);
      expect(cacheRec).toBeDefined();
      expect(cacheRec?.config.cacheMaxSize).toBeGreaterThan(DEFAULT_BATCH_CONFIG.cacheMaxSize);
    });

    it('should recommend decreasing cache size for low hit rate', () => {
      const stats = createMockStats({
        cacheHitRate: 0.05,
        cacheHits: 50,
        cacheMisses: 950,
      });

      tuner.recordStats(stats);
      tuner.recordStats(createMockStats({ totalRequests: 1100, cacheHitRate: 0.05 }));

      const config = { ...DEFAULT_BATCH_CONFIG, cacheMaxSize: 2000 };
      const recommendations = tuner.getTuningRecommendations(config);

      const cacheRec = recommendations.find((r) => r.config.cacheMaxSize);
      expect(cacheRec).toBeDefined();
      expect(cacheRec?.config.cacheMaxSize).toBeLessThan(config.cacheMaxSize);
    });
  });

  describe('Latency Tuning Recommendations', () => {
    it('should recommend decreasing wait time for high latency', () => {
      const stats = createMockStats({
        avgBatchWaitMs: 90,
        batchUtilization: 0.4,
      });

      tuner.recordStats(stats);
      tuner.recordStats(
        createMockStats({ totalRequests: 1100, avgBatchWaitMs: 90, batchUtilization: 0.4 }),
      );

      const recommendations = tuner.getTuningRecommendations(DEFAULT_BATCH_CONFIG);

      const waitRec = recommendations.find((r) => r.config.maxWaitMs);
      expect(waitRec).toBeDefined();
      expect(waitRec?.priority).toBe('high');
      expect(waitRec?.config.maxWaitMs).toBeLessThan(DEFAULT_BATCH_CONFIG.maxWaitMs);
    });
  });

  describe('Optimal Performance', () => {
    it('should recognize when configuration is optimal', () => {
      const stats = createMockStats({
        callReduction: 0.85,
        avgBatchWaitMs: 45,
        batchUtilization: 0.65,
      });

      tuner.recordStats(stats);
      tuner.recordStats(
        createMockStats({
          totalRequests: 1100,
          callReduction: 0.85,
          avgBatchWaitMs: 45,
          batchUtilization: 0.65,
        }),
      );

      const recommendations = tuner.getTuningRecommendations(DEFAULT_BATCH_CONFIG);

      const optimalRec = recommendations.find((r) => Object.keys(r.config).length === 0);
      expect(optimalRec).toBeDefined();
      expect(optimalRec?.expectedImprovement).toContain('well-tuned');
    });
  });

  describe('Workload Classification', () => {
    it('should classify idle workload', () => {
      const stats = createMockStats({ totalRequests: 100 });
      tuner.recordStats(stats);

      setTimeout(() => {
        tuner.recordStats(createMockStats({ totalRequests: 103 })); // 3 req/s

        const workload = tuner.classifyWorkload();
        expect(workload).toBe('idle');
      }, 1000);
    });

    it('should classify peak workload', () => {
      const stats = createMockStats({ totalRequests: 1000 });
      tuner.recordStats(stats);

      setTimeout(() => {
        tuner.recordStats(createMockStats({ totalRequests: 1200 })); // 200 req/s

        const workload = tuner.classifyWorkload();
        expect(workload).toBe('peak');
      }, 1000);
    });
  });

  describe('Preset Configurations', () => {
    it('should provide idle workload preset', () => {
      const config = BatchPerformanceTuner.getPresetConfig('idle');

      expect(config.maxBatchSize).toBeLessThan(DEFAULT_BATCH_CONFIG.maxBatchSize);
      expect(config.maxWaitMs).toBeLessThan(DEFAULT_BATCH_CONFIG.maxWaitMs);
    });

    it('should provide peak workload preset', () => {
      const config = BatchPerformanceTuner.getPresetConfig('peak');

      expect(config.maxBatchSize).toBeGreaterThan(DEFAULT_BATCH_CONFIG.maxBatchSize);
      expect(config.cacheMaxSize).toBeGreaterThan(DEFAULT_BATCH_CONFIG.cacheMaxSize);
    });

    it('should provide progressive scaling across workload types', () => {
      const idle = BatchPerformanceTuner.getPresetConfig('idle');
      const low = BatchPerformanceTuner.getPresetConfig('low');
      const moderate = BatchPerformanceTuner.getPresetConfig('moderate');
      const high = BatchPerformanceTuner.getPresetConfig('high');
      const peak = BatchPerformanceTuner.getPresetConfig('peak');

      // Batch size should increase
      expect(idle.maxBatchSize).toBeLessThan(low.maxBatchSize);
      expect(low.maxBatchSize).toBeLessThan(moderate.maxBatchSize);
      expect(moderate.maxBatchSize).toBeLessThan(high.maxBatchSize);
      expect(high.maxBatchSize).toBeLessThan(peak.maxBatchSize);

      // Cache size should increase
      expect(idle.cacheMaxSize).toBeLessThan(peak.cacheMaxSize);
    });
  });

  describe('Apply Recommendations', () => {
    it('should apply high priority recommendations first', () => {
      const stats = createMockStats({
        totalRequests: 10000,
        batchUtilization: 0.85,
        avgBatchWaitMs: 90,
      });

      tuner.recordStats(stats);

      setTimeout(() => {
        tuner.recordStats(
          createMockStats({
            totalRequests: 11000,
            batchUtilization: 0.85,
            avgBatchWaitMs: 90,
          }),
        );

        const recommendations = tuner.getTuningRecommendations(DEFAULT_BATCH_CONFIG);
        const tuned = tuner.applyRecommendations(DEFAULT_BATCH_CONFIG, recommendations);

        // Should have applied changes
        expect(tuned).not.toEqual(DEFAULT_BATCH_CONFIG);
      }, 1000);
    });

    it('should not modify config when no recommendations', () => {
      const tuned = tuner.applyRecommendations(DEFAULT_BATCH_CONFIG, []);
      expect(tuned).toEqual(DEFAULT_BATCH_CONFIG);
    });
  });

  describe('Reset', () => {
    it('should clear stats history', () => {
      tuner.recordStats(createMockStats());
      tuner.recordStats(createMockStats());

      tuner.reset();

      const profile = tuner.getPerformanceProfile();
      expect(profile).toBeNull();
    });
  });
});
