import { describe, it, expect } from 'vitest';
import { extractDatesFromText } from '../../platform/utils/date-extraction.js';

describe('extractDatesFromText', () => {
  describe('relative dates (English)', () => {
    it('extracts "today"', () => {
      const result = extractDatesFromText('I want to check in today', 'en');
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('date');
      expect(result[0].value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('extracts "tomorrow"', () => {
      const result = extractDatesFromText('arriving tomorrow', 'en');
      expect(result).toHaveLength(1);
    });

    it('extracts "next Monday"', () => {
      const result = extractDatesFromText('next Monday please', 'en');
      expect(result).toHaveLength(1);
    });

    it('extracts "in 3 days"', () => {
      const result = extractDatesFromText('in 3 days', 'en');
      expect(result).toHaveLength(1);
    });
  });

  describe('absolute dates', () => {
    it('extracts "March 15, 2026"', () => {
      const result = extractDatesFromText('on March 15, 2026', 'en');
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe('2026-03-15');
    });

    it('extracts "15/03/2026" with locale', () => {
      const result = extractDatesFromText('on 15/03/2026', 'en-GB');
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe('2026-03-15');
    });

    it('extracts ISO format "2026-03-15"', () => {
      const result = extractDatesFromText('date is 2026-03-15', 'en');
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe('2026-03-15');
    });
  });

  describe('date ranges', () => {
    it('extracts "March 6 to March 10"', () => {
      const result = extractDatesFromText('from March 6 to March 10', 'en');
      expect(result).toHaveLength(2);
    });

    it('extracts "next Monday through Friday"', () => {
      const result = extractDatesFromText('next Monday through Friday', 'en');
      expect(result).toHaveLength(2);
    });
  });

  describe('multilingual', () => {
    it('extracts Spanish date "15 de marzo"', () => {
      const result = extractDatesFromText('el 15 de marzo de 2026', 'es');
      expect(result).toHaveLength(1);
    });

    it('extracts French date "15 mars"', () => {
      const result = extractDatesFromText('le 15 mars 2026', 'fr');
      expect(result).toHaveLength(1);
    });

    it('extracts German date "15. Marz"', () => {
      const result = extractDatesFromText('am 15. März 2026', 'de');
      expect(result).toHaveLength(1);
    });
  });

  describe('edge cases', () => {
    it('returns empty array for no dates', () => {
      const result = extractDatesFromText('hello world', 'en');
      expect(result).toEqual([]);
    });

    it('returns empty array for empty string', () => {
      const result = extractDatesFromText('', 'en');
      expect(result).toEqual([]);
    });

    it('defaults to English when locale not supported', () => {
      const result = extractDatesFromText('tomorrow', 'zz');
      expect(result).toHaveLength(1);
    });
  });
});
