/**
 * Unit tests for the engine semver descending comparator.
 *
 * Both workflow-engine and runtime re-export `compareSemverDesc` from
 * `@agent-platform/shared-kernel`; this test suite exercises the engine's
 * import path, with a parallel suite at
 * `apps/runtime/src/__tests__/semver-compare.test.ts` exercising runtime's.
 */

import { describe, it, expect } from 'vitest';
import { compareSemverDesc } from '../lib/semver-compare.js';

describe('compareSemverDesc (engine)', () => {
  it('v0.10.0 sorts before v0.9.0 (numeric semver, not lexicographic)', () => {
    // Descending: v0.10.0 > v0.9.0, so compareSemverDesc(v0.10.0, v0.9.0) < 0
    expect(compareSemverDesc('v0.10.0', 'v0.9.0')).toBeLessThan(0);
  });

  it('v1.0.0 sorts before v0.99.99', () => {
    expect(compareSemverDesc('v1.0.0', 'v0.99.99')).toBeLessThan(0);
  });

  it('draft sorts LAST — even vs v0.0.1', () => {
    // draft vs v0.0.1: draft should come after → compareSemverDesc('draft', 'v0.0.1') > 0
    expect(compareSemverDesc('draft', 'v0.0.1')).toBeGreaterThan(0);
    // v0.0.1 vs draft: v0.0.1 should come first → compareSemverDesc('v0.0.1', 'draft') < 0
    expect(compareSemverDesc('v0.0.1', 'draft')).toBeLessThan(0);
  });

  it('draft vs draft returns 0', () => {
    expect(compareSemverDesc('draft', 'draft')).toBe(0);
  });

  it('handles leading-v prefix correctly (v0.2.0 and 0.2.0 parse identically)', () => {
    // Both forms should compare equally
    expect(compareSemverDesc('v0.2.0', '0.2.0')).toBe(0);
    // And v-prefixed versions sort correctly against each other
    expect(compareSemverDesc('v0.10.0', 'v0.2.0')).toBeLessThan(0);
  });

  it('mixed array sorts to semver descending with draft last', () => {
    const versions = ['v0.1.0', 'v0.10.0', 'draft', 'v0.9.0'];
    versions.sort(compareSemverDesc);
    expect(versions).toEqual(['v0.10.0', 'v0.9.0', 'v0.1.0', 'draft']);
  });

  // GAP-006 regression: invalid input must not throw TypeError
  it('invalid semver strings do not throw (GAP-006)', () => {
    expect(() => compareSemverDesc('vNotSemver', 'v0.1.0')).not.toThrow();
    expect(() => compareSemverDesc('v1.2.3.4', 'v0.1.0')).not.toThrow();
    expect(() => compareSemverDesc('latest', 'stable')).not.toThrow();
  });

  it('valid semvers sort before invalid strings, which sort before draft', () => {
    const versions = ['vNotSemver', 'v0.10.0', 'draft', 'v1.2.3.4', 'v0.9.0'];
    versions.sort(compareSemverDesc);
    expect(versions[0]).toBe('v0.10.0');
    expect(versions[1]).toBe('v0.9.0');
    expect(versions[versions.length - 1]).toBe('draft');
    expect(versions.slice(2, 4).sort()).toEqual(['v1.2.3.4', 'vNotSemver']);
  });
});
