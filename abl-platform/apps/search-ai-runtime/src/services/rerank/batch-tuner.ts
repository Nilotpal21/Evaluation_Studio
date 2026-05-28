/**
 * Batch Performance Tuner (RFC-003 Phase 2.4)
 *
 * Adaptive configuration tuning based on observed workload patterns.
 * Adjusts batch size, wait time, and cache settings for optimal performance.
 */

import type { BatchConfig, BatchStats } from './batch-types.js';
import { DEFAULT_BATCH_CONFIG } from './batch-types.js';

export interface PerformanceProfile {
  /** Average requests per second */
  avgRequestsPerSecond: number;
  /** Average batch size achieved */
  avgBatchSize: number;
  /** Batch utilization (% of maxBatchSize used) */
  batchUtilization: number;
  /** Cache hit rate */
  cacheHitRate: number;
  /** Average batch wait time in ms */
  avgBatchWaitMs: number;
  /** Call reduction (% of API calls saved) */
  callReduction: number;
}

export interface TuningRecommendation {
  /** Recommended configuration changes */
  config: Partial<BatchConfig>;
  /** Reason for recommendation */
  reason: string;
  /** Expected improvement */
  expectedImprovement: string;
  /** Priority (high, medium, low) */
  priority: 'high' | 'medium' | 'low';
}

/**
 * Analyzes batch statistics and recommends configuration tuning.
 */
export class BatchPerformanceTuner {
  private readonly observationWindow: number;
  private statsHistory: Array<{ timestamp: number; stats: BatchStats }> = [];

  constructor(observationWindowMs: number = 300000) {
    // Default: 5 minute observation window
    this.observationWindow = observationWindowMs;
  }

  /**
   * Record stats sample for analysis.
   */
  recordStats(stats: BatchStats): void {
    this.statsHistory.push({
      timestamp: Date.now(),
      stats,
    });

    // Trim old samples outside observation window
    const cutoff = Date.now() - this.observationWindow;
    this.statsHistory = this.statsHistory.filter((s) => s.timestamp >= cutoff);
  }

  /**
   * Compute performance profile from recent stats.
   */
  getPerformanceProfile(): PerformanceProfile | null {
    if (this.statsHistory.length < 2) {
      return null; // Not enough data
    }

    const latest = this.statsHistory[this.statsHistory.length - 1].stats;
    const earliest = this.statsHistory[0].stats;
    const timeSpanSec =
      (this.statsHistory[this.statsHistory.length - 1].timestamp - this.statsHistory[0].timestamp) /
      1000;

    const requestDelta = latest.totalRequests - earliest.totalRequests;
    const avgRequestsPerSecond = requestDelta / timeSpanSec;

    return {
      avgRequestsPerSecond,
      avgBatchSize: latest.avgBatchSize,
      batchUtilization: latest.batchUtilization,
      cacheHitRate: latest.cacheHitRate,
      avgBatchWaitMs: latest.avgBatchWaitMs,
      callReduction: latest.callReduction,
    };
  }

