import { describe, expect, it } from 'vitest';

import {
  shouldSkipLayeredReviewForSlice,
  stripLayeredForLowRiskSlice,
} from '../pipeline/execution-envelope.js';
import type { ModelAssignment } from '../types.js';

const baseAssignment: ModelAssignment = {
  primary: { engine: 'codex-cli', model: 'gpt-5.5' },
  fallback: { engine: 'claude-code', model: 'opus' },
  layered: [{ engine: 'claude-code', model: 'sonnet', maxTurns: 40 }],
};

const lowRiskNoExports = {
  impactAnalysis: { riskLevel: 'low' },
  manifest: { exportContracts: [] },
};

const lowRiskWithExports = {
  impactAnalysis: { riskLevel: 'low' },
  manifest: { exportContracts: [{ symbol: 'foo' }] },
};

const mediumRisk = {
  impactAnalysis: { riskLevel: 'medium' },
  manifest: { exportContracts: [] },
};

const highRisk = {
  impactAnalysis: { riskLevel: 'high' },
  manifest: { exportContracts: [] },
};

describe('shouldSkipLayeredReviewForSlice', () => {
  it('returns true for low-risk slices that change no exports', () => {
    expect(shouldSkipLayeredReviewForSlice(lowRiskNoExports)).toBe(true);
  });

  it('returns false for low-risk slices that change exports', () => {
    expect(shouldSkipLayeredReviewForSlice(lowRiskWithExports)).toBe(false);
  });

  it('returns false for medium-risk slices regardless of exports', () => {
    expect(shouldSkipLayeredReviewForSlice(mediumRisk)).toBe(false);
  });

  it('returns false for high-risk slices regardless of exports', () => {
    expect(shouldSkipLayeredReviewForSlice(highRisk)).toBe(false);
  });

  it('treats undefined exportContracts as empty', () => {
    expect(
      shouldSkipLayeredReviewForSlice({
        impactAnalysis: { riskLevel: 'low' },
        manifest: {},
      }),
    ).toBe(true);
  });
});

describe('stripLayeredForLowRiskSlice', () => {
  it('removes layered when slice qualifies', () => {
    const result = stripLayeredForLowRiskSlice(baseAssignment, lowRiskNoExports);
    expect(result.layered).toBeUndefined();
    expect(result.primary).toEqual(baseAssignment.primary);
    expect(result.fallback).toEqual(baseAssignment.fallback);
  });

  it('preserves layered when slice does not qualify', () => {
    const result = stripLayeredForLowRiskSlice(baseAssignment, mediumRisk);
    expect(result.layered).toEqual(baseAssignment.layered);
    expect(result).toBe(baseAssignment);
  });

  it('returns assignment unchanged when no layered to strip', () => {
    const noLayered: ModelAssignment = { primary: baseAssignment.primary };
    const result = stripLayeredForLowRiskSlice(noLayered, lowRiskNoExports);
    expect(result).toBe(noLayered);
  });

  it('does not mutate the input assignment', () => {
    stripLayeredForLowRiskSlice(baseAssignment, lowRiskNoExports);
    expect(baseAssignment.layered).toHaveLength(1);
  });
});
