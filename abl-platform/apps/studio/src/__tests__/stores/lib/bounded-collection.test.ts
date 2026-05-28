import { describe, it, expect } from 'vitest';
import { boundedPush, boundedMapSet } from '../../../lib/bounded-collection';

describe('boundedPush', () => {
  it('appends item when under limit', () => {
    const result = boundedPush([1, 2, 3], 4, 10);
    expect(result).toEqual([1, 2, 3, 4]);
  });

  it('evicts oldest items when at limit', () => {
    const result = boundedPush([1, 2, 3, 4, 5], 6, 5);
    expect(result).toEqual([2, 3, 4, 5, 6]);
  });

  it('handles empty array', () => {
    const result = boundedPush([], 1, 5);
    expect(result).toEqual([1]);
  });

  it('handles limit of 1', () => {
    const result = boundedPush([1], 2, 1);
    expect(result).toEqual([2]);
  });
});

describe('boundedMapSet', () => {
  it('adds entry when under limit', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const result = boundedMapSet(map, 'c', 3, 5);
    expect(result.size).toBe(3);
    expect(result.get('c')).toBe(3);
  });

  it('evicts oldest entry when at limit', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    const result = boundedMapSet(map, 'd', 4, 3);
    expect(result.size).toBe(3);
    expect(result.has('a')).toBe(false);
    expect(result.get('d')).toBe(4);
  });

  it('updates existing key without eviction', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    const result = boundedMapSet(map, 'b', 99, 3);
    expect(result.size).toBe(3);
    expect(result.get('b')).toBe(99);
  });
});