  /**
   * Analyze performance and recommend configuration tuning.
   */
  getTuningRecommendations(currentConfig: BatchConfig): TuningRecommendation[] {
    const profile = this.getPerformanceProfile();
    if (!profile) {
      return []; // Not enough data
    }

    const recommendations: TuningRecommendation[] = [];

    // ─── High Traffic: Increase Batch Size ─────────────────────────────────────

    if (
      profile.avgRequestsPerSecond > 100 &&
      profile.batchUtilization > 0.8 &&
      currentConfig.maxBatchSize < 200
    ) {
      recommendations.push({
        config: { maxBatchSize: Math.min(currentConfig.maxBatchSize * 1.5, 200) },
        reason: `High traffic (${profile.avgRequestsPerSecond.toFixed(0)} req/s) with ${(profile.batchUtilization * 100).toFixed(0)}% batch utilization - increase capacity`,
        expectedImprovement: 'Higher throughput, better API call reduction',
        priority: 'high',
      });
    }

    // ─── Low Traffic: Decrease Batch Size & Wait Time ──────────────────────────

    if (
      profile.avgRequestsPerSecond < 20 &&
      profile.batchUtilization < 0.3 &&
      currentConfig.maxBatchSize > 50
    ) {
      recommendations.push({
        config: {
          maxBatchSize: Math.max(currentConfig.maxBatchSize * 0.7, 50),
          maxWaitMs: Math.max(currentConfig.maxWaitMs * 0.8, 20),
        },
        reason: `Low traffic (${profile.avgRequestsPerSecond.toFixed(0)} req/s) with ${(profile.batchUtilization * 100).toFixed(0)}% utilization - reduce latency`,
        expectedImprovement: 'Lower latency (-20%), better responsiveness',
        priority: 'medium',
      });
    }

    // ─── High Cache Hit Rate: Increase Cache Size ──────────────────────────────

    if (
      profile.cacheHitRate > 0.6 &&
      currentConfig.cacheMaxSize < 5000 &&
      currentConfig.deduplicate
    ) {
      recommendations.push({
        config: { cacheMaxSize: Math.min(currentConfig.cacheMaxSize * 2, 5000) },
        reason: `High cache hit rate (${(profile.cacheHitRate * 100).toFixed(0)}%) - increase cache capacity for more savings`,
        expectedImprovement: 'Higher cache hit rate, fewer API calls',
        priority: 'medium',
      });
    }

    // ─── Low Cache Hit Rate: Decrease Cache TTL or Size ────────────────────────

    if (
      profile.cacheHitRate < 0.1 &&
      currentConfig.cacheMaxSize > 500 &&
      currentConfig.deduplicate
    ) {
      recommendations.push({
        config: {
          cacheMaxSize: Math.max(currentConfig.cacheMaxSize * 0.5, 500),
          deduplicationTTL: Math.max(currentConfig.deduplicationTTL * 0.5, 2000),
        },
        reason: `Low cache hit rate (${(profile.cacheHitRate * 100).toFixed(0)}%) - reduce cache overhead`,
        expectedImprovement: 'Lower memory usage, minimal impact on performance',
        priority: 'low',
      });
    }

    // ─── High Batch Wait Time: Decrease Wait Threshold ─────────────────────────

    if (
      profile.avgBatchWaitMs > 80 &&
      profile.batchUtilization < 0.5 &&
      currentConfig.maxWaitMs > 30
    ) {
      recommendations.push({
        config: { maxWaitMs: Math.max(currentConfig.maxWaitMs * 0.7, 30) },
        reason: `High batch wait time (${profile.avgBatchWaitMs.toFixed(0)}ms) with low utilization - reduce latency`,
        expectedImprovement: 'Lower latency (-30%), faster responses',
        priority: 'high',
      });
    }

    // ─── Excellent Performance: No Changes Needed ───────────────────────────────

    if (
      profile.callReduction > 0.8 &&
      profile.avgBatchWaitMs < 60 &&
      profile.batchUtilization > 0.4 &&
      profile.batchUtilization < 0.9
    ) {
      recommendations.push({
        config: {},
        reason: `Optimal performance: ${(profile.callReduction * 100).toFixed(0)}% call reduction, ${profile.avgBatchWaitMs.toFixed(0)}ms avg wait, ${(profile.batchUtilization * 100).toFixed(0)}% utilization`,
        expectedImprovement: 'Configuration is well-tuned - no changes recommended',
        priority: 'low',
      });
    }

    return recommendations;
  }

  /**
   * Apply recommended configuration changes.
   */
  applyRecommendations(
    currentConfig: BatchConfig,
    recommendations: TuningRecommendation[],
  ): BatchConfig {
    let tuned = { ...currentConfig };

    // Apply high-priority recommendations first
    const sorted = recommendations
      .filter((r) => Object.keys(r.config).length > 0)
      .sort((a, b) => {
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });

    for (const rec of sorted) {
      tuned = { ...tuned, ...rec.config };
    }

    return tuned;
  }

  /**
   * Get workload classification.
   */
  classifyWorkload(): 'idle' | 'low' | 'moderate' | 'high' | 'peak' | null {
    const profile = this.getPerformanceProfile();
    if (!profile) return null;

    const rps = profile.avgRequestsPerSecond;

    if (rps < 5) return 'idle';
    if (rps < 25) return 'low';
    if (rps < 75) return 'moderate';
    if (rps < 150) return 'high';
    return 'peak';
  }

  /**
   * Get preset configuration for workload type.
   */
  static getPresetConfig(workload: 'idle' | 'low' | 'moderate' | 'high' | 'peak'): BatchConfig {
    const presets: Record<typeof workload, Partial<BatchConfig>> = {
      idle: {
        maxBatchSize: 25,
        maxWaitMs: 20,
        cacheMaxSize: 250,
        deduplicationTTL: 3000,
      },
      low: {
        maxBatchSize: 50,
        maxWaitMs: 30,
        cacheMaxSize: 500,
        deduplicationTTL: 5000,
      },
      moderate: {
        maxBatchSize: 100,
        maxWaitMs: 50,
        cacheMaxSize: 1000,
        deduplicationTTL: 5000,
      },
      high: {
        maxBatchSize: 150,
        maxWaitMs: 60,
        cacheMaxSize: 2000,
        deduplicationTTL: 7000,
      },
      peak: {
        maxBatchSize: 200,
        maxWaitMs: 75,
        cacheMaxSize: 5000,
        deduplicationTTL: 10000,
      },
    };

    return { ...DEFAULT_BATCH_CONFIG, ...presets[workload] };
  }

  /**
   * Clear stats history.
   */
  reset(): void {
    this.statsHistory = [];
  }
}
