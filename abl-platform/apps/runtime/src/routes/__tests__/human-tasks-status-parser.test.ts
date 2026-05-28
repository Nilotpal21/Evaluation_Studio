/**
 * UT-04 (test-spec §7) — `?status=` query-param parser + error shape.
 *
 * The parser is a pure function — no mocks, no HTTP, no route wiring.
 * Tests the Zod enum validation contract that the route's GET / endpoint
 * calls:
 *   - Absent → empty list (default behaviour: no status filter applied)
 *   - Single value → 1-element list
 *   - Comma-separated → N-element list, deduped
 *   - Unknown enum value → structured `VALIDATION_ERROR` with allowed-values hint
 *   - Mixed valid/invalid → VALIDATION_ERROR (strict enum)
 *   - Whitespace handling — `'pending ,  assigned '` → trimmed list
 */

import { describe, it, expect } from 'vitest';
import { parseStatusList, HUMAN_TASK_STATUS_VALUES } from '../human-tasks.js';

describe('parseStatusList (UT-04 — query-param status enum parser)', () => {
  it('returns empty list when status is absent', () => {
    const result = parseStatusList(undefined);
    expect('statuses' in result).toBe(true);
    if ('statuses' in result) expect(result.statuses).toEqual([]);
  });

  it('returns empty list when status is empty string', () => {
    const result = parseStatusList('');
    expect('statuses' in result).toBe(true);
    if ('statuses' in result) expect(result.statuses).toEqual([]);
  });

  it('parses a single value', () => {
    const result = parseStatusList('pending');
    expect('statuses' in result).toBe(true);
    if ('statuses' in result) expect(result.statuses).toEqual(['pending']);
  });

  it('parses a comma-separated list — matches feature-spec FR-9 default', () => {
    const result = parseStatusList('pending,assigned,in_progress');
    expect('statuses' in result).toBe(true);
    if ('statuses' in result) {
      expect(result.statuses).toEqual(['pending', 'assigned', 'in_progress']);
    }
  });

  it('trims whitespace around entries', () => {
    const result = parseStatusList(' pending , assigned ');
    expect('statuses' in result).toBe(true);
    if ('statuses' in result) expect(result.statuses).toEqual(['pending', 'assigned']);
  });

  it('dedupes repeated values within a single input', () => {
    const result = parseStatusList('pending,pending,assigned');
    expect('statuses' in result).toBe(true);
    if ('statuses' in result) expect(result.statuses).toEqual(['pending', 'assigned']);
  });

  it('rejects unknown enum values with structured VALIDATION_ERROR', () => {
    const result = parseStatusList('foo');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.message).toContain('Invalid status value(s)');
      // The allowed-values hint must mention every enum value.
      for (const s of HUMAN_TASK_STATUS_VALUES) {
        expect(result.error.message).toContain(s);
      }
    }
  });

  it('rejects mixed valid/invalid — one bad entry fails the whole request', () => {
    const result = parseStatusList('pending,foo,assigned');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('accepts every known enum value individually', () => {
    for (const s of HUMAN_TASK_STATUS_VALUES) {
      const result = parseStatusList(s);
      expect('statuses' in result).toBe(true);
      if ('statuses' in result) expect(result.statuses).toEqual([s]);
    }
  });
});
