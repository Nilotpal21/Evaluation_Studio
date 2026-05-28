/**
 * Lock tests for Slice 4 [ABLP-411] — REMEMBER trigger dedup.
 *
 * Pure function test: `deepEqualWithCap(a, b, depth)` must
 *   - return true for value-equal primitives, objects, arrays
 *   - return false for clear inequality
 *   - treat `undefined`/`null`/missing as equal to each other (all "unset")
 *   - fall back to "not equal" (safe: force write) when depth budget exceeds cap
 *
 * Bruce feedback 3.1: dedup must use value equality, not reference equality,
 * and must cap recursion depth to avoid OOM on pathological input.
 */

import { describe, test, expect } from 'vitest';
import { deepEqualWithCap } from '../services/execution/memory-dedup.js';

describe('deepEqualWithCap — primitives', () => {
  test('equal primitives return true', () => {
    expect(deepEqualWithCap('foo', 'foo', 8)).toBe(true);
    expect(deepEqualWithCap(42, 42, 8)).toBe(true);
    expect(deepEqualWithCap(true, true, 8)).toBe(true);
  });

  test('unequal primitives return false', () => {
    expect(deepEqualWithCap('foo', 'bar', 8)).toBe(false);
    expect(deepEqualWithCap(1, 2, 8)).toBe(false);
    expect(deepEqualWithCap(true, false, 8)).toBe(false);
  });

  test('null, undefined, and missing are all treated as equal (all "unset")', () => {
    expect(deepEqualWithCap(null, undefined, 8)).toBe(true);
    expect(deepEqualWithCap(undefined, null, 8)).toBe(true);
    expect(deepEqualWithCap(null, null, 8)).toBe(true);
    expect(deepEqualWithCap(undefined, undefined, 8)).toBe(true);
  });

  test('null is not equal to a defined value', () => {
    expect(deepEqualWithCap(null, 'foo', 8)).toBe(false);
    expect(deepEqualWithCap(undefined, 0, 8)).toBe(false);
    expect(deepEqualWithCap(null, false, 8)).toBe(false);
  });
});

describe('deepEqualWithCap — objects', () => {
  test('value-equal objects with different references return true', () => {
    expect(deepEqualWithCap({ a: 1, b: 'x' }, { a: 1, b: 'x' }, 8)).toBe(true);
  });

  test('order-independent object equality', () => {
    expect(deepEqualWithCap({ a: 1, b: 2 }, { b: 2, a: 1 }, 8)).toBe(true);
  });

  test('objects with different key counts are not equal', () => {
    expect(deepEqualWithCap({ a: 1 }, { a: 1, b: 2 }, 8)).toBe(false);
  });

  test('objects with different values are not equal', () => {
    expect(deepEqualWithCap({ a: 1 }, { a: 2 }, 8)).toBe(false);
  });

  test('nested object equality respects depth', () => {
    expect(deepEqualWithCap({ a: { b: { c: 1 } } }, { a: { b: { c: 1 } } }, 8)).toBe(true);
    expect(deepEqualWithCap({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }, 8)).toBe(false);
  });
});

describe('deepEqualWithCap — arrays', () => {
  test('value-equal arrays return true', () => {
    expect(deepEqualWithCap([1, 2, 3], [1, 2, 3], 8)).toBe(true);
    expect(deepEqualWithCap([], [], 8)).toBe(true);
  });

  test('order-sensitive array equality', () => {
    expect(deepEqualWithCap([1, 2, 3], [3, 2, 1], 8)).toBe(false);
  });

  test('arrays of different lengths are not equal', () => {
    expect(deepEqualWithCap([1, 2], [1, 2, 3], 8)).toBe(false);
  });

  test('nested arrays follow depth rules', () => {
    expect(
      deepEqualWithCap(
        [
          [1, 2],
          [3, 4],
        ],
        [
          [1, 2],
          [3, 4],
        ],
        8,
      ),
    ).toBe(true);
  });
});

describe('deepEqualWithCap — depth cap (safety)', () => {
  test('structures exceeding depth cap return false (safe: force write)', () => {
    // Build a 12-deep nested object
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 12; i++) {
      deep = { nested: deep };
    }
    // Exact same structure with exact same values
    let deepTwin: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 12; i++) {
      deepTwin = { nested: deepTwin };
    }
    // With depth cap of 8, comparison aborts before reaching the leaf
    // and returns false (safer default — forces a write)
    expect(deepEqualWithCap(deep, deepTwin, 8)).toBe(false);
  });

  test('structures within depth cap return true when equal', () => {
    let shallow: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 4; i++) {
      shallow = { nested: shallow };
    }
    let shallowTwin: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 4; i++) {
      shallowTwin = { nested: shallowTwin };
    }
    expect(deepEqualWithCap(shallow, shallowTwin, 8)).toBe(true);
  });

  test('depth cap of 1 only compares top-level keys', () => {
    // Same top-level object refs but different nested values should
    // trigger the cap and return false (safer)
    expect(deepEqualWithCap({ nested: { a: 1 } }, { nested: { a: 2 } }, 1)).toBe(false);
  });
});
