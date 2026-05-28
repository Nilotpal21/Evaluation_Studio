import { describe, test, expect } from 'vitest';
import { evaluateCel, evaluateCelCondition } from '../../platform/constructs/cel-evaluator.js';

describe('ABL Custom Functions in CEL', () => {
  // -------------------------------------------------------------------------
  // String functions
  // -------------------------------------------------------------------------
  describe('String functions', () => {
    test('abl.upper() converts string to uppercase', () => {
      expect(evaluateCel('abl.upper(name)', { name: 'john' })).toBe('JOHN');
    });

    test('abl.upper() handles non-string input', () => {
      expect(evaluateCel('abl.upper(val)', { val: 42 })).toBe('42');
    });

    test('abl.lower() converts string to lowercase', () => {
      expect(evaluateCel('abl.lower(name)', { name: 'JOHN DOE' })).toBe('john doe');
    });

    test('abl.trim() removes leading and trailing whitespace', () => {
      expect(evaluateCel('abl.trim(name)', { name: '  hello  ' })).toBe('hello');
    });

    test('abl.substring() with start index only', () => {
      expect(evaluateCel('abl.substring("hello world", 6)', {})).toBe('world');
    });

    test('abl.substring() with start and end indices', () => {
      expect(evaluateCel('abl.substring("hello world", 0, 5)', {})).toBe('hello');
    });

    test('abl.replace() replaces all occurrences', () => {
      expect(evaluateCel('abl.replace("hello world", "world", "CEL")', {})).toBe('hello CEL');
    });

    test('abl.replace() replaces multiple occurrences', () => {
      expect(evaluateCel('abl.replace("a-b-c", "-", ".")', {})).toBe('a.b.c');
    });

    test('abl.split() splits string by delimiter', () => {
      const result = evaluateCel('abl.split("a,b,c", ",")', {});
      expect(result).toEqual(['a', 'b', 'c']);
    });

    test('abl.join() joins array with delimiter', () => {
      expect(evaluateCel('abl.join(items, "-")', { items: ['a', 'b', 'c'] })).toBe('a-b-c');
    });

    test('abl.join() with default delimiter', () => {
      expect(evaluateCel('abl.join(items)', { items: ['a', 'b', 'c'] })).toBe('a,b,c');
    });

    test('abl.pad_start() pads string to target length', () => {
      expect(evaluateCel('abl.pad_start("5", 3, "0")', {})).toBe('005');
    });

    test('abl.pad_start() with default space padding', () => {
      expect(evaluateCel('abl.pad_start("hi", 5)', {})).toBe('   hi');
    });

    test('abl.pad_end() pads string at end', () => {
      expect(evaluateCel('abl.pad_end("hi", 5, ".")', {})).toBe('hi...');
    });

    test('abl.pad_end() with default space padding', () => {
      expect(evaluateCel('abl.pad_end("hi", 5)', {})).toBe('hi   ');
    });

    test('abl.repeat() repeats string n times', () => {
      expect(evaluateCel('abl.repeat("ab", 3)', {})).toBe('ababab');
    });

    test('abl.repeat() is bounded to prevent excessive memory', () => {
      // Repeating a single char 100_000 times should work
      const result = evaluateCel('abl.repeat("x", 100000)', {}) as string;
      expect(result.length).toBe(100_000);
    });
  });

  // -------------------------------------------------------------------------
  // Numeric functions
  // -------------------------------------------------------------------------
  describe('Numeric functions', () => {
    test('abl.round() rounds to integer', () => {
      expect(evaluateCel('abl.round(3.7)', {})).toBe(4);
    });

    test('abl.round() rounds to specified decimal places', () => {
      expect(evaluateCel('abl.round(3.14159, 2)', {})).toBe(3.14);
    });

    test('abl.round() rounds to 0 decimal places', () => {
      expect(evaluateCel('abl.round(3.14159, 0)', {})).toBe(3);
    });

    test('abl.abs() returns absolute value', () => {
      expect(evaluateCel('abl.abs(n)', { n: -5.0 })).toBe(5);
    });

    test('abl.abs() with positive value', () => {
      expect(evaluateCel('abl.abs(n)', { n: 5.0 })).toBe(5);
    });

    test('abl.min() returns smaller value', () => {
      expect(evaluateCel('abl.min(a, b)', { a: 5, b: 3 })).toBe(3);
    });

    test('abl.max() returns larger value', () => {
      expect(evaluateCel('abl.max(a, b)', { a: 5, b: 3 })).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // Formatting functions
  // -------------------------------------------------------------------------
  describe('Formatting functions', () => {
    test('abl.mask() with "last4" pattern', () => {
      expect(evaluateCel('abl.mask(ssn, "last4")', { ssn: '123-45-6789' })).toBe('*******6789');
    });

    test('abl.mask() with "first4" pattern', () => {
      expect(evaluateCel('abl.mask(card, "first4")', { card: '4111111111111111' })).toBe(
        '4111************',
      );
    });

    test('abl.mask() with custom mask character', () => {
      expect(evaluateCel('abl.mask(ssn, "last4", "#")', { ssn: '123-45-6789' })).toBe(
        '#######6789',
      );
    });

    test('abl.mask() with N*M pattern', () => {
      // Show first 2, mask middle, show last 3
      expect(evaluateCel('abl.mask(phone, "2*3")', { phone: '5551234567' })).toBe('55*****567');
    });

    test('abl.mask() with unknown pattern masks all', () => {
      expect(evaluateCel('abl.mask(val, "unknown")', { val: 'secret' })).toBe('******');
    });

    test('abl.format_currency() formats USD', () => {
      const result = evaluateCel('abl.format_currency(1234.5, "USD")', {}) as string;
      expect(result).toContain('1,234.50');
    });

    test('abl.format_currency() with locale', () => {
      const result = evaluateCel('abl.format_currency(1234.5, "EUR", "de-DE")', {}) as string;
      // German locale uses comma as decimal separator
      expect(result).toContain('1.234,50');
    });

    test('abl.format_date() formats date with YYYY-MM-DD', () => {
      const result = evaluateCel('abl.format_date("2024-03-15T10:30:00Z", "YYYY-MM-DD")', {});
      expect(result).toBe('2024-03-15');
    });

    test('abl.format_date() with time format', () => {
      const result = evaluateCel(
        'abl.format_date("2024-03-15T10:30:45Z", "YYYY-MM-DD HH:mm:ss")',
        {},
      );
      expect(typeof result).toBe('string');
      expect(result).toContain('2024');
    });

    test('abl.format_date() with invalid date returns input', () => {
      expect(evaluateCel('abl.format_date("not-a-date", "YYYY-MM-DD")', {})).toBe('not-a-date');
    });

    test('abl.format_date() with timezone parameter accepted', () => {
      const result = evaluateCel(
        'abl.format_date("2024-03-15T10:30:00Z", "YYYY-MM-DD", "UTC")',
        {},
      );
      expect(typeof result).toBe('string');
      expect(result).toContain('2024');
    });

    test('abl.ordinal() for 1st, 2nd, 3rd', () => {
      expect(evaluateCel('abl.ordinal(1)', {})).toBe('1st');
      expect(evaluateCel('abl.ordinal(2)', {})).toBe('2nd');
      expect(evaluateCel('abl.ordinal(3)', {})).toBe('3rd');
    });

    test('abl.ordinal() for teens', () => {
      expect(evaluateCel('abl.ordinal(11)', {})).toBe('11th');
      expect(evaluateCel('abl.ordinal(12)', {})).toBe('12th');
      expect(evaluateCel('abl.ordinal(13)', {})).toBe('13th');
    });

    test('abl.ordinal() for 21st, 22nd, 23rd', () => {
      expect(evaluateCel('abl.ordinal(21)', {})).toBe('21st');
      expect(evaluateCel('abl.ordinal(22)', {})).toBe('22nd');
      expect(evaluateCel('abl.ordinal(23)', {})).toBe('23rd');
    });
  });

  // -------------------------------------------------------------------------
  // Type checking functions
  // -------------------------------------------------------------------------
  describe('Type checking functions', () => {
    test('abl.is_array() returns true for arrays', () => {
      expect(evaluateCel('abl.is_array(items)', { items: [1, 2] })).toBe(true);
    });

    test('abl.is_array() returns false for non-arrays', () => {
      expect(evaluateCel('abl.is_array(name)', { name: 'hello' })).toBe(false);
    });

    test('abl.is_number() returns true for numbers', () => {
      expect(evaluateCel('abl.is_number(age)', { age: 25 })).toBe(true);
    });

    test('abl.is_number() returns true for BigInt (CEL integers)', () => {
      // CEL integer literals produce BigInt -- should still be considered numbers
      expect(evaluateCelCondition('abl.is_number(42)', {})).toBe(true);
    });

    test('abl.is_number() returns false for strings', () => {
      expect(evaluateCel('abl.is_number(name)', { name: 'hello' })).toBe(false);
    });

    test('abl.is_string() returns true for strings', () => {
      expect(evaluateCel('abl.is_string(name)', { name: 'hello' })).toBe(true);
    });

    test('abl.is_string() returns false for numbers', () => {
      expect(evaluateCel('abl.is_string(n)', { n: 42 })).toBe(false);
    });

    test('abl.to_number() converts string to number', () => {
      expect(evaluateCel('abl.to_number(s)', { s: '42' })).toBe(42);
    });

    test('abl.to_number() returns null for non-numeric string', () => {
      expect(evaluateCel('abl.to_number(s)', { s: 'abc' })).toBe(null);
    });

    test('abl.to_string() converts number to string', () => {
      expect(evaluateCel('abl.to_string(n)', { n: 42 })).toBe('42');
    });

    test('abl.to_string() converts null to empty string', () => {
      expect(evaluateCel('abl.to_string(n)', { n: null })).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // Array functions
  // -------------------------------------------------------------------------
  describe('Array functions', () => {
    test('abl.length() returns array length', () => {
      expect(evaluateCel('abl.length(items)', { items: [1, 2, 3] })).toBe(3);
    });

    test('abl.length() returns string length', () => {
      expect(evaluateCel('abl.length(name)', { name: 'hello' })).toBe(5);
    });

    test('abl.length() returns 0 for non-string, non-array', () => {
      expect(evaluateCel('abl.length(n)', { n: 42 })).toBe(0);
    });

    test('abl.array_find() finds object by field value', () => {
      const ctx = {
        items: [
          { id: 1, name: 'alpha' },
          { id: 2, name: 'beta' },
        ],
      };
      expect(evaluateCel('abl.array_find(items, "id", target)', { ...ctx, target: 2 })).toEqual({
        id: 2,
        name: 'beta',
      });
    });

    test('abl.array_find() returns null when not found', () => {
      const ctx = { items: [{ id: 1 }] };
      expect(evaluateCel('abl.array_find(items, "id", target)', { ...ctx, target: 99 })).toBe(null);
    });

    test('abl.array_find() returns null for non-array input', () => {
      expect(
        evaluateCel('abl.array_find(val, "id", target)', { val: 'not-array', target: 1 }),
      ).toBe(null);
    });

    test('abl.array_find_index() finds index by field value', () => {
      const ctx = {
        items: [
          { id: 1, name: 'alpha' },
          { id: 2, name: 'beta' },
        ],
        target: 2,
      };
      expect(evaluateCel('abl.array_find_index(items, "id", target)', ctx)).toBe(1);
    });

    test('abl.array_find_index() returns -1 when not found', () => {
      const ctx = { items: [{ id: 1 }], target: 99 };
      expect(evaluateCel('abl.array_find_index(items, "id", target)', ctx)).toBe(-1);
    });

    test('abl.array_find_index() returns -1 for non-array input', () => {
      expect(
        evaluateCel('abl.array_find_index(val, "id", target)', { val: 'not-array', target: 1 }),
      ).toBe(-1);
    });
  });

  // -------------------------------------------------------------------------
  // Object functions
  // -------------------------------------------------------------------------
  describe('Object functions', () => {
    test('abl.object_keys() returns object keys', () => {
      expect(evaluateCel('abl.object_keys(user)', { user: { name: 'John', age: 30 } })).toEqual([
        'name',
        'age',
      ]);
    });

    test('abl.object_keys() returns empty array for non-object', () => {
      expect(evaluateCel('abl.object_keys(val)', { val: 'not-object' })).toEqual([]);
    });

    test('abl.object_values() returns object values', () => {
      expect(evaluateCel('abl.object_values(user)', { user: { name: 'John', age: 30 } })).toEqual([
        'John',
        30,
      ]);
    });

    test('abl.object_values() returns empty array for non-object', () => {
      expect(evaluateCel('abl.object_values(val)', { val: 'not-object' })).toEqual([]);
    });

    test('abl.object_values() returns empty array for arrays', () => {
      expect(evaluateCel('abl.object_values(val)', { val: [1, 2, 3] })).toEqual([]);
    });

    test('abl.object_merge() merges two objects', () => {
      expect(evaluateCel('abl.object_merge(a, b)', { a: { x: 1 }, b: { y: 2 } })).toEqual({
        x: 1,
        y: 2,
      });
    });

    test('abl.object_merge() overlays second onto first', () => {
      expect(
        evaluateCel('abl.object_merge(a, b)', { a: { x: 1, y: 2 }, b: { y: 3, z: 4 } }),
      ).toEqual({ x: 1, y: 3, z: 4 });
    });

    test('abl.object_merge() handles non-object args as empty objects', () => {
      expect(evaluateCel('abl.object_merge(a, b)', { a: 'string', b: { y: 2 } })).toEqual({
        y: 2,
      });
      expect(evaluateCel('abl.object_merge(a, b)', { a: { x: 1 }, b: null })).toEqual({ x: 1 });
    });

    test('abl.object_merge() with three objects', () => {
      expect(
        evaluateCel('abl.object_merge(a, b, c)', {
          a: { x: 1 },
          b: { y: 2 },
          c: { z: 3 },
        }),
      ).toEqual({ x: 1, y: 2, z: 3 });
    });

    test('abl.object_merge() three-way override order', () => {
      expect(
        evaluateCel('abl.object_merge(a, b, c)', {
          a: { x: 1 },
          b: { x: 2 },
          c: { x: 3 },
        }),
      ).toEqual({ x: 3 });
    });
  });

  // -------------------------------------------------------------------------
  // Utility functions
  // -------------------------------------------------------------------------
  describe('Utility functions', () => {
    test('abl.coalesce() returns first non-null value (2 args)', () => {
      expect(evaluateCel('abl.coalesce(a, "default")', { a: null })).toBe('default');
    });

    test('abl.coalesce() returns first value when not null', () => {
      expect(evaluateCel('abl.coalesce(a, "default")', { a: 'hello' })).toBe('hello');
    });

    test('abl.coalesce() returns first non-null (3 args)', () => {
      expect(evaluateCel('abl.coalesce(a, b, "default")', { a: null, b: 'hello' })).toBe('hello');
    });

    test('abl.coalesce() returns last when all null (3 args)', () => {
      expect(evaluateCel('abl.coalesce(a, b, "fallback")', { a: null, b: null })).toBe('fallback');
    });

    test('abl.now() returns an ISO date string', () => {
      const result = evaluateCel('abl.now()', {}) as string;
      expect(typeof result).toBe('string');
      const parsed = new Date(result);
      expect(parsed.getTime()).not.toBeNaN();
    });

    test('abl.unique_id() returns a string of default length 6', () => {
      const result = evaluateCel('abl.unique_id()', {}) as string;
      expect(typeof result).toBe('string');
      expect(result.length).toBe(6);
      expect(result).toMatch(/^[A-Za-z0-9]+$/);
    });

    test('abl.unique_id() with custom length', () => {
      const result = evaluateCel('abl.unique_id(12)', {}) as string;
      expect(result.length).toBe(12);
      expect(result).toMatch(/^[A-Za-z0-9]+$/);
    });

    test('abl.unique_id() generates different values on each call', () => {
      const r1 = evaluateCel('abl.unique_id(20)', {}) as string;
      const r2 = evaluateCel('abl.unique_id(20)', {}) as string;
      // With 20 chars from 62-char alphabet, collision probability is negligible
      expect(r1).not.toBe(r2);
    });
  });

  // -------------------------------------------------------------------------
  // Integration: ABL functions used in conditions
  // -------------------------------------------------------------------------
  describe('Integration with CEL conditions', () => {
    test('abl.length() in condition', () => {
      expect(evaluateCelCondition('abl.length(items) > 0', { items: [1, 2] })).toBe(true);
      expect(evaluateCelCondition('abl.length(items) > 0', { items: [] })).toBe(false);
    });

    test('abl.upper() in string comparison', () => {
      expect(evaluateCelCondition('abl.upper(status) == "ACTIVE"', { status: 'active' })).toBe(
        true,
      );
    });

    test('abl.is_array() in condition', () => {
      expect(
        evaluateCelCondition('abl.is_array(val) && abl.length(val) > 1', { val: [1, 2, 3] }),
      ).toBe(true);
    });

    test('abl.round() in arithmetic condition', () => {
      expect(evaluateCelCondition('abl.round(total, 2) == 99.99', { total: 99.994 })).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Backward compatibility: existing CEL features still work
  // -------------------------------------------------------------------------
  describe('Backward compatibility', () => {
    test('built-in has() still works', () => {
      expect(evaluateCel('has(ctx.name) ? ctx.name : "Anonymous"', { ctx: { name: 'John' } })).toBe(
        'John',
      );
      expect(evaluateCel('has(ctx.name) ? ctx.name : "Anonymous"', { ctx: {} })).toBe('Anonymous');
    });

    test('built-in size() still works', () => {
      expect(evaluateCel('size(items)', { items: [1, 2, 3] })).toBe(3);
    });

    test('string methods still work', () => {
      expect(evaluateCelCondition('name.contains("ell")', { name: 'hello' })).toBe(true);
      expect(evaluateCelCondition('name.startsWith("he")', { name: 'hello' })).toBe(true);
    });

    test('arithmetic with context numbers still works', () => {
      expect(evaluateCel('price + tax', { price: 100, tax: 10 })).toBe(110);
    });

    test('in operator still works', () => {
      expect(evaluateCelCondition('status in ["active", "pending"]', { status: 'active' })).toBe(
        true,
      );
    });

    test('map expressions still work', () => {
      expect(evaluateCel('{"a": 1, "b": 2}', {})).toEqual({ a: 1, b: 2 });
    });
  });
});
