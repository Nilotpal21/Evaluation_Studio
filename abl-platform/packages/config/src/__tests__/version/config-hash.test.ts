import { describe, it, expect } from 'vitest';
import { computeConfigHash } from '../../version/config-hash.js';

describe('computeConfigHash', () => {
  it('produces deterministic output for the same config', () => {
    const config = { server: { port: 3000 }, feature: true };
    const hash1 = computeConfigHash(config);
    const hash2 = computeConfigHash(config);
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different configs', () => {
    const hash1 = computeConfigHash({ server: { port: 3000 } });
    const hash2 = computeConfigHash({ server: { port: 4000 } });
    expect(hash1).not.toBe(hash2);
  });

  it('excludes sensitive fields — changing jwt.secret does not change hash', () => {
    const base = { server: { port: 3000 }, jwt: { secret: 'secret-a', issuer: 'abl' } };
    const modified = { server: { port: 3000 }, jwt: { secret: 'secret-b', issuer: 'abl' } };
    expect(computeConfigHash(base)).toBe(computeConfigHash(modified));
  });

  it('produces the same hash regardless of key ordering', () => {
    const obj1 = { a: 1, b: 2 };
    const obj2 = { b: 2, a: 1 };
    expect(computeConfigHash(obj1)).toBe(computeConfigHash(obj2));
  });

  it('handles nested objects correctly', () => {
    const config = { level1: { level2: { level3: 'value' } } };
    const hash = computeConfigHash(config);
    expect(hash).toBeTruthy();
    expect(typeof hash).toBe('string');
    expect(hash).toHaveLength(64); // SHA-256 hex
  });

  it('handles arrays correctly', () => {
    const config1 = { items: [1, 2, 3] };
    const config2 = { items: [1, 2, 3] };
    const config3 = { items: [3, 2, 1] };
    expect(computeConfigHash(config1)).toBe(computeConfigHash(config2));
    expect(computeConfigHash(config1)).not.toBe(computeConfigHash(config3));
  });

  it('handles null and undefined values', () => {
    const withNull = { a: null, b: 'test' };
    const withUndefined = { a: undefined, b: 'test' };
    // Both should produce valid hashes
    expect(computeConfigHash(withNull)).toBeTruthy();
    expect(computeConfigHash(withUndefined)).toBeTruthy();
    // null and undefined should produce different hashes
    expect(computeConfigHash(withNull)).not.toBe(computeConfigHash(withUndefined));
  });
});
