import { describe, expect, it } from 'vitest';
import { fillTimeGaps } from '../components/analytics/shared';

describe('fillTimeGaps', () => {
  it('returns empty array when data is empty', () => {
    const result = fillTimeGaps([], 'time', '2024-01-15T14:32:00Z', '2024-01-16T23:59:59Z', 'day', {
      count: 0,
    });
    expect(result).toEqual([]);
  });

  // Regression: "now - 30d" ranges produced zero charts because the cursor
  // started at an arbitrary sub-day time (e.g. 14:32 UTC) that never matched
  // ClickHouse toDate() midnight-UTC bucket keys.
  describe('day granularity — cursor snaps to midnight UTC', () => {
    it('matches ClickHouse midnight-UTC keys when from is mid-day', () => {
      const data = [
        { time: '2024-01-15T00:00:00.000Z', count: 42 },
        { time: '2024-01-16T00:00:00.000Z', count: 17 },
      ];
      const result = fillTimeGaps(
        data,
        'time',
        '2024-01-15T14:32:00Z',
        '2024-01-16T23:59:59Z',
        'day',
        { count: 0 },
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ time: '2024-01-15T00:00:00.000Z', count: 42 });
      expect(result[1]).toEqual({ time: '2024-01-16T00:00:00.000Z', count: 17 });
    });

    it('fills gaps with defaults across a multi-day range', () => {
      const data = [{ time: '2024-01-17T00:00:00.000Z', count: 5 }];
      const result = fillTimeGaps(
        data,
        'time',
        '2024-01-15T14:32:00Z',
        '2024-01-17T23:59:59Z',
        'day',
        { count: 0 },
      );
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ time: '2024-01-15T00:00:00.000Z', count: 0 });
      expect(result[1]).toEqual({ time: '2024-01-16T00:00:00.000Z', count: 0 });
      expect(result[2]).toEqual({ time: '2024-01-17T00:00:00.000Z', count: 5 });
    });

    it('includes the final day when its midnight is before to', () => {
      const data = [{ time: '2024-01-20T00:00:00.000Z', count: 9 }];
      const result = fillTimeGaps(
        data,
        'time',
        '2024-01-20T00:00:00Z',
        '2024-01-20T10:30:00Z',
        'day',
        { count: 0 },
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ time: '2024-01-20T00:00:00.000Z', count: 9 });
    });
  });

  // Regression: same alignment issue for hour granularity — from timestamps
  // with non-zero minutes/seconds never matched ClickHouse toStartOfHour keys.
  describe('hour granularity — cursor snaps to top-of-hour UTC', () => {
    it('matches ClickHouse top-of-hour keys when from has minutes', () => {
      const data = [
        { time: '2024-01-15T10:00:00.000Z', count: 99 },
        { time: '2024-01-15T11:00:00.000Z', count: 7 },
      ];
      const result = fillTimeGaps(
        data,
        'time',
        '2024-01-15T10:45:00Z',
        '2024-01-15T11:59:59Z',
        'hour',
        { count: 0 },
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ time: '2024-01-15T10:00:00.000Z', count: 99 });
      expect(result[1]).toEqual({ time: '2024-01-15T11:00:00.000Z', count: 7 });
    });

    it('fills missing hours with defaults', () => {
      const data = [{ time: '2024-01-15T12:00:00.000Z', count: 3 }];
      const result = fillTimeGaps(
        data,
        'time',
        '2024-01-15T10:30:00Z',
        '2024-01-15T12:59:59Z',
        'hour',
        { count: 0 },
      );
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ time: '2024-01-15T10:00:00.000Z', count: 0 });
      expect(result[1]).toEqual({ time: '2024-01-15T11:00:00.000Z', count: 0 });
      expect(result[2]).toEqual({ time: '2024-01-15T12:00:00.000Z', count: 3 });
    });
  });
});
