import { describe, it, expect, beforeEach } from 'vitest';
import { computeConfigHash, clearConfigHashCache } from '../../sti/config-hash.js';

describe('computeConfigHash', () => {
  beforeEach(() => {
    clearConfigHashCache();
  });

  it('returns a 64-char hex string (SHA-256)', () => {
    const hash = computeConfigHash({ name: 'test-agent' });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces the same hash for identical input', () => {
    const a = computeConfigHash({ name: 'agent', version: 1 });
    const b = computeConfigHash({ name: 'agent', version: 1 });
    expect(a).toBe(b);
  });

  it('produces the same hash regardless of key order', () => {
    const a = computeConfigHash({ z: 1, a: 2, m: 3 });
    const b = computeConfigHash({ a: 2, m: 3, z: 1 });
    expect(a).toBe(b);
  });

  it('produces different hashes for different input', () => {
    const a = computeConfigHash({ name: 'agent-a' });
    const b = computeConfigHash({ name: 'agent-b' });
    expect(a).not.toBe(b);
  });

  it('includes tenantConfig in hash when provided', () => {
    const dsl = { name: 'agent' };
    const a = computeConfigHash(dsl);
    const b = computeConfigHash(dsl, { region: 'us-east-1' });
    expect(a).not.toBe(b);
  });

  it('handles deeply nested objects deterministically', () => {
    const a = computeConfigHash({ tools: { b: { c: 1 }, a: { d: 2 } } });
    const b = computeConfigHash({ tools: { a: { d: 2 }, b: { c: 1 } } });
    expect(a).toBe(b);
  });

  it('handles arrays preserving order', () => {
    const a = computeConfigHash({ steps: [1, 2, 3] });
    const b = computeConfigHash({ steps: [3, 2, 1] });
    expect(a).not.toBe(b);
  });

  it('returns cached result on second call', () => {
    const dsl = { name: 'cached-agent' };
    const first = computeConfigHash(dsl);
    const second = computeConfigHash(dsl);
    expect(first).toBe(second);
  });
});
