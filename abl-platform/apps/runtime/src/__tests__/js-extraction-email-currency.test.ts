/**
 * Tests for email, currency, and number extractors in Tier 1 JS libs.
 *
 * Validates that extractWithJSLibs handles email, currency, number, integer,
 * and float field types using regex-based extraction — no external libraries needed.
 */
import { describe, it, expect } from 'vitest';
import { extractWithJSLibs, isJSExtractableType } from '../services/execution/js-extraction.js';

describe('email extraction in Tier 1', () => {
  it('should extract a simple email address', () => {
    const result = extractWithJSLibs(
      'My email is john@example.com',
      [{ name: 'email', type: 'email' }],
      'en',
    );
    expect(result.email).toBe('john@example.com');
  });

  it('should extract email with dots and plus', () => {
    const result = extractWithJSLibs(
      'Contact me at john.doe+work@company.co.uk',
      [{ name: 'contact', type: 'email' }],
      'en',
    );
    expect(result.contact).toBe('john.doe+work@company.co.uk');
  });

  it('should not extract invalid email', () => {
    const result = extractWithJSLibs(
      'Not an email: john@',
      [{ name: 'email', type: 'email' }],
      'en',
    );
    expect(result.email).toBeUndefined();
  });

  it('should extract email from longer text', () => {
    const result = extractWithJSLibs(
      'Please send the report to alice.smith@corp.io and cc the team',
      [{ name: 'recipient', type: 'email' }],
      'en',
    );
    expect(result.recipient).toBe('alice.smith@corp.io');
  });

  it('should handle EMAIL type in all caps', () => {
    const result = extractWithJSLibs(
      'reach me at test@example.org',
      [{ name: 'mail', type: 'EMAIL' }],
      'en',
    );
    expect(result.mail).toBe('test@example.org');
  });
});

describe('currency extraction in Tier 1', () => {
  it('should extract USD amount', () => {
    const result = extractWithJSLibs(
      'The total is $49.99',
      [{ name: 'amount', type: 'currency' }],
      'en',
    );
    expect(result.amount).toEqual({ value: 49.99, currency: 'USD' });
  });

  it('should extract EUR amount', () => {
    const result = extractWithJSLibs(
      'Price is €120.50',
      [{ name: 'price', type: 'currency' }],
      'en',
    );
    expect(result.price).toEqual({ value: 120.5, currency: 'EUR' });
  });

  it('should extract GBP amount', () => {
    const result = extractWithJSLibs('It costs £75', [{ name: 'cost', type: 'currency' }], 'en');
    expect(result.cost).toEqual({ value: 75, currency: 'GBP' });
  });

  it('should extract amount with currency code suffix', () => {
    const result = extractWithJSLibs('Total: 250 USD', [{ name: 'total', type: 'currency' }], 'en');
    expect(result.total).toEqual({ value: 250, currency: 'USD' });
  });

  it('should extract JPY amount', () => {
    const result = extractWithJSLibs(
      'That will be ¥5000',
      [{ name: 'price', type: 'currency' }],
      'en',
    );
    expect(result.price).toEqual({ value: 5000, currency: 'JPY' });
  });

  it('should extract EUR with code suffix', () => {
    const result = extractWithJSLibs(
      'Transfer 1500.75 EUR to the account',
      [{ name: 'transfer', type: 'currency' }],
      'en',
    );
    expect(result.transfer).toEqual({ value: 1500.75, currency: 'EUR' });
  });

  it('should handle CURRENCY type in all caps', () => {
    const result = extractWithJSLibs('Cost is $10', [{ name: 'cost', type: 'CURRENCY' }], 'en');
    expect(result.cost).toEqual({ value: 10, currency: 'USD' });
  });

  it('should not extract currency from text with no amount', () => {
    const result = extractWithJSLibs(
      'I like dollars',
      [{ name: 'amount', type: 'currency' }],
      'en',
    );
    expect(result.amount).toBeUndefined();
  });

  it('should extract amount with commas in number', () => {
    const result = extractWithJSLibs(
      'The house costs $1,250,000',
      [{ name: 'price', type: 'currency' }],
      'en',
    );
    expect(result.price).toEqual({ value: 1250000, currency: 'USD' });
  });
});

