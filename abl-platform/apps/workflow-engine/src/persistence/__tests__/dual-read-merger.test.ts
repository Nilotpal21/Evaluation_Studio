/**
 * UT-05 — dual-read-merger pure function (LLD §5.1 exit criterion).
 *
 * Test cases (≥8 per LLD): empty/empty, empty/ch-only, mongo-only/empty,
 * disjoint, full overlap (mongo wins), partial overlap, preserves duplicate
 * keys within a single input, sort order.
 */

import { describe, it, expect } from 'vitest';
import { mergeMongoAndCH } from '../dual-read-merger.js';

interface Row {
  id: string;
  startedAt: string;
  source: 'mongo' | 'ch';
  status?: string;
}

const keyFn = (row: Row): string => row.id;
const sortFn = (row: Row): string => row.startedAt;

describe('mergeMongoAndCH (UT-05)', () => {
  it('empty/empty returns empty', () => {
    expect(mergeMongoAndCH([], [], keyFn, sortFn)).toEqual([]);
  });

  it('empty Mongo / CH-only returns CH rows sorted DESC', () => {
    const ch: Row[] = [
      { id: 'a', startedAt: '2026-04-21T10:00:00Z', source: 'ch' },
      { id: 'b', startedAt: '2026-04-21T11:00:00Z', source: 'ch' },
    ];
    const result = mergeMongoAndCH([], ch, keyFn, sortFn);
    expect(result.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('Mongo-only / empty CH returns Mongo rows sorted DESC', () => {
    const mongo: Row[] = [
      { id: 'a', startedAt: '2026-04-21T10:00:00Z', source: 'mongo' },
      { id: 'b', startedAt: '2026-04-21T12:00:00Z', source: 'mongo' },
    ];
    const result = mergeMongoAndCH(mongo, [], keyFn, sortFn);
    expect(result.map((r) => r.id)).toEqual(['b', 'a']);
    expect(result.every((r) => r.source === 'mongo')).toBe(true);
  });

  it('disjoint sets — every row preserved, sorted DESC', () => {
    const mongo: Row[] = [{ id: 'a', startedAt: '2026-04-21T10:00:00Z', source: 'mongo' }];
    const ch: Row[] = [{ id: 'b', startedAt: '2026-04-21T11:00:00Z', source: 'ch' }];
    const result = mergeMongoAndCH(mongo, ch, keyFn, sortFn);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('b');
    expect(result[1]!.id).toBe('a');
  });

  it('full overlap — Mongo wins for every row', () => {
    const mongo: Row[] = [
      { id: 'a', startedAt: '2026-04-21T10:00:00Z', source: 'mongo', status: 'mongo-status' },
      { id: 'b', startedAt: '2026-04-21T11:00:00Z', source: 'mongo', status: 'mongo-status' },
    ];
    const ch: Row[] = [
      { id: 'a', startedAt: '2026-04-21T10:00:00Z', source: 'ch', status: 'ch-status' },
      { id: 'b', startedAt: '2026-04-21T11:00:00Z', source: 'ch', status: 'ch-status' },
    ];
    const result = mergeMongoAndCH(mongo, ch, keyFn, sortFn);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.source === 'mongo')).toBe(true);
    expect(result.every((r) => r.status === 'mongo-status')).toBe(true);
  });

  it('partial overlap — Mongo wins for overlapping ids, CH-only rows still included', () => {
    const mongo: Row[] = [
      { id: 'a', startedAt: '2026-04-21T10:00:00Z', source: 'mongo' },
      { id: 'b', startedAt: '2026-04-21T11:00:00Z', source: 'mongo' },
    ];
    const ch: Row[] = [
      { id: 'b', startedAt: '2026-04-21T11:00:00Z', source: 'ch' },
      { id: 'c', startedAt: '2026-04-21T12:00:00Z', source: 'ch' },
    ];
    const result = mergeMongoAndCH(mongo, ch, keyFn, sortFn);
    expect(result).toHaveLength(3);
    const byId = Object.fromEntries(result.map((r) => [r.id, r.source]));
    expect(byId).toEqual({ a: 'mongo', b: 'mongo', c: 'ch' });
  });

  it('duplicate keys WITHIN a single input — last-wins for that side, then normal dedup', () => {
    const mongo: Row[] = [
      { id: 'a', startedAt: '2026-04-21T10:00:00Z', source: 'mongo', status: 'first' },
      { id: 'a', startedAt: '2026-04-21T11:00:00Z', source: 'mongo', status: 'second' },
    ];
    const result = mergeMongoAndCH(mongo, [], keyFn, sortFn);
    expect(result).toHaveLength(1);
    // Map.set overwrites the earlier entry, so the later row in the input wins.
    expect(result[0]!.status).toBe('second');
  });

  it('sort is DESC by startedAt — newest first', () => {
    const mongo: Row[] = [
      { id: 'old', startedAt: '2026-04-21T09:00:00Z', source: 'mongo' },
      { id: 'newest', startedAt: '2026-04-21T13:00:00Z', source: 'mongo' },
      { id: 'mid', startedAt: '2026-04-21T11:00:00Z', source: 'mongo' },
    ];
    const result = mergeMongoAndCH(mongo, [], keyFn, sortFn);
    expect(result.map((r) => r.id)).toEqual(['newest', 'mid', 'old']);
  });

  it('numeric sort key works (timestamp milliseconds)', () => {
    const rows: Row[] = [
      { id: 'a', startedAt: '2026-04-21T09:00:00Z', source: 'mongo' },
      { id: 'b', startedAt: '2026-04-21T11:00:00Z', source: 'mongo' },
    ];
    const result = mergeMongoAndCH(rows, [], keyFn, (r) => Date.parse(r.startedAt));
    expect(result.map((r) => r.id)).toEqual(['b', 'a']);
  });
});
