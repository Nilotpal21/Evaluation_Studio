import { describe, it, expect } from 'vitest';
import { safeJsonParse, isRecord } from '../utils/type-guards.js';

// =============================================================================
// safeJsonParse()
// =============================================================================

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
    expect(safeJsonParse('"hello"', '')).toBe('hello');
    expect(safeJsonParse('[1,2,3]', [])).toEqual([1, 2, 3]);
    expect(safeJsonParse('42', 0)).toBe(42);
  });

  it('returns fallback for invalid JSON', () => {
    expect(safeJsonParse('{bad', 'default')).toBe('default');
    expect(safeJsonParse('not json', [])).toEqual([]);
  });

  it('returns fallback for null input', () => {
    expect(safeJsonParse(null, 'fallback')).toBe('fallback');
  });

  it('returns fallback for undefined input', () => {
    expect(safeJsonParse(undefined, { key: 'val' })).toEqual({ key: 'val' });
  });

  it('returns fallback for empty string', () => {
    expect(safeJsonParse('', 99)).toBe(99);
  });
});

// =============================================================================
// isRecord()
// =============================================================================

describe('isRecord', () => {
  it('returns true for plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('returns false for arrays', () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
  });

  it('returns false for null', () => {
    expect(isRecord(null)).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isRecord('string')).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});
