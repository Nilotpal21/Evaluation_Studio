import { describe, it, expect } from 'vitest';
import { extractEntitiesForFields } from '../../platform/utils/entity-extraction.js';

describe('extractEntitiesForFields (refactored)', () => {
  it('extracts date field using chrono-node', () => {
    const result = extractEntitiesForFields(
      'arriving next Monday',
      ['check_in'],
      undefined,
      { check_in: 'date' },
      'en',
    );
    expect(result.check_in).toBeDefined();
    expect(result.check_in).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('extracts phone field using libphonenumber', () => {
    const result = extractEntitiesForFields(
      'call me at 555-123-4567',
      ['phone'],
      undefined,
      { phone: 'phone' },
      'en',
    );
    expect(result.phone).toBe('+15551234567');
  });

  it('extracts number field (unchanged)', () => {
    const result = extractEntitiesForFields(
      '4 guests',
      ['num_guests'],
      undefined,
      { num_guests: 'number' },
      'en',
    );
    expect(result.num_guests).toBe(4);
  });

  it('extracts email field (unchanged regex)', () => {
    const result = extractEntitiesForFields(
      'email me at test@example.com',
      ['email'],
      undefined,
      { email: 'email' },
      'en',
    );
    expect(result.email).toBe('test@example.com');
  });

  it('handles multiple fields', () => {
    const result = extractEntitiesForFields(
      'arriving March 15 with 2 guests, call 555-123-4567',
      ['check_in', 'guests', 'phone'],
      undefined,
      { check_in: 'date', guests: 'number', phone: 'phone' },
      'en',
    );
    expect(result.check_in).toBeDefined();
    expect(result.check_in).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.guests).toBe(2);
    expect(result.phone).toBeDefined();
  });

  it('returns empty for no date match in multi-field context', () => {
    // With multiple fields, unmatched typed fields are left undefined
    // (single-field mode falls back to raw input for progressive collection)
    const result = extractEntitiesForFields(
      'hello world',
      ['check_in', 'name'],
      undefined,
      { check_in: 'date' },
      'en',
    );
    expect(result.check_in).toBeUndefined();
  });

  it('single date field with no match falls back to raw input', () => {
    // Single-field fallback stores raw input for progressive collection
    const result = extractEntitiesForFields(
      'hello world',
      ['check_in'],
      undefined,
      { check_in: 'date' },
      'en',
    );
    expect(result.check_in).toBe('hello world');
  });

  it('handles multilingual dates', () => {
    const result = extractEntitiesForFields(
      'el 15 de marzo de 2026',
      ['fecha'],
      undefined,
      { fecha: 'date' },
      'es',
    );
    expect(result.fecha).toBeDefined();
    expect(result.fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('extracts relative date "tomorrow"', () => {
    const result = extractEntitiesForFields(
      'I need it by tomorrow',
      ['due_date'],
      undefined,
      { due_date: 'date' },
      'en',
    );
    expect(result.due_date).toBeDefined();
    expect(result.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('extracts phone with international format', () => {
    const result = extractEntitiesForFields(
      'ring me on +44 20 7946 0958',
      ['contact'],
      undefined,
      { contact: 'phone' },
      'en',
    );
    expect(result.contact).toBeDefined();
    expect(result.contact).toMatch(/^\+\d+/);
  });

  it('extracts date range into checkin/checkout fields', () => {
    const result = extractEntitiesForFields(
      'from March 6 to March 10',
      ['checkin_date', 'checkout_date'],
      undefined,
      { checkin_date: 'date', checkout_date: 'date' },
      'en',
    );
    expect(result.checkin_date).toBeDefined();
    expect(result.checkout_date).toBeDefined();
    expect(result.checkin_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.checkout_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('preserves backward compatibility with old call pattern (no fieldTypes)', () => {
    // Runtime callers sometimes call with just (message, fields) — no types
    const result = extractEntitiesForFields('Barcelona', ['destination']);
    expect(result.destination).toBe('Barcelona');
  });

  it('preserves backward compatibility: single field stores raw input as fallback', () => {
    const result = extractEntitiesForFields('John Smith', ['name']);
    expect(result.name).toBe('John Smith');
  });

  it('preserves backward compatibility: multi-field extraction with types', () => {
    const config = { additionalDestinations: ['barcelona'] };
    const result = extractEntitiesForFields(
      'Barcelona from Mar 6 to Mar 10 for 2 guests',
      ['destination', 'checkin_date', 'checkout_date', 'guest_count'],
      config,
      {
        destination: 'destination',
        checkin_date: 'date',
        checkout_date: 'date',
        guest_count: 'number',
      },
    );

    expect(result.destination).toBe('Barcelona');
    expect(result.checkin_date).toBeDefined();
    expect(result.checkout_date).toBeDefined();
    expect(result.guest_count).toBe(2);
  });
});
