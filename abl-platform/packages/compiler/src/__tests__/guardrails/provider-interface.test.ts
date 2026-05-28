import { describe, it, expect } from 'vitest';
import { scoreToSeverity } from '../../platform/guardrails/provider';

describe('scoreToSeverity', () => {
  it.each([
    { score: -0.5, expected: 'safe' },
    { score: 0, expected: 'safe' },
    { score: 0.199_999, expected: 'safe' },
    { score: 0.2, expected: 'low' },
    { score: 0.3, expected: 'low' },
    { score: 0.499_999, expected: 'low' },
    { score: 0.5, expected: 'medium' },
    { score: 0.55, expected: 'medium' },
    { score: 0.699_999, expected: 'medium' },
    { score: 0.7, expected: 'high' },
    { score: 0.75, expected: 'high' },
    { score: 0.899_999, expected: 'high' },
    { score: 0.9, expected: 'critical' },
    { score: 0.95, expected: 'critical' },
    { score: 1.5, expected: 'critical' },
    { score: Number.NaN, expected: 'safe' },
  ])('returns $expected for score $score', ({ score, expected }) => {
    expect(scoreToSeverity(score)).toBe(expected);
  });
});
