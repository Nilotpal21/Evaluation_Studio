import { describe, expect, it } from 'vitest';

import { buildNormalizedExtractionInput } from '../../services/execution/input-normalization.js';

describe('buildNormalizedExtractionInput', () => {
  it('keeps raw text for non-numeric gather fields', () => {
    const result = buildNormalizedExtractionInput('my code is one two three', [
      { name: 'issue_type', type: 'string' },
    ]);

    expect(result.extractionText).toBe('my code is one two three');
    expect(result.variants.spokenNumberDigits).toBeUndefined();
  });

  it('normalizes digit-by-digit spoken numbers for phone-like fields', () => {
    const result = buildNormalizedExtractionInput('call me at five five five one two three four', [
      { name: 'phone', type: 'phone' },
    ]);

    expect(result.extractionText).toBe('call me at 5551234');
    expect(result.variants.spokenNumberDigits).toBe('call me at 5551234');
  });

  it('normalizes cardinal spoken numbers for numeric fields', () => {
    const result = buildNormalizedExtractionInput('we need twenty one seats', [
      { name: 'party_size', type: 'number' },
    ]);

    expect(result.extractionText).toBe('we need 21 seats');
  });

  it('supports repeated digits with double/triple wording', () => {
    const result = buildNormalizedExtractionInput('the code is double five triple zero', [
      { name: 'pin', type: 'integer' },
    ]);

    expect(result.extractionText).toBe('the code is 55000');
  });

  it('treats range validation as numeric-like even without an explicit type', () => {
    const result = buildNormalizedExtractionInput('set the threshold to one hundred', [
      {
        name: 'threshold',
        validation: {
          type: 'range',
          rule: '1-1000',
        },
      },
    ]);

    expect(result.extractionText).toBe('set the threshold to 100');
  });
});
