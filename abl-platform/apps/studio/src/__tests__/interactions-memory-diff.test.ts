/**
 * Memory Diff — computation tests
 *
 * Tests the diff logic that compares context state before/after
 * an interaction to produce add/change/remove/unchanged entries.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect } from 'vitest';
import {
  computeMemoryDiff,
  type MemoryDiffEntry,
} from '../components/observatory/interactions/MemoryDiff';

describe('computeMemoryDiff', () => {
  it('detects added keys', () => {
    const before = { a: 1 };
    const after = { a: 1, b: 2 };

    const result = computeMemoryDiff(before, after);

    expect(result.some((e) => e.type === 'added' && e.key === 'b')).toBe(true);
  });

  it('detects changed keys', () => {
    const before = { count: 0 };
    const after = { count: 1 };

    const result = computeMemoryDiff(before, after);

    const changed = result.find((e) => e.key === 'count');
    expect(changed?.type).toBe('changed');
    expect(changed?.oldValue).toBe('0');
    expect(changed?.value).toBe('1');
  });

  it('detects removed keys', () => {
    const before = { a: 1, b: 2 };
    const after = { a: 1 };

    const result = computeMemoryDiff(before, after);

    expect(result.some((e) => e.type === 'removed' && e.key === 'b')).toBe(true);
  });

  it('marks unchanged keys', () => {
    const before = { a: 1 };
    const after = { a: 1 };

    const result = computeMemoryDiff(before, after);

    expect(result.some((e) => e.type === 'unchanged' && e.key === 'a')).toBe(true);
  });

  it('handles empty states', () => {
    expect(computeMemoryDiff({}, {})).toHaveLength(0);
    expect(computeMemoryDiff({}, { a: 1 })).toHaveLength(1);
    expect(computeMemoryDiff({ a: 1 }, {})).toHaveLength(1);
  });

  it('computes stats correctly', () => {
    const before = { a: 1, b: 2, c: 3 };
    const after = { a: 1, b: 5, d: 4 };

    const result = computeMemoryDiff(before, after);

    const added = result.filter((e) => e.type === 'added').length;
    const changed = result.filter((e) => e.type === 'changed').length;
    const removed = result.filter((e) => e.type === 'removed').length;
    const unchanged = result.filter((e) => e.type === 'unchanged').length;

    expect(added).toBe(1); // d
    expect(changed).toBe(1); // b: 2→5
    expect(removed).toBe(1); // c
    expect(unchanged).toBe(1); // a
  });

  it('handles nested objects via JSON comparison', () => {
    const before = { config: { mode: 'fast' } };
    const after = { config: { mode: 'slow' } };

    const result = computeMemoryDiff(before, after);

    const changed = result.find((e) => e.key === 'config');
    expect(changed?.type).toBe('changed');
  });
});
