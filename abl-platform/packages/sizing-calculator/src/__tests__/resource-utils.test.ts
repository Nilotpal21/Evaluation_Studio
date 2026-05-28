import { describe, it, expect } from 'vitest';
import {
  roundUpCpu,
  roundUpMemoryGi,
  parseMemoryGi,
  inferNodePool,
} from '../engine/resource-utils.js';

describe('roundUpCpu', () => {
  it('rounds 1.82 up to 2.0', () => expect(roundUpCpu(1.82)).toBe(2.0));
  it('rounds 2.09 up to 2.25', () => expect(roundUpCpu(2.09)).toBe(2.25));
  it('keeps exact quarter values', () => expect(roundUpCpu(1.5)).toBe(1.5));
  it('handles zero', () => expect(roundUpCpu(0)).toBe(0));
});

describe('roundUpMemoryGi', () => {
  it('rounds 3.68 up to 3.75', () => expect(roundUpMemoryGi(3.68)).toBe(3.75));
  it('rounds 2.1 up to 2.25', () => expect(roundUpMemoryGi(2.1)).toBe(2.25));
  it('keeps exact quarter values', () => expect(roundUpMemoryGi(4.0)).toBe(4.0));
});

describe('parseMemoryGi', () => {
  it('parses "3.2Gi" to 3.2', () => expect(parseMemoryGi('3.2Gi')).toBe(3.2));
  it('parses "1.6G" to 1.6', () => expect(parseMemoryGi('1.6G')).toBe(1.6));
  it('parses "512Mi" to ~0.5', () => expect(parseMemoryGi('512Mi')).toBeCloseTo(0.5, 2));
  it('returns null for null input', () => expect(parseMemoryGi(null)).toBeNull());
  it('returns null for empty string', () => expect(parseMemoryGi('')).toBeNull());
  it('returns null for invalid format', () => expect(parseMemoryGi('invalid')).toBeNull());
});

describe('inferNodePool', () => {
  it('returns "data" for mongodb', () => expect(inferNodePool('mongodb', 2)).toBe('data'));
  it('returns "data" for redis', () => expect(inferNodePool('redis', 1)).toBe('data'));
  it('returns "gpu" for self-hosted-llm', () =>
    expect(inferNodePool('self-hosted-llm', 4)).toBe('gpu'));
  it('returns "compute" for high-CPU service', () =>
    expect(inferNodePool('runtime', 4)).toBe('compute'));
  it('returns "general" for low-CPU service', () =>
    expect(inferNodePool('studio', 1)).toBe('general'));
});
