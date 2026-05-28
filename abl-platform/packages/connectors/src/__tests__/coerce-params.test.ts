import { describe, it, expect } from 'vitest';
import { coerceParams } from '../adapters/activepieces/context-translator.js';

describe('coerceParams', () => {
  it('passes non-string values through unchanged', () => {
    const input = { count: 42, nested: { a: 1 }, arr: [1, 2] };
    const result = coerceParams(input);
    expect(result).toEqual({ count: 42, nested: { a: 1 }, arr: [1, 2] });
  });

  it('parses JSON array strings into arrays', () => {
    const result = coerceParams({ to: '["a@example.com","b@example.com"]' });
    expect(result.to).toEqual(['a@example.com', 'b@example.com']);
  });

  it('keeps JSON object strings as strings (prevents nodemailer/Buffer crashes)', () => {
    const result = coerceParams({ headers: '{"Content-Type":"application/json"}' });
    expect(result.headers).toBe('{"Content-Type":"application/json"}');
  });

  it('keeps numeric strings as strings to avoid corrupting IDs/phone numbers', () => {
    const result = coerceParams({
      limit: '100',
      offset: '0',
      ratio: '3.14',
      phone: '14155551234',
      zip: '90210',
    });
    expect(result.limit).toBe('100');
    expect(result.offset).toBe('0');
    expect(result.ratio).toBe('3.14');
    expect(result.phone).toBe('14155551234');
    expect(result.zip).toBe('90210');
  });

  it('parses boolean strings into booleans', () => {
    const result = coerceParams({ enabled: 'true', verbose: 'false' });
    expect(result.enabled).toBe(true);
    expect(result.verbose).toBe(false);
  });

  it('keeps plain strings as strings', () => {
    const result = coerceParams({
      subject: 'Hello World',
      body: 'Some message text',
    });
    expect(result.subject).toBe('Hello World');
    expect(result.body).toBe('Some message text');
  });

  it('keeps invalid JSON strings as strings', () => {
    const result = coerceParams({ broken: '[not json' });
    expect(result.broken).toBe('[not json');
  });

  it('handles empty string as string (not coerced)', () => {
    const result = coerceParams({ empty: '' });
    expect(result.empty).toBe('');
  });

  it('handles whitespace-padded JSON', () => {
    const result = coerceParams({ padded: '  [1, 2, 3]  ' });
    expect(result.padded).toEqual([1, 2, 3]);
  });

  it('handles Infinity string as string (not a valid JSON number)', () => {
    // Number('Infinity') is not NaN, but JSON.parse('Infinity') throws
    const result = coerceParams({ val: 'Infinity' });
    expect(result.val).toBe('Infinity');
  });

  it('handles mixed params with different types', () => {
    const result = coerceParams({
      to: '["user@example.com"]',
      subject: 'Test Email',
      count: '5',
      body: '{"html":"<p>Hi</p>"}',
      draft: 'false',
    });
    expect(result.to).toEqual(['user@example.com']);
    expect(result.subject).toBe('Test Email');
    expect(result.count).toBe('5'); // numeric strings stay as strings
    expect(result.body).toBe('{"html":"<p>Hi</p>"}'); // object strings stay as strings
    expect(result.draft).toBe(false);
  });

  it('returns empty object for empty input', () => {
    expect(coerceParams({})).toEqual({});
  });
});
