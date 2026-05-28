import { describe, it, expect } from 'vitest';
import {
  normalizeEnumValue,
  validateExtractedValue,
  validateExtractedBatch,
} from '../../services/execution/extraction-validation.js';

describe('normalizeEnumValue', () => {
  const options = ['iPhone', 'iPad', 'Mac', 'Apple Watch', 'AirPods'];

  it('returns exact match unchanged', () => {
    expect(normalizeEnumValue('iPhone', options)).toBe('iPhone');
  });

  it('returns case-insensitive match', () => {
    expect(normalizeEnumValue('iphone', options)).toBe('iPhone');
    expect(normalizeEnumValue('IPAD', options)).toBe('iPad');
  });

  it('returns synonym match when synonyms provided', () => {
    const synonyms = {
      iPhone: ['apple phone', 'mobile'],
      Mac: ['macbook', 'macbook pro', 'laptop'],
    };
    expect(normalizeEnumValue('apple phone', options, synonyms)).toBe('iPhone');
    expect(normalizeEnumValue('macbook pro', options, synonyms)).toBe('Mac');
    expect(normalizeEnumValue('LAPTOP', options, synonyms)).toBe('Mac');
  });

  it('returns substring match (shortest option wins)', () => {
    expect(normalizeEnumValue('MacBook Pro', options)).toBe('Mac');
    expect(normalizeEnumValue('my airpods', options)).toBe('AirPods');
  });

  it('prefers shorter option on substring ambiguity', () => {
    const opts = ['MacBook Pro', 'Mac'];
    expect(normalizeEnumValue('I have a Mac mini', opts)).toBe('Mac');
  });

  it('returns null when no match', () => {
    expect(normalizeEnumValue('Android', options)).toBeNull();
  });

  it('handles empty enum values', () => {
    expect(normalizeEnumValue('anything', [])).toBeNull();
  });
});

describe('validateExtractedValue', () => {
  it('accepts valid string value', () => {
    const field = { name: 'name', type: 'string' };
    const result = validateExtractedValue(field, 'Alice');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('Alice');
  });

  it('accepts and coerces number from string', () => {
    const field = { name: 'age', type: 'number' };
    expect(validateExtractedValue(field, 25).normalized).toBe(25);
    expect(validateExtractedValue(field, '25').normalized).toBe(25);
  });

  it('rejects non-numeric for number field', () => {
    const field = { name: 'age', type: 'number' };
    expect(validateExtractedValue(field, 'banana').valid).toBe(false);
  });

  it('accepts and coerces boolean values', () => {
    const field = { name: 'agree', type: 'boolean' };
    expect(validateExtractedValue(field, true).normalized).toBe(true);
    expect(validateExtractedValue(field, 'yes').normalized).toBe(true);
    expect(validateExtractedValue(field, 'no').normalized).toBe(false);
  });

  it('normalizes enum value via normalizeEnumValue', () => {
    const field = {
      name: 'device',
      type: 'enum',
      enum_values: ['iPhone', 'iPad', 'Mac'],
      synonyms: { Mac: ['macbook'] },
    };
    const result = validateExtractedValue(field, 'macbook');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('Mac');
  });

  it('rejects invalid enum value', () => {
    const field = {
      name: 'device',
      type: 'enum',
      enum_values: ['iPhone', 'iPad'],
    };
    expect(validateExtractedValue(field, 'Android').valid).toBe(false);
  });

  it('passes through unknown types without validation', () => {
    const field = { name: 'data', type: 'custom_thing' };
    const result = validateExtractedValue(field, 'anything');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('anything');
  });
});

describe('validateExtractedBatch', () => {
  it('validates and normalizes a batch of values', () => {
    const fields = [
      { name: 'name', type: 'string' },
      { name: 'age', type: 'number' },
      { name: 'device', type: 'enum', enum_values: ['iPhone', 'iPad'] },
    ];
    const { valid, invalid } = validateExtractedBatch(fields, {
      name: 'Alice',
      age: '30',
      device: 'iphone',
    });
    expect(valid.name).toBe('Alice');
    expect(valid.age).toBe(30);
    expect(valid.device).toBe('iPhone');
    expect(Object.keys(invalid)).toHaveLength(0);
  });

  it('separates invalid values', () => {
    const fields = [
      { name: 'age', type: 'number' },
      { name: 'name', type: 'string' },
    ];
    const { valid, invalid } = validateExtractedBatch(fields, {
      age: 'not-a-number',
      name: 'Bob',
    });
    expect(valid.name).toBe('Bob');
    expect(invalid.age).toBeDefined();
  });

  it('passes through unknown fields without validation', () => {
    const fields = [{ name: 'known', type: 'string' }];
    const { valid } = validateExtractedBatch(fields, {
      known: 'a',
      extra: 'b',
    });
    expect(valid.known).toBe('a');
    expect(valid.extra).toBe('b');
  });

  it('normalizes enum fields even when type is not enum', () => {
    const fields = [{ name: 'device', type: 'string', enum_values: ['iPhone', 'iPad'] }];
    const { valid } = validateExtractedBatch(fields, { device: 'iphone' });
    expect(valid.device).toBe('iPhone');
  });
});

