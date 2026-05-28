import { describe, it, expect } from 'vitest';
import { isRTL, getDirection, getTextAlign } from '../rtl.js';

describe('isRTL', () => {
  it.each(['ar', 'he', 'fa', 'ur'])('returns true for %s', (locale) => {
    expect(isRTL(locale)).toBe(true);
  });

  it.each(['en', 'de', 'fr', 'ja', 'zh'])('returns false for %s', (locale) => {
    expect(isRTL(locale)).toBe(false);
  });

  it('handles regional variants (ar-EG → true)', () => {
    expect(isRTL('ar-EG')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isRTL('AR')).toBe(true);
  });
});

describe('getDirection', () => {
  it('returns rtl for Arabic', () => {
    expect(getDirection('ar')).toBe('rtl');
  });

  it('returns ltr for English', () => {
    expect(getDirection('en')).toBe('ltr');
  });
});

describe('getTextAlign', () => {
  it('returns right for Arabic', () => {
    expect(getTextAlign('ar')).toBe('right');
  });

  it('returns left for English', () => {
    expect(getTextAlign('en')).toBe('left');
  });
});
