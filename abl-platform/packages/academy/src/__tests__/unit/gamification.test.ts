import { describe, it, expect } from 'vitest';
import {
  deriveRankFromPoints,
  longestConsecutiveStreak,
} from '../../services/gamification-service.js';
import type { RankConfig } from '../../types.js';

describe('deriveRankFromPoints', () => {
  const ranks: RankConfig[] = [
    { level: 1, title: 'Newcomer', minPoints: 0 },
    { level: 2, title: 'Explorer', minPoints: 500 },
    { level: 3, title: 'Practitioner', minPoints: 1500 },
    { level: 4, title: 'Specialist', minPoints: 3000 },
    { level: 5, title: 'Expert', minPoints: 5000 },
    { level: 6, title: 'Master', minPoints: 8000, requirePaths: 2 },
  ];

  it('returns Newcomer for 0 points', () => {
    expect(deriveRankFromPoints(0, ranks)).toBe('Newcomer');
  });

  it('returns Newcomer for points below Explorer threshold', () => {
    expect(deriveRankFromPoints(499, ranks)).toBe('Newcomer');
  });

  it('returns Explorer at exactly 500 points', () => {
    expect(deriveRankFromPoints(500, ranks)).toBe('Explorer');
  });

  it('returns Explorer for 999 points', () => {
    expect(deriveRankFromPoints(999, ranks)).toBe('Explorer');
  });

  it('returns Practitioner at 1500 points', () => {
    expect(deriveRankFromPoints(1500, ranks)).toBe('Practitioner');
  });

  it('returns Specialist at 3000 points', () => {
    expect(deriveRankFromPoints(3000, ranks)).toBe('Specialist');
  });

  it('returns Expert at 5000 points', () => {
    expect(deriveRankFromPoints(5000, ranks)).toBe('Expert');
  });

  it('returns Master at 8000 points', () => {
    expect(deriveRankFromPoints(8000, ranks)).toBe('Master');
  });

  it('returns Master at 99999 points', () => {
    expect(deriveRankFromPoints(99999, ranks)).toBe('Master');
  });

  it('uses default ranks when none provided', () => {
    expect(deriveRankFromPoints(0)).toBe('Newcomer');
    expect(deriveRankFromPoints(500)).toBe('Explorer');
    expect(deriveRankFromPoints(8000)).toBe('Master');
  });

  it('handles empty ranks gracefully', () => {
    expect(deriveRankFromPoints(100, [])).toBe('Newcomer');
  });
});

describe('longestConsecutiveStreak', () => {
  it('returns 0 for empty array', () => {
    expect(longestConsecutiveStreak([])).toBe(0);
  });

  it('returns 1 for a single day', () => {
    expect(longestConsecutiveStreak(['2026-04-01'])).toBe(1);
  });

  it('returns 3 for three consecutive days', () => {
    const days = ['2026-04-01', '2026-04-02', '2026-04-03'];
    expect(longestConsecutiveStreak(days)).toBe(3);
  });

  it('returns 7 for a full week', () => {
    const days = [
      '2026-04-01',
      '2026-04-02',
      '2026-04-03',
      '2026-04-04',
      '2026-04-05',
      '2026-04-06',
      '2026-04-07',
    ];
    expect(longestConsecutiveStreak(days)).toBe(7);
  });

  it('returns the longest streak when there are gaps', () => {
    const days = [
      '2026-04-01',
      '2026-04-02',
      '2026-04-03',
      // gap
      '2026-04-06',
      '2026-04-07',
    ];
    expect(longestConsecutiveStreak(days)).toBe(3);
  });

  it('handles duplicate days correctly (does not break streak)', () => {
    const days = [
      '2026-04-01',
      '2026-04-01', // duplicate
      '2026-04-02',
      '2026-04-03',
    ];
    expect(longestConsecutiveStreak(days)).toBe(3);
  });

  it('returns correct streak at the end of the array', () => {
    const days = [
      '2026-04-01',
      // gap
      '2026-04-05',
      '2026-04-06',
      '2026-04-07',
      '2026-04-08',
    ];
    expect(longestConsecutiveStreak(days)).toBe(4);
  });

  it('handles non-consecutive scattered days', () => {
    const days = ['2026-04-01', '2026-04-03', '2026-04-05', '2026-04-07'];
    expect(longestConsecutiveStreak(days)).toBe(1);
  });
});
