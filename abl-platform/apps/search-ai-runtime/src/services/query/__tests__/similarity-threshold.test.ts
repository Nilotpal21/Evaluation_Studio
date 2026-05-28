import { describe, it, expect } from 'vitest';
import { resolveSimilarityThreshold } from '../similarity-threshold.js';

describe('resolveSimilarityThreshold', () => {
  const indexWith = (similarityThreshold: unknown) => ({
    searchDefaults: { similarityThreshold },
  });

  describe('explicit per-request value', () => {
    it('uses a valid explicit request value over the index default', () => {
      expect(resolveSimilarityThreshold(0.8, indexWith(0.2))).toBe(0.8);
    });

    it('honours an explicit 0 (disable filtering) over the index default', () => {
      expect(resolveSimilarityThreshold(0, indexWith(0.5))).toBe(0);
    });

    it('accepts the boundary value 1', () => {
      expect(resolveSimilarityThreshold(1, undefined)).toBe(1);
    });

    it('ignores an out-of-range request value and falls back to the index default', () => {
      expect(resolveSimilarityThreshold(1.5, indexWith(0.3))).toBe(0.3);
      expect(resolveSimilarityThreshold(-0.1, indexWith(0.3))).toBe(0.3);
    });

    it('ignores a non-numeric request value and falls back to the index default', () => {
      expect(resolveSimilarityThreshold('0.4', indexWith(0.3))).toBe(0.3);
      expect(resolveSimilarityThreshold(NaN, indexWith(0.3))).toBe(0.3);
    });
  });

  describe('index default fallback', () => {
    it('applies searchDefaults.similarityThreshold when the request omits it', () => {
      expect(resolveSimilarityThreshold(undefined, indexWith(0.9))).toBe(0.9);
    });

    it('returns undefined when the index default is 0 (no floor configured)', () => {
      expect(resolveSimilarityThreshold(undefined, indexWith(0))).toBeUndefined();
    });

    it('returns undefined when the index default is out of range', () => {
      expect(resolveSimilarityThreshold(undefined, indexWith(2))).toBeUndefined();
      expect(resolveSimilarityThreshold(undefined, indexWith(-1))).toBeUndefined();
    });

    it('returns undefined when the index has no searchDefaults', () => {
      expect(resolveSimilarityThreshold(undefined, {})).toBeUndefined();
      expect(resolveSimilarityThreshold(undefined, undefined)).toBeUndefined();
    });

    it('returns undefined when searchDefaults.similarityThreshold is non-numeric', () => {
      expect(resolveSimilarityThreshold(undefined, indexWith('0.5'))).toBeUndefined();
    });
  });
});
