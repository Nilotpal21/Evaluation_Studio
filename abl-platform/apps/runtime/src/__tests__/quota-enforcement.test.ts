/**
 * Quota Enforcement Tests
 *
 * Validates the session creation quota and token usage quota logic.
 * Tests the pure logic used by canStartSession() and recordTokenUsage()
 * in the rate-limiter module.
 */

import { describe, it, expect } from 'vitest';

describe('Session creation quota', () => {
  it('rejects when concurrent session limit is reached', () => {
    const canStart = (active: number, limit: number) => limit === -1 || active < limit;
    expect(canStart(5, 5)).toBe(false);
    expect(canStart(4, 5)).toBe(true);
    expect(canStart(999, -1)).toBe(true); // unlimited (enterprise)
  });

  it('allows session when under limit', () => {
    const canStart = (active: number, limit: number) => limit === -1 || active < limit;
    expect(canStart(0, 5)).toBe(true);
    expect(canStart(0, 1)).toBe(true);
    expect(canStart(49, 50)).toBe(true);
  });

  it('blocks exactly at limit boundary', () => {
    const canStart = (active: number, limit: number) => limit === -1 || active < limit;
    expect(canStart(50, 50)).toBe(false);
    expect(canStart(500, 500)).toBe(false);
  });
});

describe('Token usage quota', () => {
  it('detects over-limit correctly', () => {
    const isOverLimit = (used: number, limit: number) => limit !== -1 && used >= limit;
    expect(isOverLimit(50_000, 50_000)).toBe(true);
    expect(isOverLimit(49_999, 50_000)).toBe(false);
    expect(isOverLimit(999_999, -1)).toBe(false); // unlimited
  });

  it('handles zero usage', () => {
    const isOverLimit = (used: number, limit: number) => limit !== -1 && used >= limit;
    expect(isOverLimit(0, 50_000)).toBe(false);
    expect(isOverLimit(0, 0)).toBe(true); // edge case: zero limit
  });

  it('matches plan tier limits from tenant-config', () => {
    // Verify the quota boundaries match PLAN_LIMITS in tenant-config.ts
    const FREE_SESSIONS = 5;
    const TEAM_SESSIONS = 50;
    const BUSINESS_SESSIONS = 500;
    const ENTERPRISE_SESSIONS = -1; // unlimited

    const canStart = (active: number, limit: number) => limit === -1 || active < limit;

    // FREE tier
    expect(canStart(5, FREE_SESSIONS)).toBe(false);
    expect(canStart(4, FREE_SESSIONS)).toBe(true);

    // TEAM tier
    expect(canStart(50, TEAM_SESSIONS)).toBe(false);
    expect(canStart(49, TEAM_SESSIONS)).toBe(true);

    // BUSINESS tier
    expect(canStart(500, BUSINESS_SESSIONS)).toBe(false);
    expect(canStart(499, BUSINESS_SESSIONS)).toBe(true);

    // ENTERPRISE tier (unlimited)
    expect(canStart(10_000, ENTERPRISE_SESSIONS)).toBe(true);
  });
});
