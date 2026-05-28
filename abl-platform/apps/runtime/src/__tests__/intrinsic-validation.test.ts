import { describe, it, expect } from 'vitest';
import { validateIntrinsic } from '../services/execution/intrinsic-validation.js';
import type { IntrinsicValidationResult } from '../services/execution/intrinsic-validation.js';

describe('validateIntrinsic', () => {
  describe('email', () => {
    it('accepts a valid email', () => {
      const result = validateIntrinsic('email', 'user@example.com');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('user@example.com');
    });

    it('rejects value without @', () => {
      const result = validateIntrinsic('email', 'not-an-email');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('rejects value without TLD', () => {
      const result = validateIntrinsic('email', 'user@localhost');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('normalizes email to lowercase', () => {
      const result = validateIntrinsic('email', 'User@Example.COM');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('user@example.com');
    });
  });

  describe('phone', () => {
    it('accepts and normalizes a valid US phone number to E.164', () => {
      const result = validateIntrinsic('phone', '+1-555-123-4567');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('+15551234567');
    });

    it('accepts a 10-digit number', () => {
      const result = validateIntrinsic('phone', '5551234567');
      expect(result.valid).toBe(true);
    });

    it('rejects phone with fewer than 7 digits', () => {
      const result = validateIntrinsic('phone', '12345');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('accepts phone with 15 digits', () => {
      const result = validateIntrinsic('phone', '+123456789012345');
      expect(result.valid).toBe(true);
    });

    it('rejects phone with more than 15 digits', () => {
      const result = validateIntrinsic('phone', '+1234567890123456');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('date', () => {
    it('accepts ISO date string', () => {
      const result = validateIntrinsic('date', '2025-03-15');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('2025-03-15');
    });

    it('accepts and normalizes natural language date to ISO', () => {
      const result = validateIntrinsic('date', 'March 15, 2025');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('2025-03-15');
    });

    it('rejects empty string', () => {
      const result = validateIntrinsic('date', '');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('rejects non-date string', () => {
      const result = validateIntrinsic('date', 'not a date');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('datetime', () => {
    it('accepts ISO datetime string', () => {
      const result = validateIntrinsic('datetime', '2025-03-15T10:30:00Z');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('2025-03-15T10:30:00Z');
    });

    it('accepts date-only as a valid datetime', () => {
      const result = validateIntrinsic('datetime', '2025-03-15');
      expect(result.valid).toBe(true);
    });
  });

  describe('boolean', () => {
    it('normalizes "yes" to true', () => {
      const result = validateIntrinsic('boolean', 'yes');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(true);
    });

    it('normalizes "no" to false', () => {
      const result = validateIntrinsic('boolean', 'no');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(false);
    });

    it('normalizes "si" to true', () => {
      const result = validateIntrinsic('boolean', 'si');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(true);
    });

    it('normalizes "sí" to true', () => {
      const result = validateIntrinsic('boolean', 'sí');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(true);
    });

    it('rejects "maybe"', () => {
      const result = validateIntrinsic('boolean', 'maybe');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('passes through boolean value directly', () => {
      const resultTrue = validateIntrinsic('boolean', true);
      expect(resultTrue.valid).toBe(true);
      expect(resultTrue.normalized).toBe(true);

      const resultFalse = validateIntrinsic('boolean', false);
      expect(resultFalse.valid).toBe(true);
      expect(resultFalse.normalized).toBe(false);
    });
  });

  describe('currency', () => {
    it('accepts numeric value', () => {
      const result = validateIntrinsic('currency', 99.99);
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(99.99);
    });

    it('accepts object with value and currency', () => {
      const result = validateIntrinsic('currency', { value: 49.99, currency: 'USD' });
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(49.99);
    });

    it('accepts parseable numeric string', () => {
      const result = validateIntrinsic('currency', '150.50');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(150.5);
    });

    it('rejects non-numeric string', () => {
      const result = validateIntrinsic('currency', 'not a number');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('number/integer/float', () => {
    it('accepts numeric value for number type', () => {
      const result = validateIntrinsic('number', 42);
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(42);
    });

    it('accepts parseable string for integer type', () => {
      const result = validateIntrinsic('integer', '123');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(123);
    });

    it('accepts float string for float type', () => {
      const result = validateIntrinsic('float', '3.14');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(3.14);
    });

    it('rejects NaN-producing string', () => {
      const result = validateIntrinsic('number', 'abc');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('enum', () => {
    const constraints = {
      values: ['iPhone', 'iPad', 'Mac'],
      synonyms: { Mac: ['macbook', 'laptop'] },
    };

    it('accepts value in the enum set', () => {
      const result = validateIntrinsic('enum', 'iPhone', constraints);
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('iPhone');
    });

    it('rejects value not in the enum set', () => {
      const result = validateIntrinsic('enum', 'Android', constraints);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('handles case-insensitive enum match', () => {
      const result = validateIntrinsic('enum', 'iphone', constraints);
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('iPhone');
    });

    it('resolves synonym to canonical value', () => {
      const result = validateIntrinsic('enum', 'laptop', constraints);
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('Mac');
    });
  });

  describe('pattern', () => {
    it('accepts value matching pattern', () => {
      const result = validateIntrinsic('pattern', 'ABC-123', {
        pattern: '^[A-Z]{3}-\\d{3}$',
      });
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('ABC-123');
    });

    it('rejects value not matching pattern', () => {
      const result = validateIntrinsic('pattern', 'abc', {
        pattern: '^[A-Z]{3}-\\d{3}$',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('passes through when no pattern constraint provided', () => {
      const result = validateIntrinsic('pattern', 'anything');
      expect(result.valid).toBe(true);
    });
  });

  describe('string/text/free_text/location pass-through', () => {
    it('passes through string type', () => {
      const result = validateIntrinsic('string', 'hello world');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('hello world');
    });

    it('passes through text type', () => {
      const result = validateIntrinsic('text', 'some text');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('some text');
    });

    it('passes through free_text type', () => {
      const result = validateIntrinsic('free_text', 'free form text');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('free form text');
    });

    it('passes through location type', () => {
      const result = validateIntrinsic('location', 'New York');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('New York');
    });
  });

  describe('unknown entity type', () => {
    it('passes through for unknown types', () => {
      const result = validateIntrinsic('custom_type', 'value');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('value');
    });
  });

  describe('type annotation', () => {
    it('returns IntrinsicValidationResult shape', () => {
      const result: IntrinsicValidationResult = validateIntrinsic('string', 'test');
      expect(result).toHaveProperty('valid');
      expect(typeof result.valid).toBe('boolean');
    });
  });
});