describe('post-LLM normalization (Gap 33)', () => {
  describe('phone → E.164', () => {
    it('normalizes formatted US phone to E.164', () => {
      const field = { name: 'phone', type: 'phone' };
      const result = validateExtractedValue(field, '(555) 123-4567');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('+15551234567');
    });

    it('normalizes hyphenated international phone to E.164', () => {
      const field = { name: 'phone', type: 'phone' };
      const result = validateExtractedValue(field, '+44-20-7946-0958');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('+442079460958');
    });

    it('passes through already-E.164 phone unchanged', () => {
      const field = { name: 'phone', type: 'phone' };
      const result = validateExtractedValue(field, '+15551234567');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('+15551234567');
    });

    it('rejects too-short phone strings', () => {
      const field = { name: 'phone', type: 'phone' };
      expect(validateExtractedValue(field, '123').valid).toBe(false);
    });
  });

  describe('email → lowercase', () => {
    it('lowercases mixed-case email', () => {
      const field = { name: 'email', type: 'email' };
      const result = validateExtractedValue(field, 'USER@Gmail.COM');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('user@gmail.com');
    });

    it('passes through already-lowercase email', () => {
      const field = { name: 'email', type: 'email' };
      const result = validateExtractedValue(field, 'test@example.com');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('test@example.com');
    });
  });

  describe('date → ISO', () => {
    it('normalizes natural-language date to ISO', () => {
      const field = { name: 'date', type: 'date' };
      const result = validateExtractedValue(field, 'March 15, 2026');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('2026-03-15');
    });

    it('passes through already-ISO date unchanged', () => {
      const field = { name: 'date', type: 'date' };
      const result = validateExtractedValue(field, '2026-04-15');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('2026-04-15');
    });

    it('normalizes datetime string that starts with ISO prefix', () => {
      const field = { name: 'dt', type: 'datetime' };
      const result = validateExtractedValue(field, '2026-04-15T14:30:00Z');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('2026-04-15T14:30:00Z');
    });
  });

  describe('currency → numeric', () => {
    it('parses dollar-sign currency string to number', () => {
      const field = { name: 'budget', type: 'currency' };
      const result = validateExtractedValue(field, '$3,500');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(3500);
    });

    it('parses euro currency string', () => {
      const field = { name: 'budget', type: 'currency' };
      const result = validateExtractedValue(field, '€120');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(120);
    });

    it('parses code-suffix currency string', () => {
      const field = { name: 'budget', type: 'currency' };
      const result = validateExtractedValue(field, '250 USD');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(250);
    });

    it('extracts numeric value from Tier 1 structured object', () => {
      const field = { name: 'budget', type: 'currency' };
      const result = validateExtractedValue(field, { value: 49.99, currency: 'USD' });
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(49.99);
    });

    it('passes through plain number', () => {
      const field = { name: 'budget', type: 'currency' };
      const result = validateExtractedValue(field, 3500);
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(3500);
    });

    it('parses plain numeric string', () => {
      const field = { name: 'budget', type: 'currency' };
      const result = validateExtractedValue(field, '3500');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(3500);
    });

    it('rejects non-numeric non-currency string', () => {
      const field = { name: 'budget', type: 'currency' };
      expect(validateExtractedValue(field, 'not a currency').valid).toBe(false);
    });
  });

  describe('batch normalization', () => {
    it('normalizes phone, email, date, and currency in one batch', () => {
      const fields = [
        { name: 'phone', type: 'phone' },
        { name: 'email', type: 'email' },
        { name: 'date', type: 'date' },
        { name: 'budget', type: 'currency' },
      ];
      const { valid, invalid } = validateExtractedBatch(fields, {
        phone: '555-123-4567',
        email: 'Test@Example.COM',
        date: 'March 15, 2026',
        budget: '$3,500',
      });
      expect(valid.phone).toBe('+15551234567');
      expect(valid.email).toBe('test@example.com');
      expect(valid.date).toBe('2026-03-15');
      expect(valid.budget).toBe(3500);
      expect(Object.keys(invalid)).toHaveLength(0);
    });
  });
});
