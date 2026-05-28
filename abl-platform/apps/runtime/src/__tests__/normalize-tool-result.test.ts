import { describe, it, expect } from 'vitest';
import { normalizeToolResult } from '../services/execution/flow-step-executor.js';

describe('normalizeToolResult', () => {
  it('should wrap string result in { result }', () => {
    expect(normalizeToolResult('hello')).toEqual({ result: 'hello' });
  });

  it('should return {} for null', () => {
    expect(normalizeToolResult(null)).toEqual({});
  });

  it('should return {} for undefined', () => {
    expect(normalizeToolResult(undefined)).toEqual({});
  });

  it('should pass through plain objects', () => {
    expect(normalizeToolResult({ data: 'test' })).toEqual({ data: 'test' });
  });

  it('should wrap arrays in { result }', () => {
    expect(normalizeToolResult([1, 2, 3])).toEqual({ result: [1, 2, 3] });
  });

  it('should wrap numbers in { result }', () => {
    expect(normalizeToolResult(42)).toEqual({ result: 42 });
  });

  it('should wrap booleans in { result }', () => {
    expect(normalizeToolResult(true)).toEqual({ result: true });
  });
});
