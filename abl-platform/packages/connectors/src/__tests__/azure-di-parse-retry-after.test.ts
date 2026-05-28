/**
 * Unit tests for `parseRetryAfter` (LLD §3 Phase 3 Task 3.6b).
 *
 * Covers RFC 7231 §7.1.3 — both delta-seconds and HTTP-date forms — plus the
 * 30-second cap that bounds the polling loop's max sleep regardless of what
 * Azure returns.
 */

import { describe, expect, it, vi } from 'vitest';
import { parseRetryAfter } from '@abl/piece-azure-document-intelligence/parse-retry-after';

function makeHeaders(value: string | null): { get(name: string): string | null } {
  return {
    get(name: string): string | null {
      if (value === null) return null;
      if (name.toLowerCase() === 'retry-after') return value;
      return null;
    },
  };
}

describe('parseRetryAfter', () => {
  it('parses integer seconds (delta-seconds form)', () => {
    expect(parseRetryAfter(makeHeaders('5'))).toBe(5_000);
    expect(parseRetryAfter(makeHeaders('0'))).toBe(0);
  });

  it('clamps integer seconds at 30s', () => {
    expect(parseRetryAfter(makeHeaders('120'))).toBe(30_000);
    expect(parseRetryAfter(makeHeaders('99999'))).toBe(30_000);
  });

  it('returns defaultMs when header is missing', () => {
    expect(parseRetryAfter(makeHeaders(null))).toBe(2_000);
    expect(parseRetryAfter(makeHeaders(null), 5_500)).toBe(5_500);
  });

  it('returns defaultMs when header is malformed', () => {
    expect(parseRetryAfter(makeHeaders('not a number'), 3_000)).toBe(3_000);
    expect(parseRetryAfter(makeHeaders(''), 1_500)).toBe(1_500);
  });

  it('parses HTTP-date form into a relative ms duration', () => {
    const now = new Date('2027-01-01T00:00:00Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      // 10 seconds in the future
      const future = new Date(now + 10_000).toUTCString();
      expect(parseRetryAfter(makeHeaders(future))).toBe(10_000);
      // past time → 0
      const past = new Date(now - 10_000).toUTCString();
      expect(parseRetryAfter(makeHeaders(past))).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps HTTP-date durations at 30s', () => {
    const now = new Date('2027-01-01T00:00:00Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const farFuture = new Date(now + 5 * 60_000).toUTCString();
      expect(parseRetryAfter(makeHeaders(farFuture))).toBe(30_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
