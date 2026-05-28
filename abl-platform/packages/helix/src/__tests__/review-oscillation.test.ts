import { describe, expect, it } from 'vitest';

import {
  analyzeArchReviewHistory,
  recordArchReviewVerdict,
} from '../pipeline/engine/review-oscillation.js';

const ts = (offset: number) => new Date(1700000000000 + offset * 1000).toISOString();

describe('analyzeArchReviewHistory', () => {
  it('returns no oscillation when history is empty', () => {
    expect(analyzeArchReviewHistory(undefined)).toEqual({
      isOscillating: false,
      totalAttempts: 0,
      consecutiveBlocked: 0,
      flappedToApproved: false,
    });
    expect(analyzeArchReviewHistory([])).toEqual({
      isOscillating: false,
      totalAttempts: 0,
      consecutiveBlocked: 0,
      flappedToApproved: false,
    });
  });

  it('returns no oscillation for a single approved verdict', () => {
    const result = analyzeArchReviewHistory([
      { approved: true, findingsCount: 0, timestamp: ts(0) },
    ]);
    expect(result.isOscillating).toBe(false);
    expect(result.flappedToApproved).toBe(false);
    expect(result.totalAttempts).toBe(1);
  });

  it('detects flapping-to-approved (slice 5 production pattern)', () => {
    // Real session 74a76eaf slice 5 timeline
    const result = analyzeArchReviewHistory([
      { approved: false, findingsCount: 2, timestamp: ts(0) },
      { approved: false, findingsCount: 2, timestamp: ts(60) },
      { approved: false, findingsCount: 1, timestamp: ts(120) },
      { approved: false, findingsCount: 2, timestamp: ts(180) },
      { approved: true, findingsCount: 0, timestamp: ts(240) },
    ]);
    expect(result.isOscillating).toBe(true);
    expect(result.flappedToApproved).toBe(true);
    expect(result.totalAttempts).toBe(5);
    expect(result.consecutiveBlocked).toBe(0);
  });

  it('detects oscillation when reviewer is currently blocked after multiple flips', () => {
    const result = analyzeArchReviewHistory([
      { approved: false, findingsCount: 3, timestamp: ts(0) },
      { approved: true, findingsCount: 0, timestamp: ts(60) },
      { approved: false, findingsCount: 1, timestamp: ts(120) },
    ]);
    expect(result.isOscillating).toBe(true);
    expect(result.flappedToApproved).toBe(false);
    expect(result.consecutiveBlocked).toBe(1);
  });

  it('counts consecutive blocked verdicts at the tail', () => {
    const result = analyzeArchReviewHistory([
      { approved: true, findingsCount: 0, timestamp: ts(0) },
      { approved: false, findingsCount: 1, timestamp: ts(60) },
      { approved: false, findingsCount: 2, timestamp: ts(120) },
      { approved: false, findingsCount: 1, timestamp: ts(180) },
    ]);
    expect(result.consecutiveBlocked).toBe(3);
    expect(result.isOscillating).toBe(true);
  });

  it('does not flag oscillation for monotonic-blocked history (real failures)', () => {
    const result = analyzeArchReviewHistory([
      { approved: false, findingsCount: 3, timestamp: ts(0) },
      { approved: false, findingsCount: 3, timestamp: ts(60) },
      { approved: false, findingsCount: 3, timestamp: ts(120) },
    ]);
    expect(result.isOscillating).toBe(false);
    expect(result.flappedToApproved).toBe(false);
    expect(result.consecutiveBlocked).toBe(3);
  });

  it('does not flag oscillation for two-attempt history (under threshold)', () => {
    const result = analyzeArchReviewHistory([
      { approved: false, findingsCount: 1, timestamp: ts(0) },
      { approved: true, findingsCount: 0, timestamp: ts(60) },
    ]);
    expect(result.isOscillating).toBe(false);
    // flappedToApproved is true even with 2 attempts — caller may still want
    // to surface this for visibility even though we don't formally call it
    // oscillation until 3+.
    expect(result.flappedToApproved).toBe(true);
    expect(result.totalAttempts).toBe(2);
  });
});

describe('recordArchReviewVerdict', () => {
  it('appends without mutating the input', () => {
    const original = [{ approved: false, findingsCount: 2, timestamp: ts(0) }];
    const next = recordArchReviewVerdict(original, true, 0, ts(60));
    expect(next).toHaveLength(2);
    expect(original).toHaveLength(1);
    expect(next[1]).toEqual({ approved: true, findingsCount: 0, timestamp: ts(60) });
  });

  it('starts a fresh array when history is undefined', () => {
    const next = recordArchReviewVerdict(undefined, false, 1, ts(0));
    expect(next).toEqual([{ approved: false, findingsCount: 1, timestamp: ts(0) }]);
  });
});
