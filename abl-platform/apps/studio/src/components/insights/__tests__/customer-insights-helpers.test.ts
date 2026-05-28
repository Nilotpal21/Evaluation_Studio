import { describe, it, expect } from 'vitest';
import { kpiStatus, formatPercent } from '../CustomerInsightsPage';

// ── kpiStatus tests ─────────────────────────────────────────────────────────

describe('kpiStatus', () => {
  describe('normal mode (higher is better)', () => {
    it('returns healthy when value >= goodThreshold', () => {
      expect(kpiStatus(0.5, 0.3, 0)).toBe('healthy');
      expect(kpiStatus(0.3, 0.3, 0)).toBe('healthy');
    });

    it('returns warning when value is between warnThreshold and goodThreshold', () => {
      expect(kpiStatus(0.15, 0.3, 0)).toBe('warning');
      expect(kpiStatus(0, 0.3, 0)).toBe('warning');
    });

    it('returns critical when value < warnThreshold', () => {
      expect(kpiStatus(-0.5, 0.3, 0)).toBe('critical');
      expect(kpiStatus(-0.1, 0.3, 0)).toBe('critical');
    });
  });

  describe('inverse mode (lower is better)', () => {
    it('returns healthy when value <= goodThreshold', () => {
      expect(kpiStatus(5, 10, 25, true)).toBe('healthy');
      expect(kpiStatus(10, 10, 25, true)).toBe('healthy');
    });

    it('returns warning when value is between goodThreshold and warnThreshold', () => {
      expect(kpiStatus(15, 10, 25, true)).toBe('warning');
      expect(kpiStatus(25, 10, 25, true)).toBe('warning');
    });

    it('returns critical when value > warnThreshold', () => {
      expect(kpiStatus(30, 10, 25, true)).toBe('critical');
      expect(kpiStatus(100, 10, 25, true)).toBe('critical');
    });
  });

  it('handles zero value correctly', () => {
    // Normal: 0 >= 0 (goodThreshold) -> healthy
    expect(kpiStatus(0, 0, -1)).toBe('healthy');
    // Inverse: 0 <= 0 (goodThreshold) -> healthy
    expect(kpiStatus(0, 0, 10, true)).toBe('healthy');
  });

  it('handles exact boundary values', () => {
    expect(kpiStatus(50, 50, 30)).toBe('healthy');
    expect(kpiStatus(30, 50, 30)).toBe('warning');
    expect(kpiStatus(50, 50, 30, true)).toBe('healthy'); // 50 <= 50 (goodThreshold)
    expect(kpiStatus(51, 50, 30, true)).toBe('critical'); // 51 > 30 (warnThreshold)
  });
});

// ── formatPercent tests ─────────────────────────────────────────────────────

describe('formatPercent', () => {
  it('formats a ratio as a percentage with one decimal place', () => {
    expect(formatPercent(25, 100)).toBe('25.0%');
    expect(formatPercent(1, 3)).toBe('33.3%');
  });

  it('returns 0% when total is zero', () => {
    expect(formatPercent(0, 0)).toBe('0%');
    expect(formatPercent(10, 0)).toBe('0%');
  });

  it('handles 100% case', () => {
    expect(formatPercent(50, 50)).toBe('100.0%');
  });

  it('handles small fractions', () => {
    expect(formatPercent(1, 1000)).toBe('0.1%');
  });

  it('handles zero count with non-zero total', () => {
    expect(formatPercent(0, 100)).toBe('0.0%');
  });
});
