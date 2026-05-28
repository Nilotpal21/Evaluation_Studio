import { describe, it, expect } from 'vitest';
import { validateNovelCandidate } from '../novel-candidate-validator.js';
import type { NovelCandidate } from '../entity-extractor.service.js';

/**
 * Build a valid NovelCandidate for testing.
 */
function makeCandidate(overrides: Partial<NovelCandidate> = {}): NovelCandidate {
  return {
    name: 'interest_rate',
    definition: 'The annual percentage rate charged on a loan',
    rawValue: '15.5%',
    normalizedValue: 15.5,
    dataType: 'percentage',
    confidence: 0.85,
    productType: 'credit_card',
    ...overrides,
  };
}

describe('validateNovelCandidate', () => {
  const knownIds = new Set<string>();

  it('accepts a valid candidate', () => {
    expect(validateNovelCandidate(makeCandidate(), knownIds)).toBe(true);
  });

  it('rejects a stopword name', () => {
    expect(validateNovelCandidate(makeCandidate({ name: 'name' }), knownIds)).toBe(false);
    expect(validateNovelCandidate(makeCandidate({ name: 'type' }), knownIds)).toBe(false);
  });

  it('rejects a short name (< 4 chars)', () => {
    expect(validateNovelCandidate(makeCandidate({ name: 'apr' }), knownIds)).toBe(false);
  });

  it('rejects missing or short definition', () => {
    expect(validateNovelCandidate(makeCandidate({ definition: '' }), knownIds)).toBe(false);
    expect(validateNovelCandidate(makeCandidate({ definition: 'Too short' }), knownIds)).toBe(
      false,
    );
  });

  it('rejects invalid snake_case (CamelCase)', () => {
    expect(validateNovelCandidate(makeCandidate({ name: 'CamelCase' }), knownIds)).toBe(false);
  });

  it('rejects invalid snake_case (has spaces)', () => {
    expect(validateNovelCandidate(makeCandidate({ name: 'has spaces' }), knownIds)).toBe(false);
  });

  it('rejects low confidence (< 0.5)', () => {
    expect(validateNovelCandidate(makeCandidate({ confidence: 0.3 }), knownIds)).toBe(false);
  });

  it('rejects a known attribute ID', () => {
    const known = new Set(['interest_rate']);
    expect(validateNovelCandidate(makeCandidate(), known)).toBe(false);
  });

  it('rejects an invalid data type', () => {
    expect(validateNovelCandidate(makeCandidate({ dataType: 'array' }), knownIds)).toBe(false);
  });
});
