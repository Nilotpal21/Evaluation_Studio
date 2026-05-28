import { describe, test, expect } from 'vitest';
import {
  tTest,
  chiSquared,
  minSampleSizeForEffect,
  confidenceInterval,
} from '../pipeline/services/experiment-stats.js';

describe('experiment-stats (pure functions)', () => {
  describe('tTest', () => {
    test('detects significant difference when means are far apart', () => {
      const result = tTest(50, 60, 5, 5, 100, 100);
      expect(result.pValue).toBeLessThan(0.05);
      expect(result.tStat).not.toBe(0);
    });

    test('reports not significant when means are close with large std', () => {
      const result = tTest(50, 51, 50, 50, 30, 30);
      expect(result.pValue).toBeGreaterThan(0.05);
    });

    test('handles equal groups with identical means', () => {
      const result = tTest(50, 50, 10, 10, 100, 100);
      expect(result.tStat).toBe(0);
      expect(result.pValue).toBeCloseTo(1, 5);
    });

    test('returns pValue=1 when standard error is zero', () => {
      const result = tTest(50, 50, 0, 0, 100, 100);
      expect(result.tStat).toBe(0);
      expect(result.pValue).toBe(1);
    });
  });

  describe('chiSquared', () => {
    test('detects significant proportion difference', () => {
      const result = chiSquared(60, 100, 80, 100);
      expect(result.chiSq).toBeGreaterThan(0);
      expect(result.pValue).toBeLessThan(0.05);
    });

    test('handles equal proportions', () => {
      const result = chiSquared(50, 100, 50, 100);
      expect(result.chiSq).toBeCloseTo(0, 5);
    });

    test('returns zero statistic when expected cells are zero', () => {
      const result = chiSquared(0, 100, 0, 100);
      expect(result.chiSq).toBe(0);
      expect(result.pValue).toBe(1);
    });
  });

  describe('minSampleSizeForEffect', () => {
    test('returns reasonable value for baseline=0.5, mde=0.05', () => {
      const n = minSampleSizeForEffect(0.5, 0.05);
      expect(n).toBeGreaterThan(500);
      expect(n).toBeLessThan(5000);
    });

    test('returns 100 when variance is zero (baseline=0)', () => {
      const n = minSampleSizeForEffect(0, 0.05);
      expect(n).toBe(100);
    });

    test('returns 100 when variance is zero (baseline=1)', () => {
      const n = minSampleSizeForEffect(1, 0.05);
      expect(n).toBe(100);
    });
  });

  describe('confidenceInterval', () => {
    test('brackets the true difference', () => {
      const [lower, upper] = confidenceInterval(50, 55, 5, 5, 100, 100);
      expect(lower).toBeLessThan(5);
      expect(upper).toBeGreaterThan(5);
      expect(lower).toBeGreaterThan(0);
    });

    test('is symmetric around the difference', () => {
      const [lower, upper] = confidenceInterval(50, 55, 5, 5, 100, 100);
      const halfWidth = (upper - lower) / 2;
      const midpoint = (upper + lower) / 2;
      expect(midpoint).toBeCloseTo(5, 2);
      expect(halfWidth).toBeGreaterThan(0);
    });
  });
});
