import { describe, it, expect } from 'vitest';
import { generateFewShotExamples } from '../few-shot-generator.js';

describe('generateFewShotExamples', () => {
  it('generates aliases from cluster member names excluding canonical', () => {
    const result = generateFewShotExamples('interest_rate', [
      { name: 'interest_rate', definition: 'The rate of interest' },
      { name: 'apr', definition: 'Annual percentage rate' },
      { name: 'annual_rate', definition: 'Yearly interest rate' },
    ]);
    expect(result.aliases).toEqual(['apr', 'annual_rate']);
    expect(result.aliases).not.toContain('interest_rate');
  });

  it('generates regex patterns matching all name variants', () => {
    const result = generateFewShotExamples('contactless_payment', [
      { name: 'contactless_payment', definition: 'Payment without contact' },
      { name: 'tap_to_pay', definition: 'Tap payment method' },
    ]);
    // Pattern should contain word-boundary group matching variants
    const pattern = result.extractionPatterns[0];
    expect(pattern).toContain('contactless_payment');
    expect(pattern).toContain('contactless payment');
    expect(pattern).toContain('contactless-payment');
    expect(pattern).toContain('contactlesspayment');
    expect(pattern).toContain('tap_to_pay');
    expect(pattern).toContain('tap to pay');
  });

  it('generates empty aliases for single-member cluster', () => {
    const result = generateFewShotExamples('loan_amount', [
      { name: 'loan_amount', definition: 'The amount of the loan' },
    ]);
    expect(result.aliases).toEqual([]);
    // Pattern should still exist for canonical name variants
    expect(result.extractionPatterns.length).toBe(1);
  });

  it('escapes special characters in names for regex patterns', () => {
    // Names with regex-special chars (e.g., parentheses from user input)
    const result = generateFewShotExamples('test_attr', [
      { name: 'test_attr', definition: 'A test attribute' },
      { name: 'price_(usd)', definition: 'Price in USD with parens' },
    ]);
    const pattern = result.extractionPatterns[0];
    // Parentheses should be escaped in the pattern
    expect(pattern).toContain('price_\\(usd\\)');
  });
});