describe('number extraction in Tier 1', () => {
  it('should extract integer', () => {
    const result = extractWithJSLibs('I need 5 rooms', [{ name: 'count', type: 'number' }], 'en');
    expect(result.count).toBe(5);
  });

  it('should extract decimal', () => {
    const result = extractWithJSLibs(
      'Temperature is 98.6 degrees',
      [{ name: 'temp', type: 'number' }],
      'en',
    );
    expect(result.temp).toBe(98.6);
  });

  it('should extract integer type', () => {
    const result = extractWithJSLibs(
      'There are 42 items',
      [{ name: 'qty', type: 'integer' }],
      'en',
    );
    expect(result.qty).toBe(42);
  });

  it('should extract float type', () => {
    const result = extractWithJSLibs(
      'Weight is 3.14 kg',
      [{ name: 'weight', type: 'float' }],
      'en',
    );
    expect(result.weight).toBe(3.14);
  });

  it('should handle NUMBER type in all caps', () => {
    const result = extractWithJSLibs(
      'I want 7 tickets',
      [{ name: 'tickets', type: 'NUMBER' }],
      'en',
    );
    expect(result.tickets).toBe(7);
  });

  it('should not extract number from text with no digits', () => {
    const result = extractWithJSLibs('no numbers here', [{ name: 'count', type: 'number' }], 'en');
    expect(result.count).toBeUndefined();
  });
});

describe('isJSExtractableType includes new types', () => {
  it('returns true for email', () => {
    expect(isJSExtractableType('email')).toBe(true);
  });

  it('returns true for currency', () => {
    expect(isJSExtractableType('currency')).toBe(true);
  });

  it('returns true for number', () => {
    expect(isJSExtractableType('number')).toBe(true);
  });

  it('returns true for integer', () => {
    expect(isJSExtractableType('integer')).toBe(true);
  });

  it('returns true for float', () => {
    expect(isJSExtractableType('float')).toBe(true);
  });

  it('handles case-insensitive new types', () => {
    expect(isJSExtractableType('Email')).toBe(true);
    expect(isJSExtractableType('CURRENCY')).toBe(true);
    expect(isJSExtractableType('Number')).toBe(true);
    expect(isJSExtractableType('INTEGER')).toBe(true);
    expect(isJSExtractableType('Float')).toBe(true);
  });
});

describe('mixed extraction with new and existing types', () => {
  it('extracts email alongside date and phone', () => {
    const result = extractWithJSLibs(
      'Email john@example.com, arriving March 15, call +1 555-123-4567',
      [
        { name: 'email', type: 'email' },
        { name: 'date', type: 'date' },
        { name: 'phone', type: 'phone' },
      ],
      'en-US',
    );
    expect(result.email).toBe('john@example.com');
    expect(result.date).toBeDefined();
    expect(result.phone).toBeDefined();
  });

  it('extracts currency alongside other fields', () => {
    const result = extractWithJSLibs(
      'Pay $99.99 by March 20',
      [
        { name: 'amount', type: 'currency' },
        { name: 'due', type: 'date' },
      ],
      'en',
    );
    expect(result.amount).toEqual({ value: 99.99, currency: 'USD' });
    expect(result.due).toBeDefined();
  });

  it('extracts number alongside other fields', () => {
    const result = extractWithJSLibs(
      'Book 3 rooms for tomorrow',
      [
        { name: 'rooms', type: 'number' },
        { name: 'checkin', type: 'date' },
      ],
      'en',
    );
    expect(result.rooms).toBe(3);
    expect(result.checkin).toBeDefined();
  });
});
