/**
 * YieldTracker — Pure Function Tests
 *
 * Tests the adaptive yield-tracking functions used by the depth prober
 * to decide when to stop exploration based on diminishing returns.
 */

import { describe, it, expect } from 'vitest';
import {
  createYieldTracker,
  trackPageVisit,
  shouldContinue,
  pickSampleCount,
  type YieldTracker,
} from '../yield-tracker.js';

// ─── createYieldTracker ──────────────────────────────────────────────

describe('createYieldTracker', () => {
  it('returns initial state with empty yields', () => {
    const tracker = createYieldTracker();
    expect(tracker.yieldPerPage).toEqual([]);
    expect(tracker.peakYield).toBe(0);
    expect(tracker.totalNewLinks).toBe(0);
    expect(tracker.consecutiveLowYield).toBe(0);
  });

  it('returns a new object on each call', () => {
    const a = createYieldTracker();
    const b = createYieldTracker();
    expect(a).not.toBe(b);
    expect(a.yieldPerPage).not.toBe(b.yieldPerPage);
  });
});

// ─── trackPageVisit ──────────────────────────────────────────────────

describe('trackPageVisit', () => {
  it('records yield and updates totalNewLinks', () => {
    const tracker = createYieldTracker();
    trackPageVisit(tracker, 10);
    expect(tracker.yieldPerPage).toEqual([10]);
    expect(tracker.totalNewLinks).toBe(10);
    expect(tracker.peakYield).toBe(10);
  });

  it('updates peakYield when a higher yield is recorded', () => {
    const tracker = createYieldTracker();
    trackPageVisit(tracker, 5);
    trackPageVisit(tracker, 20);
    trackPageVisit(tracker, 8);
    expect(tracker.peakYield).toBe(20);
    expect(tracker.totalNewLinks).toBe(33);
  });

  it('increments consecutiveLowYield for low-yield pages', () => {
    const tracker = createYieldTracker();
    // First page sets peak to 100
    trackPageVisit(tracker, 100);
    expect(tracker.consecutiveLowYield).toBe(0);

    // Threshold = max(100 * 0.05, 1) = 5. Yield of 0 < 5 -> low
    trackPageVisit(tracker, 0);
    expect(tracker.consecutiveLowYield).toBe(1);

    trackPageVisit(tracker, 0);
    expect(tracker.consecutiveLowYield).toBe(2);
  });

  it('resets consecutiveLowYield when a productive page appears', () => {
    const tracker = createYieldTracker();
    trackPageVisit(tracker, 100);
    trackPageVisit(tracker, 0);
    trackPageVisit(tracker, 0);
    expect(tracker.consecutiveLowYield).toBe(2);

    // 10 >= threshold (5), so reset
    trackPageVisit(tracker, 10);
    expect(tracker.consecutiveLowYield).toBe(0);
  });

  it('handles zero links on first page', () => {
    const tracker = createYieldTracker();
    trackPageVisit(tracker, 0);
    // threshold = max(0 * 0.05, 1) = 1. 0 < 1 -> low yield
    expect(tracker.consecutiveLowYield).toBe(1);
    expect(tracker.peakYield).toBe(0);
    expect(tracker.totalNewLinks).toBe(0);
  });

  it('uses ABSOLUTE_LOW_YIELD (1) when peak is very small', () => {
    const tracker = createYieldTracker();
    // Peak = 5, threshold = max(5 * 0.05, 1) = max(0.25, 1) = 1
    trackPageVisit(tracker, 5);
    // Yield of 1 >= threshold of 1 -> not low
    trackPageVisit(tracker, 1);
    expect(tracker.consecutiveLowYield).toBe(0);

    // Yield of 0 < threshold of 1 -> low
    trackPageVisit(tracker, 0);
    expect(tracker.consecutiveLowYield).toBe(1);
  });
});

// ─── shouldContinue ──────────────────────────────────────────────────

