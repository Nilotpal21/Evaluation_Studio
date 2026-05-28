import { describe, it, expect } from 'vitest';
import { resolveLocale, parseAcceptLanguage } from '../resolve-locale.js';

describe('resolveLocale', () => {
  it('returns exact match', () => {
    expect(resolveLocale(['ar'], ['ar', 'en', 'de'], 'en')).toBe('ar');
  });

  it('returns prefix match (ar-EG → ar)', () => {
    expect(resolveLocale(['ar-EG'], ['ar', 'en', 'de'], 'en')).toBe('ar');
  });

  it('returns first match in priority order', () => {
    expect(resolveLocale(['ja', 'de'], ['ar', 'en', 'de'], 'en')).toBe('de');
  });

  it('returns fallback when no match', () => {
    expect(resolveLocale(['ja'], ['en', 'de'], 'en')).toBe('en');
  });

  it('handles empty requested list', () => {
    expect(resolveLocale([], ['en', 'de'], 'en')).toBe('en');
  });

  it('is case-insensitive', () => {
    expect(resolveLocale(['AR-EG'], ['ar', 'en'], 'en')).toBe('ar');
  });

  it('handles pt-BR → pt fallback', () => {
    expect(resolveLocale(['pt-BR'], ['pt', 'en'], 'en')).toBe('pt');
  });

  it('resolves runtime locale precedence from channel/session candidates before fallback', () => {
    const requested = parseAcceptLanguage('fr-CA;q=0.9,en-US;q=0.8');
    expect(resolveLocale(requested, ['en', 'fr'], 'en')).toBe('fr');
  });

  it('falls back deterministically when session and channel locales are unsupported', () => {
    expect(resolveLocale(['ja-JP', 'it-IT'], ['en', 'fr'], 'en')).toBe('en');
  });
});

describe('parseAcceptLanguage', () => {
  it('parses simple header', () => {
    expect(parseAcceptLanguage('en-US,en;q=0.9,ar;q=0.8')).toEqual(['en-US', 'en', 'ar']);
  });

  it('sorts by quality descending', () => {
    expect(parseAcceptLanguage('ar;q=0.5,en;q=0.9,de;q=0.7')).toEqual(['en', 'de', 'ar']);
  });

  it('defaults quality to 1.0', () => {
    expect(parseAcceptLanguage('en,ar;q=0.5')).toEqual(['en', 'ar']);
  });

  it('returns empty array for empty string', () => {
    expect(parseAcceptLanguage('')).toEqual([]);
  });

  it('excludes q=0 entries', () => {
    expect(parseAcceptLanguage('en,ar;q=0')).toEqual(['en']);
  });

  it('preserves BCP-47 variants while sorting weighted channel header preferences', () => {
    expect(parseAcceptLanguage('en-US;q=0.5,fr-CA;q=0.9,fr;q=0.7')).toEqual([
      'fr-CA',
      'fr',
      'en-US',
    ]);
  });
});
