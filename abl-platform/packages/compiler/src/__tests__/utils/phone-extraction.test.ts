import { describe, it, expect } from 'vitest';
import { extractPhoneFromText } from '../../platform/utils/phone-extraction.js';

describe('extractPhoneFromText', () => {
  it('extracts US phone number', () => {
    const result = extractPhoneFromText('call me at 555-123-4567', 'US');
    expect(result).not.toBeNull();
    expect(result!.e164).toBe('+15551234567');
  });

  it('extracts international format +44 20 7946 0958', () => {
    const result = extractPhoneFromText('ring +44 20 7946 0958', 'GB');
    expect(result).not.toBeNull();
    expect(result!.e164).toBe('+442079460958');
  });

  it('extracts phone with parentheses (555) 123-4567', () => {
    const result = extractPhoneFromText('(555) 123-4567', 'US');
    expect(result).not.toBeNull();
    expect(result!.e164).toBe('+15551234567');
  });

  it('returns null for no phone number', () => {
    const result = extractPhoneFromText('hello world', 'US');
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = extractPhoneFromText('', 'US');
    expect(result).toBeNull();
  });

  it('validates and rejects invalid numbers', () => {
    const result = extractPhoneFromText('123', 'US');
    expect(result).toBeNull();
  });

  it('normalizes to E.164 format', () => {
    const result = extractPhoneFromText('my number is 07911 123456', 'GB');
    expect(result).not.toBeNull();
    expect(result!.e164).toMatch(/^\+44/);
  });
});
