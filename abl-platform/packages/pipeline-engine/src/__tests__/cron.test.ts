import { describe, test, expect } from 'vitest';
import { getNextCronTime } from '../pipeline/utils/cron.js';

/**
 * The implementation uses Date's local-time methods (getMinutes, getHours) when
 * scanning for the next cron slot.  To stay timezone-agnostic, all timestamps in
 * these tests are built with the local-time Date constructor
 * `new Date(year, month-1, day, hour, minute, second, ms)` so that local
 * getMinutes()/getHours() inside the implementation match the values we reason
 * about here.
 *
 * Reference point: local 2026-02-28 10:15:30 (seconds/ms are non-zero so
 * the implementation always advances at least one full minute before checking).
 */
const NOW = new Date(2026, 1, 28, 10, 15, 30, 0).getTime(); // local 10:15:30

/** Build a local-time timestamp with seconds and milliseconds zeroed. */
function local(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

// ---------------------------------------------------------------------------
// Invalid expressions
// ---------------------------------------------------------------------------

describe('getNextCronTime — invalid expressions', () => {
  test('throws for too few fields', () => {
    expect(() => getNextCronTime('* *', NOW)).toThrow(
      'Invalid cron expression: expected 5 fields, got 2',
    );
  });

  test('throws for too many fields', () => {
    expect(() => getNextCronTime('* * * * * *', NOW)).toThrow(
      'Invalid cron expression: expected 5 fields, got 6',
    );
  });

  test('throws for a single field', () => {
    expect(() => getNextCronTime('*', NOW)).toThrow('Invalid cron expression');
  });
});

// ---------------------------------------------------------------------------
// Every minute  "* * * * *"
// ---------------------------------------------------------------------------

describe('getNextCronTime — every minute ("* * * * *")', () => {
  test('returns the very next minute boundary', () => {
    // Implementation zeroes seconds/ms then adds 1 minute.
    // From local 10:15:30 the scan starts at 10:16:00.
    // Both fields are wildcard so the first candidate is immediately matched.
    const expected = local(2026, 2, 28, 10, 16);
    expect(getNextCronTime('* * * * *', NOW)).toBe(expected);
  });

  test('result is strictly greater than now', () => {
    expect(getNextCronTime('* * * * *', NOW)).toBeGreaterThan(NOW);
  });
});

// ---------------------------------------------------------------------------
// Specific minute  "30 * * * *"
// ---------------------------------------------------------------------------

describe('getNextCronTime — specific minute ("30 * * * *")', () => {
  test('finds :30 in the current hour when now is at :15', () => {
    // Scan starts at local 10:16 → next local minute=30 hit is 10:30.
    const expected = local(2026, 2, 28, 10, 30);
    expect(getNextCronTime('30 * * * *', NOW)).toBe(expected);
  });

  test('rolls to the next hour when the current :30 has already passed', () => {
    // Local 10:45:00 → scan from 10:46 → next minute=30 hit is 11:30.
    const nowAt45 = new Date(2026, 1, 28, 10, 45, 0, 0).getTime();
    const expected = local(2026, 2, 28, 11, 30);
    expect(getNextCronTime('30 * * * *', nowAt45)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Specific hour and minute  "0 6 * * *"
// ---------------------------------------------------------------------------

describe('getNextCronTime — specific hour and minute ("0 6 * * *")', () => {
  test('returns 06:00 same day when now is before 06:00', () => {
    // Local 05:00:00 → scan from 05:01 → hits 06:00 today.
    const nowAt5 = new Date(2026, 1, 28, 5, 0, 0, 0).getTime();
    const expected = local(2026, 2, 28, 6, 0);
    expect(getNextCronTime('0 6 * * *', nowAt5)).toBe(expected);
  });

  test('returns 06:00 the next day when now is past 06:00', () => {
    // Local 07:00:00 → scan from 07:01 → wraps around to 06:00 next day.
    const nowAt7 = new Date(2026, 1, 28, 7, 0, 0, 0).getTime();
    const expected = local(2026, 3, 1, 6, 0); // 2026-03-01 06:00 local
    expect(getNextCronTime('0 6 * * *', nowAt7)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Interval — every 6 hours  "0 */6 * * *"
// Matching hours: 0, 6, 12, 18  (hour % 6 === 0)
// ---------------------------------------------------------------------------

describe('getNextCronTime — interval every 6 hours ("0 */6 * * *")', () => {
  test('returns 06:00 when now is at local 05:00', () => {
    const nowAt5 = new Date(2026, 1, 28, 5, 0, 0, 0).getTime();
    const expected = local(2026, 2, 28, 6, 0);
    expect(getNextCronTime('0 */6 * * *', nowAt5)).toBe(expected);
  });

  test('returns 12:00 when now is at local 07:00 (past the 06:00 slot)', () => {
    const nowAt7 = new Date(2026, 1, 28, 7, 0, 0, 0).getTime();
    const expected = local(2026, 2, 28, 12, 0);
    expect(getNextCronTime('0 */6 * * *', nowAt7)).toBe(expected);
  });

  test('returns 18:00 when now is at local 13:00', () => {
    const nowAt13 = new Date(2026, 1, 28, 13, 0, 0, 0).getTime();
    const expected = local(2026, 2, 28, 18, 0);
    expect(getNextCronTime('0 */6 * * *', nowAt13)).toBe(expected);
  });

  test('rolls to 00:00 next day when now is at local 19:00', () => {
    const nowAt19 = new Date(2026, 1, 28, 19, 0, 0, 0).getTime();
    const expected = local(2026, 3, 1, 0, 0); // 2026-03-01 00:00 local
    expect(getNextCronTime('0 */6 * * *', nowAt19)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Interval — every 15 minutes  "*/15 * * * *"
// Matching minutes: 0, 15, 30, 45  (minute % 15 === 0)
// ---------------------------------------------------------------------------

describe('getNextCronTime — interval every 15 minutes ("*/15 * * * *")', () => {
  test('returns :30 when now is at :15 (scan starts at :16)', () => {
    // Scan starts at local 10:16 → first minute % 15 === 0 is 10:30.
    const expected = local(2026, 2, 28, 10, 30);
    expect(getNextCronTime('*/15 * * * *', NOW)).toBe(expected);
  });

  test('returns :45 when now is at :30 exactly', () => {
    // Local 10:30:00 → scan starts at 10:31 → next hit is 10:45.
    const nowAt30 = new Date(2026, 1, 28, 10, 30, 0, 0).getTime();
    const expected = local(2026, 2, 28, 10, 45);
    expect(getNextCronTime('*/15 * * * *', nowAt30)).toBe(expected);
  });

  test('rolls to :00 next hour when now is at :46', () => {
    // Local 10:46:00 → scan starts at 10:47 → next minute % 15 === 0 is 11:00.
    const nowAt46 = new Date(2026, 1, 28, 10, 46, 0, 0).getTime();
    const expected = local(2026, 2, 28, 11, 0);
    expect(getNextCronTime('*/15 * * * *', nowAt46)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Comma-separated values  "0,30 * * * *"
// ---------------------------------------------------------------------------

describe('getNextCronTime — comma-separated minute values ("0,30 * * * *")', () => {
  test('returns :30 when now is at :15', () => {
    // Scan from local 10:16 → next match is minute=30, i.e. 10:30.
    const expected = local(2026, 2, 28, 10, 30);
    expect(getNextCronTime('0,30 * * * *', NOW)).toBe(expected);
  });

  test('returns :00 of next hour when now is at :35', () => {
    // Local 10:35:30 → scan from 10:36 → next match is minute=0 at 11:00.
    const nowAt35 = new Date(2026, 1, 28, 10, 35, 30, 0).getTime();
    const expected = local(2026, 2, 28, 11, 0);
    expect(getNextCronTime('0,30 * * * *', nowAt35)).toBe(expected);
  });

  test('rolls over midnight when now is at 23:35 local', () => {
    // Local 23:35:00 → scan from 23:36 → next match is minute=0 at 00:00 next day.
    const nowAt2335 = new Date(2026, 1, 28, 23, 35, 0, 0).getTime();
    const expected = local(2026, 3, 1, 0, 0); // 2026-03-01 00:00 local
    expect(getNextCronTime('0,30 * * * *', nowAt2335)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Result invariants — hold for every expression
// ---------------------------------------------------------------------------

describe('getNextCronTime — result invariants', () => {
  const expressions = [
    '* * * * *',
    '30 * * * *',
    '0 6 * * *',
    '0 */6 * * *',
    '*/15 * * * *',
    '0,30 * * * *',
  ];

  test('result is always strictly greater than now', () => {
    for (const expr of expressions) {
      const result = getNextCronTime(expr, NOW);
      expect(result, `expression "${expr}"`).toBeGreaterThan(NOW);
    }
  });

  test('result is always on a minute boundary (seconds and milliseconds are 0)', () => {
    for (const expr of expressions) {
      const result = getNextCronTime(expr, NOW);
      const d = new Date(result);
      expect(d.getSeconds(), `expression "${expr}" — seconds`).toBe(0);
      expect(d.getMilliseconds(), `expression "${expr}" — milliseconds`).toBe(0);
    }
  });
});
