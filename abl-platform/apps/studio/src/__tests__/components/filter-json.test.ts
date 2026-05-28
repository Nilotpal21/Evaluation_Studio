import { describe, it, expect } from 'vitest';
import { filterJson } from '../../components/ui/JsonViewer';

describe('filterJson', () => {
  it('returns original data with matched=true when query is empty', () => {
    const data = { a: 1 };
    const { result, matched } = filterJson(data, '');
    expect(result).toBe(data);
    expect(matched).toBe(true);
  });

  it('matches a primitive string value', () => {
    const { result, matched } = filterJson('hello world', 'hello');
    expect(matched).toBe(true);
    expect(result).toBe('hello world');
  });

  it('returns matched=false when primitive does not match', () => {
    const { matched } = filterJson('hello', 'xyz');
    expect(matched).toBe(false);
  });

  it('matches by object key', () => {
    const data = { username: 'alice', age: 30 };
    const { result, matched } = filterJson(data, 'username');
    expect(matched).toBe(true);
    expect((result as Record<string, unknown>).username).toBe('alice');
    expect((result as Record<string, unknown>).age).toBeUndefined();
  });

  it('matches by object value', () => {
    const data = { name: 'alice', city: 'berlin' };
    const { result, matched } = filterJson(data, 'berlin');
    expect(matched).toBe(true);
    expect((result as Record<string, unknown>).city).toBe('berlin');
    expect((result as Record<string, unknown>).name).toBeUndefined();
  });

  it('keeps entire subtree when key matches', () => {
    const data = { nested: { deep: 'value' }, other: 'x' };
    const { result } = filterJson(data, 'nested');
    expect((result as Record<string, unknown>).nested).toEqual({ deep: 'value' });
  });

  it('filters array items, keeping only matching ones', () => {
    const data = ['apple', 'banana', 'apricot'];
    const { result, matched } = filterJson(data, 'ap');
    expect(matched).toBe(true);
    expect(result).toEqual(['apple', 'apricot']);
  });

  it('returns empty array and matched=false when no array items match', () => {
    const data = ['foo', 'bar'];
    const { result, matched } = filterJson(data, 'xyz');
    expect(matched).toBe(false);
    expect(result).toEqual([]);
  });

  it('is case-insensitive', () => {
    const data = { Name: 'Alice' };
    const { matched } = filterJson(data, 'alice');
    expect(matched).toBe(true);
  });

  it('handles null and undefined without throwing', () => {
    expect(filterJson(null, 'x')).toEqual({ result: null, matched: false });
    expect(filterJson(undefined, 'x')).toEqual({ result: undefined, matched: false });
  });

  it('handles deeply nested matches', () => {
    const data = { a: { b: { c: 'target' } } };
    const { matched, result } = filterJson(data, 'target');
    expect(matched).toBe(true);
    expect((result as Record<string, unknown>).a).toBeDefined();
  });

  it('returns matched=false and empty object when nothing matches', () => {
    const data = { foo: 'bar', baz: 42 };
    const { result, matched } = filterJson(data, 'xyz');
    expect(matched).toBe(false);
    expect(result).toEqual({});
  });

  it('does not blow the stack on pathologically deep input', () => {
    let deep: Record<string, unknown> = { leaf: 'target' };
    for (let i = 0; i < 500; i++) {
      deep = { wrap: deep };
    }
    expect(() => filterJson(deep, 'target')).not.toThrow();
  });
});