describe('shouldContinue', () => {
  it('returns continue=true for first few pages (< MIN_PAGES_BEFORE_YIELD_CHECK)', () => {
    const tracker = createYieldTracker();
    trackPageVisit(tracker, 10);
    const decision = shouldContinue(tracker);
    expect(decision.continue).toBe(true);
    expect(decision.trend).toBe('productive');
    expect(decision.reason).toBe('Gathering initial data');
  });

  it('returns continue=true with 2 pages (still below threshold of 3)', () => {
    const tracker = createYieldTracker();
    trackPageVisit(tracker, 10);
    trackPageVisit(tracker, 8);
    const decision = shouldContinue(tracker);
    expect(decision.continue).toBe(true);
    expect(decision.reason).toBe('Gathering initial data');
  });

  it('returns continue=false when peakYield is 0 after enough pages', () => {
    const tracker = createYieldTracker();
    trackPageVisit(tracker, 0);
    trackPageVisit(tracker, 0);
    trackPageVisit(tracker, 0);
    const decision = shouldContinue(tracker);
    expect(decision.continue).toBe(false);
    expect(decision.trend).toBe('stalled');
    expect(decision.reason).toBe('No links discovered on any page');
  });

  it('returns continue=false when consecutive low-yield pages exceed limit', () => {
    const tracker = createYieldTracker();
    trackPageVisit(tracker, 100);
    trackPageVisit(tracker, 80);
    trackPageVisit(tracker, 60);
    // Now 3 pages visited, yield checks kick in
    // Next 3 pages are all zero -> consecutiveLowYield = 3
    trackPageVisit(tracker, 0);
    trackPageVisit(tracker, 0);
    trackPageVisit(tracker, 0);
    const decision = shouldContinue(tracker);
    expect(decision.continue).toBe(false);
    expect(decision.trend).toBe('stalled');
    expect(decision.reason).toContain('consecutive pages below yield threshold');
  });

  it('returns continue=true with declining trend for single low-yield page', () => {
    const tracker = createYieldTracker();
    // Early pages productive, then one decline
    trackPageVisit(tracker, 50);
    trackPageVisit(tracker, 40);
    trackPageVisit(tracker, 30);
    // Low yield but only 1 consecutive -> declining, not stalled
    trackPageVisit(tracker, 0);
    const decision = shouldContinue(tracker);
    expect(decision.continue).toBe(true);
    expect(decision.trend).toBe('declining');
  });

  it('returns continue=true when exploration is productive', () => {
    const tracker = createYieldTracker();
    trackPageVisit(tracker, 20);
    trackPageVisit(tracker, 25);
    trackPageVisit(tracker, 22);
    const decision = shouldContinue(tracker);
    expect(decision.continue).toBe(true);
    expect(decision.trend).toBe('productive');
    expect(decision.reason).toBe('Discovery productive');
  });

  it('handles explosive growth followed by crash', () => {
    const tracker = createYieldTracker();
    trackPageVisit(tracker, 10);
    trackPageVisit(tracker, 200);
    trackPageVisit(tracker, 500);
    // Peak is 500, threshold = max(25, 1) = 25
    trackPageVisit(tracker, 0);
    trackPageVisit(tracker, 0);
    trackPageVisit(tracker, 0);
    const decision = shouldContinue(tracker);
    expect(decision.continue).toBe(false);
    expect(decision.trend).toBe('stalled');
  });
});

// ─── pickSampleCount ─────────────────────────────────────────────────

describe('pickSampleCount', () => {
  it('returns 0 for zero or negative link counts', () => {
    expect(pickSampleCount({ linkCount: 0 })).toBe(0);
    expect(pickSampleCount({ linkCount: -5 })).toBe(0);
  });

  it('returns at most 2 for very small hubs (linkCount <= 5)', () => {
    expect(pickSampleCount({ linkCount: 1 })).toBe(1);
    expect(pickSampleCount({ linkCount: 2 })).toBe(2);
    expect(pickSampleCount({ linkCount: 5 })).toBe(2);
  });

  it('returns 3 for medium hubs (6-20 links)', () => {
    expect(pickSampleCount({ linkCount: 6 })).toBe(3);
    expect(pickSampleCount({ linkCount: 10 })).toBe(3);
    expect(pickSampleCount({ linkCount: 20 })).toBe(3);
  });

  it('scales logarithmically for large hubs', () => {
    // log2(50) ~= 5.6 -> ceil = 6
    expect(pickSampleCount({ linkCount: 50 })).toBe(6);
    // log2(100) ~= 6.6 -> ceil = 7
    expect(pickSampleCount({ linkCount: 100 })).toBe(7);
    // log2(200) ~= 7.6 -> ceil = 8
    expect(pickSampleCount({ linkCount: 200 })).toBe(8);
  });

  it('caps at 8 for very large hubs', () => {
    expect(pickSampleCount({ linkCount: 500 })).toBe(8);
    expect(pickSampleCount({ linkCount: 10000 })).toBe(8);
  });
});
