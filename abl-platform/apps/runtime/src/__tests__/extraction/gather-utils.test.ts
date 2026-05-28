import { describe, it, expect } from 'vitest';
import { shouldSkipExtraction } from '../../services/execution/gather-utils';

describe('shouldSkipExtraction', () => {
  it('skips single-word greetings', () => {
    expect(shouldSkipExtraction('Hi')).toBe(true);
    expect(shouldSkipExtraction('Hello')).toBe(true);
    expect(shouldSkipExtraction('Hey')).toBe(true);
    expect(shouldSkipExtraction('hey')).toBe(true);
  });

  it('skips short acknowledgments', () => {
    expect(shouldSkipExtraction('ok')).toBe(true);
    expect(shouldSkipExtraction('okay')).toBe(true);
    expect(shouldSkipExtraction('yes')).toBe(true);
    expect(shouldSkipExtraction('no')).toBe(true);
    expect(shouldSkipExtraction('sure')).toBe(true);
    expect(shouldSkipExtraction('thanks')).toBe(true);
    expect(shouldSkipExtraction('thank you')).toBe(true);
  });

  it('skips empty or whitespace-only input', () => {
    expect(shouldSkipExtraction('')).toBe(true);
    expect(shouldSkipExtraction('   ')).toBe(true);
  });

  it('does NOT skip substantive queries', () => {
    expect(shouldSkipExtraction('Show me red sneakers')).toBe(false);
    expect(shouldSkipExtraction('I want Nike shoes under 500')).toBe(false);
    expect(shouldSkipExtraction('What is the return policy?')).toBe(false);
    expect(shouldSkipExtraction('red sneakers for men under 500 AED')).toBe(false);
  });

  it('does NOT skip short but substantive input', () => {
    expect(shouldSkipExtraction('red shoes')).toBe(false);
    expect(shouldSkipExtraction('Nike sneakers')).toBe(false);
    expect(shouldSkipExtraction('return policy')).toBe(false);
  });

  it('does NOT skip greeting + substance', () => {
    expect(shouldSkipExtraction('Hi, show me red sneakers')).toBe(false);
    expect(shouldSkipExtraction('Hello, I want shoes')).toBe(false);
  });
});
