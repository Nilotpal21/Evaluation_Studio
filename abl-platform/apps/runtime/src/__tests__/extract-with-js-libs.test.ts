/**
 * Tests for Tier 1 JS extraction (extractWithJSLibs).
 *
 * Validates that chrono-node handles date/datetime fields and
 * libphonenumber-js handles phone fields, with correct fallback
 * behavior for unsupported types and edge cases.
 */
import { describe, it, expect } from 'vitest';
import { extractWithJSLibs, isJSExtractableType } from '../services/execution/js-extraction.js';

describe('extractWithJSLibs', () => {
  // -----------------------------------------------------------------------
  // Date extraction via chrono-node
  // -----------------------------------------------------------------------

  it('extracts date field from relative date text', () => {
    const result = extractWithJSLibs(
      'arriving tomorrow',
      [{ name: 'checkin', type: 'date' }],
      'en',
    );
    // Should produce an ISO date string (YYYY-MM-DD)
    expect(result.checkin).toBeDefined();
    expect(result.checkin).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('extracts date field from absolute date text', () => {
    const result = extractWithJSLibs(
      'arriving on March 15, 2026',
      [{ name: 'checkin', type: 'date' }],
      'en',
    );
    expect(result.checkin).toBe('2026-03-15');
  });

  it('handles datetime type same as date', () => {
    const result = extractWithJSLibs('tomorrow', [{ name: 'when', type: 'datetime' }], 'en');
    expect(result.when).toBeDefined();
    expect(result.when).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('extracts date with non-English locale', () => {
    const result = extractWithJSLibs('llegando mañana', [{ name: 'fecha', type: 'date' }], 'es');
    // chrono-node Spanish parser should handle "mañana" (tomorrow)
    expect(result.fecha).toBeDefined();
    expect(result.fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // -----------------------------------------------------------------------
  // Phone extraction via libphonenumber-js
  // -----------------------------------------------------------------------

  it('extracts phone field via libphonenumber', () => {
    const result = extractWithJSLibs(
      'call me at 555-123-4567',
      [{ name: 'phone', type: 'phone' }],
      'en-US',
    );
    expect(result.phone).toBeDefined();
    // Should be E.164 format
    expect(result.phone).toMatch(/^\+\d+$/);
  });

  it('extracts international phone number', () => {
    const result = extractWithJSLibs(
      'my number is +44 20 7946 0958',
      [{ name: 'contact', type: 'phone' }],
      'en-GB',
    );
    expect(result.contact).toBeDefined();
    expect(result.contact).toMatch(/^\+44/);
  });

  it('uses locale region for phone country default', () => {
    // 020 7946 0958 is a valid UK number format
    const result = extractWithJSLibs(
      'call 020 7946 0958',
      [{ name: 'phone', type: 'phone' }],
      'en-GB',
    );
    // With GB as default country, this should parse as a UK number
    expect(result.phone).toBeDefined();
    if (result.phone) {
      expect(result.phone).toMatch(/^\+44/);
    }
  });

  // -----------------------------------------------------------------------
  // Unsupported types and edge cases
  // -----------------------------------------------------------------------

  it('skips unknown field types', () => {
    const result = extractWithJSLibs('hello world', [{ name: 'city', type: 'string' }], 'en');
    expect(result).toEqual({});
  });

  it('skips fields with empty type', () => {
    const result = extractWithJSLibs('arriving tomorrow', [{ name: 'something', type: '' }], 'en');
    expect(result).toEqual({});
  });

  it('returns empty for empty text', () => {
    const result = extractWithJSLibs('', [{ name: 'checkin', type: 'date' }], 'en');
    expect(result).toEqual({});
  });

  it('returns empty for whitespace-only text', () => {
    const result = extractWithJSLibs('   ', [{ name: 'checkin', type: 'date' }], 'en');
    expect(result).toEqual({});
  });

  it('returns empty when no fields provided', () => {
    const result = extractWithJSLibs('arriving tomorrow', [], 'en');
    expect(result).toEqual({});
  });

  it('returns empty when text has no extractable entities', () => {
    const result = extractWithJSLibs(
      'just saying hello',
      [
        { name: 'checkin', type: 'date' },
        { name: 'phone', type: 'phone' },
      ],
      'en',
    );
    // "just saying hello" has no dates or phone numbers
    expect(Object.keys(result).length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Multiple fields of different types
  // -----------------------------------------------------------------------

  it('handles multiple fields of different types', () => {
    const result = extractWithJSLibs(
      'arriving tomorrow, call me at 555-123-4567',
      [
        { name: 'checkin', type: 'date' },
        { name: 'phone', type: 'phone' },
      ],
      'en',
    );
    expect(result.checkin).toBeDefined();
    expect(result.phone).toBeDefined();
  });

  it('extracts only matching fields from mixed-type input', () => {
    const result = extractWithJSLibs(
      'arriving tomorrow, my name is John',
      [
        { name: 'checkin', type: 'date' },
        { name: 'name', type: 'string' },
        { name: 'phone', type: 'phone' },
      ],
      'en',
    );
    // date should be extracted, string skipped, phone not found
    expect(result.checkin).toBeDefined();
    expect(result.name).toBeUndefined();
    expect(result.phone).toBeUndefined();
  });

  it('handles case-insensitive type matching', () => {
    const result = extractWithJSLibs(
      'arriving tomorrow',
      [{ name: 'checkin', type: 'Date' }],
      'en',
    );
    expect(result.checkin).toBeDefined();
  });

  it('handles DATE type in all caps', () => {
    const result = extractWithJSLibs(
      'arriving tomorrow',
      [{ name: 'checkin', type: 'DATE' }],
      'en',
    );
    expect(result.checkin).toBeDefined();
  });

  it('handles PHONE type in all caps', () => {
    const result = extractWithJSLibs(
      'call +1 555-123-4567',
      [{ name: 'contact', type: 'PHONE' }],
      'en-US',
    );
    expect(result.contact).toBeDefined();
  });
});

describe('isJSExtractableType', () => {
  it('returns true for date', () => {
    expect(isJSExtractableType('date')).toBe(true);
  });

  it('returns true for datetime', () => {
    expect(isJSExtractableType('datetime')).toBe(true);
  });

  it('returns true for phone', () => {
    expect(isJSExtractableType('phone')).toBe(true);
  });

  it('returns false for string', () => {
    expect(isJSExtractableType('string')).toBe(false);
  });

  it('returns true for number', () => {
    expect(isJSExtractableType('number')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(isJSExtractableType('')).toBe(false);
  });

  it('handles case-insensitive input', () => {
    expect(isJSExtractableType('Date')).toBe(true);
    expect(isJSExtractableType('PHONE')).toBe(true);
    expect(isJSExtractableType('DateTime')).toBe(true);
  });
});
