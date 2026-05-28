/**
 * Lock test for Slice 4 [ABLP-411] — pure helper `filterUnchangedOperations`.
 *
 * The dedup compute step is extracted as a pure function so it is testable
 * without any FactStore, session, or async plumbing:
 *
 *   filterUnchangedOperations(operations, currentValues, depthCap)
 *     → { toWrite: Operation[], skipped: Operation[] }
 *
 * Operations with values value-equal to currentValues[op.key] end up in
 * `skipped`; everything else lands in `toWrite`. Missing entries in
 * `currentValues` (no prior value stored) always write.
 */

import { describe, test, expect } from 'vitest';
import { filterUnchangedOperations } from '../services/execution/memory-dedup.js';

describe('filterUnchangedOperations', () => {
  test('all operations with matching current values are skipped', () => {
    const ops = [
      { key: 'user.pref', value: 'dark' },
      { key: 'user.lang', value: 'en' },
    ];
    const current = new Map<string, unknown>([
      ['user.pref', 'dark'],
      ['user.lang', 'en'],
    ]);

    const result = filterUnchangedOperations(ops, current, 8);
    expect(result.toWrite).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.map((o) => o.key).sort()).toEqual(['user.lang', 'user.pref']);
  });

  test('operations with no prior value always write', () => {
    const ops = [{ key: 'user.new', value: 'fresh' }];
    const current = new Map<string, unknown>();
    const result = filterUnchangedOperations(ops, current, 8);
    expect(result.toWrite).toEqual([{ key: 'user.new', value: 'fresh' }]);
    expect(result.skipped).toHaveLength(0);
  });

  test('operations with changed values route to toWrite', () => {
    const ops = [
      { key: 'user.pref', value: 'light' },
      { key: 'user.lang', value: 'en' },
    ];
    const current = new Map<string, unknown>([
      ['user.pref', 'dark'],
      ['user.lang', 'en'],
    ]);
    const result = filterUnchangedOperations(ops, current, 8);
    expect(result.toWrite.map((o) => o.key)).toEqual(['user.pref']);
    expect(result.skipped.map((o) => o.key)).toEqual(['user.lang']);
  });

  test('deep-equal objects are skipped (value equality, not reference)', () => {
    const ops = [{ key: 'user.profile', value: { name: 'Alice', age: 30 } }];
    const current = new Map<string, unknown>([['user.profile', { name: 'Alice', age: 30 }]]);
    const result = filterUnchangedOperations(ops, current, 8);
    expect(result.skipped).toHaveLength(1);
    expect(result.toWrite).toHaveLength(0);
  });

  test('depth cap forces write on pathologically deep structures', () => {
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    let deepTwin: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 12; i++) deepTwin = { nested: deepTwin };

    const ops = [{ key: 'user.deep', value: deep }];
    const current = new Map<string, unknown>([['user.deep', deepTwin]]);

    // With cap of 8, comparison aborts; operation routes to toWrite (safe).
    const result = filterUnchangedOperations(ops, current, 8);
    expect(result.toWrite).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  test('zero-length input returns empty buckets', () => {
    const result = filterUnchangedOperations([], new Map(), 8);
    expect(result.toWrite).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });
});
