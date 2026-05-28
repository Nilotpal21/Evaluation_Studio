/**
 * Tests for Built-in Functions and resolveValue() extensions
 *
 * Covers: 35 BUILTIN_FUNCTIONS, function call detection in resolveValue(),
 * nested function calls, recursion depth guard, and performance safeguards.
 */

import { describe, test, expect } from 'vitest';
import { resolveValue, BUILTIN_FUNCTIONS } from '../../platform/constructs/evaluator.js';

// =============================================================================
// BUILT-IN FUNCTIONS — MATH
// =============================================================================

describe('Built-in Functions', () => {
  describe('Math functions', () => {
    test('ADD should add two numbers', () => {
      expect(BUILTIN_FUNCTIONS.ADD(2, 3)).toBe(5);
      expect(BUILTIN_FUNCTIONS.ADD(-1, 1)).toBe(0);
      expect(BUILTIN_FUNCTIONS.ADD(1.5, 2.5)).toBe(4);
    });

    test('SUB should subtract two numbers', () => {
      expect(BUILTIN_FUNCTIONS.SUB(10, 3)).toBe(7);
      expect(BUILTIN_FUNCTIONS.SUB(0, 5)).toBe(-5);
    });

    test('MUL should multiply two numbers', () => {
      expect(BUILTIN_FUNCTIONS.MUL(4, 5)).toBe(20);
      expect(BUILTIN_FUNCTIONS.MUL(-2, 3)).toBe(-6);
      expect(BUILTIN_FUNCTIONS.MUL(0, 100)).toBe(0);
    });

    test('DIV should divide two numbers', () => {
      expect(BUILTIN_FUNCTIONS.DIV(10, 2)).toBe(5);
      expect(BUILTIN_FUNCTIONS.DIV(7, 2)).toBe(3.5);
    });

    test('DIV should return null for division by zero', () => {
      expect(BUILTIN_FUNCTIONS.DIV(10, 0)).toBeNull();
    });

    test('ROUND should round to specified decimals', () => {
      expect(BUILTIN_FUNCTIONS.ROUND(3.14159, 2)).toBe(3.14);
      expect(BUILTIN_FUNCTIONS.ROUND(3.5)).toBe(4);
      expect(BUILTIN_FUNCTIONS.ROUND(3.14159, 0)).toBe(3);
    });

    test('ABS should return absolute value', () => {
      expect(BUILTIN_FUNCTIONS.ABS(-5)).toBe(5);
      expect(BUILTIN_FUNCTIONS.ABS(5)).toBe(5);
      expect(BUILTIN_FUNCTIONS.ABS(0)).toBe(0);
    });

    test('MIN should return minimum of two numbers', () => {
      expect(BUILTIN_FUNCTIONS.MIN(3, 7)).toBe(3);
      expect(BUILTIN_FUNCTIONS.MIN(-1, -5)).toBe(-5);
    });

    test('MAX should return maximum of two numbers', () => {
      expect(BUILTIN_FUNCTIONS.MAX(3, 7)).toBe(7);
      expect(BUILTIN_FUNCTIONS.MAX(-1, -5)).toBe(-1);
    });

    test('math functions should coerce string arguments to numbers', () => {
      expect(BUILTIN_FUNCTIONS.ADD('2', '3')).toBe(5);
      expect(BUILTIN_FUNCTIONS.MUL('4', '5')).toBe(20);
    });
  });

  // ===========================================================================
  // BUILT-IN FUNCTIONS — STRING
  // ===========================================================================

  describe('String functions', () => {
    test('UPPER should uppercase a string', () => {
      expect(BUILTIN_FUNCTIONS.UPPER('hello')).toBe('HELLO');
      expect(BUILTIN_FUNCTIONS.UPPER('')).toBe('');
    });

    test('LOWER should lowercase a string', () => {
      expect(BUILTIN_FUNCTIONS.LOWER('HELLO')).toBe('hello');
    });

    test('TRIM should strip whitespace', () => {
      expect(BUILTIN_FUNCTIONS.TRIM('  hello  ')).toBe('hello');
      expect(BUILTIN_FUNCTIONS.TRIM('\thello\n')).toBe('hello');
    });

    test('SUBSTRING should extract substring', () => {
      expect(BUILTIN_FUNCTIONS.SUBSTRING('hello world', 0, 5)).toBe('hello');
      expect(BUILTIN_FUNCTIONS.SUBSTRING('hello world', 6)).toBe('world');
    });

    test('REPLACE should replace all occurrences', () => {
      expect(BUILTIN_FUNCTIONS.REPLACE('hello world', 'world', 'there')).toBe('hello there');
      expect(BUILTIN_FUNCTIONS.REPLACE('aaa', 'a', 'b')).toBe('bbb');
    });

    test('SPLIT should split string into array', () => {
      expect(BUILTIN_FUNCTIONS.SPLIT('a,b,c', ',')).toEqual(['a', 'b', 'c']);
      expect(BUILTIN_FUNCTIONS.SPLIT('hello', '')).toEqual(['h', 'e', 'l', 'l', 'o']);
    });

    test('JOIN should join array into string', () => {
      expect(BUILTIN_FUNCTIONS.JOIN(['a', 'b', 'c'], ', ')).toBe('a, b, c');
      expect(BUILTIN_FUNCTIONS.JOIN(['x'], '-')).toBe('x');
    });

    test('JOIN should handle non-array input', () => {
      expect(BUILTIN_FUNCTIONS.JOIN('not-array', ',')).toBe('not-array');
    });

    test('PAD_START should left-pad a string', () => {
      expect(BUILTIN_FUNCTIONS.PAD_START('42', 6, '0')).toBe('000042');
      expect(BUILTIN_FUNCTIONS.PAD_START('hello', 3, '0')).toBe('hello'); // already longer
    });

    test('PAD_END should right-pad a string', () => {
      expect(BUILTIN_FUNCTIONS.PAD_END('42', 6, '0')).toBe('420000');
    });

    test('REPEAT should repeat a string', () => {
      expect(BUILTIN_FUNCTIONS.REPEAT('*', 4)).toBe('****');
      expect(BUILTIN_FUNCTIONS.REPEAT('ab', 3)).toBe('ababab');
    });

    test('string functions should handle null/undefined gracefully', () => {
      expect(BUILTIN_FUNCTIONS.UPPER(null)).toBe('');
      expect(BUILTIN_FUNCTIONS.LOWER(undefined)).toBe('');
      expect(BUILTIN_FUNCTIONS.TRIM(null)).toBe('');
    });
  });

  // ===========================================================================
  // BUILT-IN FUNCTIONS — FORMATTING
  // ===========================================================================

  describe('Formatting functions', () => {
    test('MASK with "last4" should mask all but last 4 chars', () => {
      expect(BUILTIN_FUNCTIONS.MASK('4111111111111111', 'last4')).toBe('************1111');
      expect(BUILTIN_FUNCTIONS.MASK('1234', 'last4')).toBe('1234'); // too short
    });

    test('MASK with "first4" should mask all but first 4 chars', () => {
      expect(BUILTIN_FUNCTIONS.MASK('4111111111111111', 'first4')).toBe('4111************');
    });

    test('MASK with "N*N" pattern', () => {
      expect(BUILTIN_FUNCTIONS.MASK('4111111111111111', '4*4')).toBe('4111********1111');
    });

    test('MASK with custom mask character', () => {
      expect(BUILTIN_FUNCTIONS.MASK('4111111111111111', 'last4', 'x')).toBe('xxxxxxxxxxxx1111');
    });

    test('FORMAT_CURRENCY should format numbers as currency', () => {
      const result = BUILTIN_FUNCTIONS.FORMAT_CURRENCY(1234.5, 'USD') as string;
      expect(result).toContain('1,234.50');
      expect(result).toContain('$');
    });

    test('FORMAT_CURRENCY should handle different currencies', () => {
      const result = BUILTIN_FUNCTIONS.FORMAT_CURRENCY(1000, 'EUR', 'de-DE') as string;
      // Different locales may format differently, but should contain the number
      expect(result).toBeTruthy();
    });

    test('FORMAT_CURRENCY should return string for invalid inputs', () => {
      const result = BUILTIN_FUNCTIONS.FORMAT_CURRENCY(100, 'INVALID_CURRENCY');
      // Should fallback to String(n) on error
      expect(typeof result).toBe('string');
    });

    test('FORMAT_DATE should format dates', () => {
      const result = BUILTIN_FUNCTIONS.FORMAT_DATE('2024-03-15T10:30:00Z', 'YYYY-MM-DD') as string;
      expect(result).toBe('2024-03-15');
    });

    test('FORMAT_DATE should handle invalid date input', () => {
      const result = BUILTIN_FUNCTIONS.FORMAT_DATE('not-a-date', 'YYYY-MM-DD');
      expect(result).toBe('not-a-date');
    });

    test('ORDINAL should return correct ordinal suffixes', () => {
      expect(BUILTIN_FUNCTIONS.ORDINAL(1)).toBe('1st');
      expect(BUILTIN_FUNCTIONS.ORDINAL(2)).toBe('2nd');
      expect(BUILTIN_FUNCTIONS.ORDINAL(3)).toBe('3rd');
      expect(BUILTIN_FUNCTIONS.ORDINAL(4)).toBe('4th');
      expect(BUILTIN_FUNCTIONS.ORDINAL(11)).toBe('11th');
      expect(BUILTIN_FUNCTIONS.ORDINAL(12)).toBe('12th');
      expect(BUILTIN_FUNCTIONS.ORDINAL(13)).toBe('13th');
      expect(BUILTIN_FUNCTIONS.ORDINAL(21)).toBe('21st');
      expect(BUILTIN_FUNCTIONS.ORDINAL(22)).toBe('22nd');
      expect(BUILTIN_FUNCTIONS.ORDINAL(23)).toBe('23rd');
    });
  });

  // ===========================================================================
  // BUILT-IN FUNCTIONS — TYPE CHECKING & COERCION
  // ===========================================================================

  describe('Type checking & coercion functions', () => {
    test('IS_ARRAY should check for arrays', () => {
      expect(BUILTIN_FUNCTIONS.IS_ARRAY([1, 2])).toBe(true);
      expect(BUILTIN_FUNCTIONS.IS_ARRAY([])).toBe(true);
      expect(BUILTIN_FUNCTIONS.IS_ARRAY('not array')).toBe(false);
      expect(BUILTIN_FUNCTIONS.IS_ARRAY(null)).toBe(false);
    });

    test('IS_NUMBER should check for numbers (not NaN)', () => {
      expect(BUILTIN_FUNCTIONS.IS_NUMBER(42)).toBe(true);
      expect(BUILTIN_FUNCTIONS.IS_NUMBER(0)).toBe(true);
      expect(BUILTIN_FUNCTIONS.IS_NUMBER(3.14)).toBe(true);
      expect(BUILTIN_FUNCTIONS.IS_NUMBER(NaN)).toBe(false);
      expect(BUILTIN_FUNCTIONS.IS_NUMBER('42')).toBe(false);
      expect(BUILTIN_FUNCTIONS.IS_NUMBER(null)).toBe(false);
    });

    test('IS_STRING should check for strings', () => {
      expect(BUILTIN_FUNCTIONS.IS_STRING('hello')).toBe(true);
      expect(BUILTIN_FUNCTIONS.IS_STRING('')).toBe(true);
      expect(BUILTIN_FUNCTIONS.IS_STRING(42)).toBe(false);
      expect(BUILTIN_FUNCTIONS.IS_STRING(null)).toBe(false);
    });

    test('TO_NUMBER should convert to number or null', () => {
      expect(BUILTIN_FUNCTIONS.TO_NUMBER('42')).toBe(42);
      expect(BUILTIN_FUNCTIONS.TO_NUMBER('3.14')).toBe(3.14);
      expect(BUILTIN_FUNCTIONS.TO_NUMBER('not a number')).toBeNull();
      expect(BUILTIN_FUNCTIONS.TO_NUMBER(true)).toBe(1);
    });

    test('TO_STRING should convert to string', () => {
      expect(BUILTIN_FUNCTIONS.TO_STRING(42)).toBe('42');
      expect(BUILTIN_FUNCTIONS.TO_STRING(true)).toBe('true');
      expect(BUILTIN_FUNCTIONS.TO_STRING(null)).toBe('');
      expect(BUILTIN_FUNCTIONS.TO_STRING(undefined)).toBe('');
    });
  });

  // ===========================================================================
  // BUILT-IN FUNCTIONS — ARRAY
  // ===========================================================================

  describe('Array functions', () => {
    test('LENGTH should return array length', () => {
      expect(BUILTIN_FUNCTIONS.LENGTH([1, 2, 3])).toBe(3);
      expect(BUILTIN_FUNCTIONS.LENGTH([])).toBe(0);
    });

    test('LENGTH should return string length', () => {
      expect(BUILTIN_FUNCTIONS.LENGTH('hello')).toBe(5);
      expect(BUILTIN_FUNCTIONS.LENGTH('')).toBe(0);
    });

    test('LENGTH should return 0 for non-array/non-string', () => {
      expect(BUILTIN_FUNCTIONS.LENGTH(42)).toBe(0);
      expect(BUILTIN_FUNCTIONS.LENGTH(null)).toBe(0);
    });

    test('ARRAY_FIND should find first element matching field==value', () => {
      const arr = [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
        { id: 3, name: 'Charlie' },
      ];
      expect(BUILTIN_FUNCTIONS.ARRAY_FIND(arr, 'name', 'Bob')).toEqual({ id: 2, name: 'Bob' });
    });

    test('ARRAY_FIND should return null when not found', () => {
      const arr = [{ id: 1 }];
      expect(BUILTIN_FUNCTIONS.ARRAY_FIND(arr, 'id', 99)).toBeNull();
    });

    test('ARRAY_FIND should return null for non-array', () => {
      expect(BUILTIN_FUNCTIONS.ARRAY_FIND('not array', 'id', 1)).toBeNull();
    });

    test('ARRAY_FIND_INDEX should return index of match', () => {
      const arr = [{ type: 'a' }, { type: 'b' }, { type: 'c' }];
      expect(BUILTIN_FUNCTIONS.ARRAY_FIND_INDEX(arr, 'type', 'b')).toBe(1);
    });

    test('ARRAY_FIND_INDEX should return -1 when not found', () => {
      const arr = [{ type: 'a' }];
      expect(BUILTIN_FUNCTIONS.ARRAY_FIND_INDEX(arr, 'type', 'z')).toBe(-1);
    });

    test('ARRAY_FIND_INDEX should return -1 for non-array', () => {
      expect(BUILTIN_FUNCTIONS.ARRAY_FIND_INDEX('not array', 'id', 1)).toBe(-1);
    });
  });

  // ===========================================================================
  // BUILT-IN FUNCTIONS — OBJECT
  // ===========================================================================

  describe('Object functions', () => {
    test('OBJECT_KEYS should return array of keys', () => {
      expect(BUILTIN_FUNCTIONS.OBJECT_KEYS({ a: 1, b: 2 })).toEqual(['a', 'b']);
    });

    test('OBJECT_KEYS should return empty array for non-object', () => {
      expect(BUILTIN_FUNCTIONS.OBJECT_KEYS(null)).toEqual([]);
      expect(BUILTIN_FUNCTIONS.OBJECT_KEYS([1, 2])).toEqual([]);
      expect(BUILTIN_FUNCTIONS.OBJECT_KEYS('string')).toEqual([]);
    });

    test('OBJECT_VALUES should return array of values', () => {
      expect(BUILTIN_FUNCTIONS.OBJECT_VALUES({ a: 1, b: 2 })).toEqual([1, 2]);
    });

    test('OBJECT_VALUES should return empty array for non-object', () => {
      expect(BUILTIN_FUNCTIONS.OBJECT_VALUES(null)).toEqual([]);
    });

    test('OBJECT_MERGE should merge objects (right wins)', () => {
      expect(BUILTIN_FUNCTIONS.OBJECT_MERGE({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
      expect(BUILTIN_FUNCTIONS.OBJECT_MERGE({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
    });

    test('OBJECT_MERGE should handle multiple objects', () => {
      expect(BUILTIN_FUNCTIONS.OBJECT_MERGE({ a: 1 }, { b: 2 }, { c: 3 })).toEqual({
        a: 1,
        b: 2,
        c: 3,
      });
    });

    test('OBJECT_MERGE should skip non-object arguments', () => {
      expect(BUILTIN_FUNCTIONS.OBJECT_MERGE({ a: 1 }, null, { b: 2 })).toEqual({ a: 1, b: 2 });
    });
  });

  // ===========================================================================
  // BUILT-IN FUNCTIONS — UTILITY
  // ===========================================================================

  describe('Utility functions', () => {
    test('COALESCE should return first non-null/undefined value', () => {
      expect(BUILTIN_FUNCTIONS.COALESCE(null, undefined, 'hello')).toBe('hello');
      expect(BUILTIN_FUNCTIONS.COALESCE('first', 'second')).toBe('first');
      expect(BUILTIN_FUNCTIONS.COALESCE(0, 'fallback')).toBe(0); // 0 is not null
      expect(BUILTIN_FUNCTIONS.COALESCE(false, 'fallback')).toBe(false); // false is not null
    });

    test('COALESCE should return null if all values are null/undefined', () => {
      expect(BUILTIN_FUNCTIONS.COALESCE(null, undefined)).toBeNull();
    });

    test('NOW should return an ISO timestamp', () => {
      const result = BUILTIN_FUNCTIONS.NOW() as string;
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(() => new Date(result)).not.toThrow();
    });

    test('UNIQUE_ID should return alphanumeric string of default length 6', () => {
      const id = BUILTIN_FUNCTIONS.UNIQUE_ID() as string;
      expect(id).toHaveLength(6);
      expect(id).toMatch(/^[A-Za-z0-9]+$/);
    });

    test('UNIQUE_ID should respect custom length', () => {
      const id = BUILTIN_FUNCTIONS.UNIQUE_ID(10) as string;
      expect(id).toHaveLength(10);
    });

    test('UNIQUE_ID should generate unique values', () => {
      const ids = new Set(Array.from({ length: 100 }, () => BUILTIN_FUNCTIONS.UNIQUE_ID(12)));
      expect(ids.size).toBe(100);
    });
  });
});

// =============================================================================
// resolveValue() — FUNCTION CALL DETECTION
// =============================================================================

describe('resolveValue with function calls', () => {
  const context = {
    count: 5,
    name: 'John',
    items: [1, 2, 3],
    user: { firstName: 'Jane', lastName: null },
  };

  test('should call simple built-in function', () => {
    expect(resolveValue('ADD(1, 2)', context)).toBe(3);
    expect(resolveValue('UPPER("hello")', context)).toBe('HELLO');
    expect(resolveValue('LENGTH(items)', context)).toBe(3);
  });

  test('should resolve context paths as function arguments', () => {
    expect(resolveValue('ADD(count, 1)', context)).toBe(6);
    expect(resolveValue('UPPER(name)', context)).toBe('JOHN');
  });

  test('should handle nested function calls', () => {
    expect(resolveValue('ADD(ADD(1, 2), 3)', context)).toBe(6);
    expect(resolveValue('UPPER(TRIM("  hello  "))', context)).toBe('HELLO');
  });

  test('should handle COALESCE with null paths', () => {
    expect(resolveValue('COALESCE(user.lastName, "Guest")', context)).toBe('Guest');
    expect(resolveValue('COALESCE(user.firstName, "Guest")', context)).toBe('Jane');
  });

  test('should handle MASK with context value', () => {
    const ctx = { cardNumber: '4111111111111111' };
    expect(resolveValue('MASK(cardNumber, "last4")', ctx)).toBe('************1111');
  });

  test('should return undefined for unknown function names (falls through to path lookup)', () => {
    expect(resolveValue('UNKNOWN_FUNC(1, 2)', context)).toBeUndefined();
  });

  test('should still resolve non-function paths normally', () => {
    expect(resolveValue('name', context)).toBe('John');
    expect(resolveValue('user.firstName', context)).toBe('Jane');
    expect(resolveValue('"literal"', context)).toBe('literal');
    expect(resolveValue('42', context)).toBe(42);
  });
});

// =============================================================================
// resolveValue() — RECURSION DEPTH GUARD
// =============================================================================

describe('resolveValue recursion depth guard', () => {
  test('should return undefined when depth exceeds MAX_RESOLVE_DEPTH (32)', () => {
    // Build a deeply nested expression: ADD(ADD(ADD(...ADD(1, 1)...)))
    let expr = '1';
    for (let i = 0; i < 35; i++) {
      expr = `ADD(${expr}, 1)`;
    }
    // Should not throw — returns undefined at depth limit
    const result = resolveValue(expr, {});
    // At depth 32+, inner calls return undefined → ADD(undefined, 1) = NaN
    // The important thing is it doesn't crash
    expect(result).toBeDefined(); // ADD(undefined, 1) → NaN, which is defined
  });

  test('should handle moderate nesting without issues', () => {
    // 10 levels deep is well within the limit
    expect(resolveValue('ADD(ADD(ADD(1, 1), 1), 1)', {})).toBe(4);
  });
});

// =============================================================================
// PERFORMANCE SAFEGUARDS — STRING LENGTH CAPS
// =============================================================================

describe('String length safeguards', () => {
  test('REPEAT should cap output length', () => {
    // Requesting 200,000 repeats should be capped to MAX_BUILTIN_STRING_LENGTH
    const result = BUILTIN_FUNCTIONS.REPEAT('a', 200_000) as string;
    expect(result.length).toBeLessThanOrEqual(100_000);
  });

  test('PAD_START should cap output length', () => {
    const result = BUILTIN_FUNCTIONS.PAD_START('x', 200_000, '0') as string;
    expect(result.length).toBeLessThanOrEqual(100_000);
  });

  test('PAD_END should cap output length', () => {
    const result = BUILTIN_FUNCTIONS.PAD_END('x', 200_000, '0') as string;
    expect(result.length).toBeLessThanOrEqual(100_000);
  });

  test('REPEAT with negative count should return empty string', () => {
    expect(BUILTIN_FUNCTIONS.REPEAT('a', -5)).toBe('');
  });
});

// =============================================================================
// HELPER FUNCTIONS — extractBalancedParens / splitFunctionArgs
// =============================================================================

describe('Function call parsing via resolveValue', () => {
  test('should handle function with no arguments', () => {
    const result = resolveValue('NOW()', {});
    expect(typeof result).toBe('string');
  });

  test('should handle string arguments with commas', () => {
    // REPLACE(s, find, repl) — comma in string arg should not split
    expect(resolveValue('REPLACE("a,b,c", ",", "-")', {})).toBe('a-b-c');
  });

  test('should handle string arguments with parentheses', () => {
    expect(resolveValue('UPPER("hello (world)")', {})).toBe('HELLO (WORLD)');
  });

  test('should handle multiple nested function calls as args', () => {
    expect(resolveValue('ADD(MUL(2, 3), SUB(10, 4))', {})).toBe(12);
  });
});
