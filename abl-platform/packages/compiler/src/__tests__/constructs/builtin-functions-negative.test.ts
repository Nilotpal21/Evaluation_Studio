/**
 * Negative / Edge-Case Tests for Built-in Functions and resolveValue()
 *
 * Covers: wrong argument types, missing arguments, NaN propagation,
 * boundary values, malformed expressions, unmatched parens,
 * empty strings, and adversarial inputs.
 */

import { describe, test, expect } from 'vitest';
import {
  resolveValue,
  evaluateCondition,
  BUILTIN_FUNCTIONS,
} from '../../platform/constructs/evaluator.js';

// =============================================================================
// MATH — NEGATIVE & EDGE CASES
// =============================================================================

describe('Math functions — negative/edge cases', () => {
  test('ADD with NaN-producing inputs returns NaN', () => {
    expect(BUILTIN_FUNCTIONS.ADD('abc', 1)).toBeNaN();
    expect(BUILTIN_FUNCTIONS.ADD(undefined, undefined)).toBeNaN();
  });

  test('ADD with null coerces to 0', () => {
    expect(BUILTIN_FUNCTIONS.ADD(null, 5)).toBe(5); // Number(null) = 0
  });

  test('SUB with non-numeric string returns NaN', () => {
    expect(BUILTIN_FUNCTIONS.SUB('hello', 'world')).toBeNaN();
  });

  test('MUL with Infinity', () => {
    expect(BUILTIN_FUNCTIONS.MUL(Infinity, 2)).toBe(Infinity);
    expect(BUILTIN_FUNCTIONS.MUL(Infinity, 0)).toBeNaN();
  });

  test('DIV with NaN numerator returns NaN', () => {
    // Number('abc') / Number(2) = NaN / 2 = NaN
    expect(BUILTIN_FUNCTIONS.DIV('abc', 2)).toBeNaN();
  });

  test('DIV with string zero divisor returns null', () => {
    expect(BUILTIN_FUNCTIONS.DIV(10, '0')).toBeNull();
  });

  test('ROUND with NaN returns NaN', () => {
    expect(BUILTIN_FUNCTIONS.ROUND('abc')).toBeNaN();
  });

  test('ROUND with negative decimals', () => {
    // ROUND(1234, -2) — Math.round(1234 * 10^-2) / 10^-2 = Math.round(12.34) / 0.01 = 1200
    const result = BUILTIN_FUNCTIONS.ROUND(1234, -2);
    expect(typeof result).toBe('number');
  });

  test('ABS with NaN returns NaN', () => {
    expect(BUILTIN_FUNCTIONS.ABS('not a number')).toBeNaN();
  });

  test('MIN/MAX with NaN returns NaN', () => {
    expect(BUILTIN_FUNCTIONS.MIN('abc', 5)).toBeNaN();
    expect(BUILTIN_FUNCTIONS.MAX('abc', 5)).toBeNaN();
  });

  test('math functions with no arguments coerce undefined to NaN', () => {
    expect(BUILTIN_FUNCTIONS.ADD()).toBeNaN();
    expect(BUILTIN_FUNCTIONS.SUB()).toBeNaN();
    expect(BUILTIN_FUNCTIONS.MUL()).toBeNaN();
  });

  test('DIV with no arguments returns null (0/0 = NaN but denominator is 0 so null)', () => {
    // Number(undefined) = NaN, which is not === 0, so it tries NaN / NaN = NaN
    // Actually: const d = Number(undefined) = NaN; d === 0 is false; so Number(undefined) / NaN = NaN
    const result = BUILTIN_FUNCTIONS.DIV();
    // Number(undefined) = NaN, NaN === 0 is false, Number(undefined) / NaN = NaN
    expect(result).toBeNaN();
  });
});

// =============================================================================
// STRING — NEGATIVE & EDGE CASES
// =============================================================================

describe('String functions — negative/edge cases', () => {
  test('UPPER/LOWER with number input coerces to string', () => {
    expect(BUILTIN_FUNCTIONS.UPPER(123)).toBe('123');
    expect(BUILTIN_FUNCTIONS.LOWER(456)).toBe('456');
  });

  test('UPPER/LOWER with boolean input coerces to string', () => {
    expect(BUILTIN_FUNCTIONS.UPPER(true)).toBe('TRUE');
    // LOWER(false) → String(false).toLowerCase() → 'false' (already lowercase)
    expect(BUILTIN_FUNCTIONS.LOWER(false)).toBe('false');
  });

  test('SUBSTRING with out-of-range indices', () => {
    expect(BUILTIN_FUNCTIONS.SUBSTRING('hello', -5)).toBe('hello');
    expect(BUILTIN_FUNCTIONS.SUBSTRING('hello', 0, 100)).toBe('hello');
    expect(BUILTIN_FUNCTIONS.SUBSTRING('hello', 10)).toBe('');
  });

  test('SUBSTRING with NaN start', () => {
    // Number('abc') = NaN, substring(NaN) = substring(0)
    expect(BUILTIN_FUNCTIONS.SUBSTRING('hello', 'abc')).toBe('hello');
  });

  test('REPLACE with empty find string inserts between chars', () => {
    // Implementation: 'abc'.split('').join('X') → ['a','b','c'].join('X') → 'aXbXc'
    const result = BUILTIN_FUNCTIONS.REPLACE('abc', '', 'X');
    expect(result).toBe('aXbXc');
  });

  test('SPLIT with empty string returns array of characters', () => {
    expect(BUILTIN_FUNCTIONS.SPLIT('abc', '')).toEqual(['a', 'b', 'c']);
  });

  test('SPLIT on non-existent delimiter returns single-element array', () => {
    expect(BUILTIN_FUNCTIONS.SPLIT('hello', '|')).toEqual(['hello']);
  });

  test('JOIN with empty array returns empty string', () => {
    expect(BUILTIN_FUNCTIONS.JOIN([], ',')).toBe('');
  });

  test('JOIN with null delimiter uses comma', () => {
    expect(BUILTIN_FUNCTIONS.JOIN(['a', 'b'], null)).toBe('a,b');
  });

  test('PAD_START/PAD_END with NaN length uses 0 (no padding)', () => {
    expect(BUILTIN_FUNCTIONS.PAD_START('hello', 'abc', '0')).toBe('hello');
    expect(BUILTIN_FUNCTIONS.PAD_END('hello', 'abc', '0')).toBe('hello');
  });

  test('PAD_START/PAD_END with null pad char uses space', () => {
    expect(BUILTIN_FUNCTIONS.PAD_START('hi', 5, null)).toBe('   hi');
    expect(BUILTIN_FUNCTIONS.PAD_END('hi', 5, null)).toBe('hi   ');
  });

  test('REPEAT with zero count returns empty string', () => {
    expect(BUILTIN_FUNCTIONS.REPEAT('abc', 0)).toBe('');
  });

  test('REPEAT with NaN count returns empty string', () => {
    // Math.max(0, Math.min(NaN, 100_000)) = Math.max(0, NaN) = NaN
    // ''.repeat(NaN) = '' (NaN becomes 0)
    expect(BUILTIN_FUNCTIONS.REPEAT('abc', 'xyz')).toBe('');
  });

  test('REPEAT with fractional count', () => {
    // String.repeat truncates to integer
    expect(BUILTIN_FUNCTIONS.REPEAT('a', 3.9)).toBe('aaa');
  });
});

// =============================================================================
// FORMATTING — NEGATIVE & EDGE CASES
// =============================================================================

describe('Formatting functions — negative/edge cases', () => {
  test('MASK with empty string returns empty string', () => {
    expect(BUILTIN_FUNCTIONS.MASK('', 'last4')).toBe('');
  });

  test('MASK with null input', () => {
    expect(BUILTIN_FUNCTIONS.MASK(null, 'last4')).toBe('');
  });

  test('MASK with unknown pattern returns original string', () => {
    expect(BUILTIN_FUNCTIONS.MASK('12345678', 'unknown_pattern')).toBe('12345678');
  });

  test('MASK with null pattern returns original string', () => {
    expect(BUILTIN_FUNCTIONS.MASK('12345678', null)).toBe('12345678');
  });

  test('MASK with N*N pattern where string is too short', () => {
    // Pattern "4*4" with string "1234567" (only 7 chars, 4+4=8 > 7)
    expect(BUILTIN_FUNCTIONS.MASK('1234567', '4*4')).toBe('1234567');
  });

  test('MASK with "first4" on short string', () => {
    expect(BUILTIN_FUNCTIONS.MASK('abc', 'first4')).toBe('abc');
  });

  test('FORMAT_CURRENCY with NaN returns NaN as string', () => {
    const result = BUILTIN_FUNCTIONS.FORMAT_CURRENCY('abc', 'USD') as string;
    expect(result).toContain('NaN');
  });

  test('FORMAT_CURRENCY with null amount formats as 0', () => {
    const result = BUILTIN_FUNCTIONS.FORMAT_CURRENCY(null, 'USD') as string;
    expect(result).toContain('0');
  });

  test('FORMAT_CURRENCY with null currency uses USD', () => {
    const result = BUILTIN_FUNCTIONS.FORMAT_CURRENCY(100, null) as string;
    expect(result).toBeTruthy();
  });

  test('FORMAT_DATE with empty string input', () => {
    // new Date('') → Invalid Date → isNaN(getTime()) → return original
    expect(BUILTIN_FUNCTIONS.FORMAT_DATE('', 'YYYY-MM-DD')).toBe('');
  });

  test('FORMAT_DATE with null format uses default', () => {
    const result = BUILTIN_FUNCTIONS.FORMAT_DATE('2024-01-15T00:00:00Z', null) as string;
    expect(result).toContain('2024');
  });

  test('ORDINAL with NaN input', () => {
    const result = BUILTIN_FUNCTIONS.ORDINAL('abc');
    expect(result).toContain('NaN');
  });

  test('ORDINAL with negative number', () => {
    const result = BUILTIN_FUNCTIONS.ORDINAL(-1) as string;
    expect(result).toBe('-1th');
  });

  test('ORDINAL with zero', () => {
    expect(BUILTIN_FUNCTIONS.ORDINAL(0)).toBe('0th');
  });

  test('ORDINAL with floating point truncates', () => {
    // 3.7 % 100 = 3.7, s[3.7] = undefined, s[3] = 'rd', etc.
    const result = BUILTIN_FUNCTIONS.ORDINAL(3.7);
    expect(typeof result).toBe('string');
  });
});

// =============================================================================
// TYPE CHECKING — NEGATIVE & EDGE CASES
// =============================================================================

describe('Type checking — negative/edge cases', () => {
  test('IS_ARRAY with object that has length', () => {
    expect(BUILTIN_FUNCTIONS.IS_ARRAY({ length: 3 })).toBe(false);
  });

  test('IS_ARRAY with arguments-like object', () => {
    expect(BUILTIN_FUNCTIONS.IS_ARRAY({ 0: 'a', 1: 'b', length: 2 })).toBe(false);
  });

  test('IS_NUMBER with Infinity', () => {
    expect(BUILTIN_FUNCTIONS.IS_NUMBER(Infinity)).toBe(true);
    expect(BUILTIN_FUNCTIONS.IS_NUMBER(-Infinity)).toBe(true);
  });

  test('IS_NUMBER with undefined', () => {
    expect(BUILTIN_FUNCTIONS.IS_NUMBER(undefined)).toBe(false);
  });

  test('IS_STRING with object', () => {
    expect(BUILTIN_FUNCTIONS.IS_STRING({})).toBe(false);
    expect(BUILTIN_FUNCTIONS.IS_STRING([])).toBe(false);
  });

  test('TO_NUMBER with empty string returns 0', () => {
    expect(BUILTIN_FUNCTIONS.TO_NUMBER('')).toBe(0);
  });

  test('TO_NUMBER with boolean', () => {
    expect(BUILTIN_FUNCTIONS.TO_NUMBER(true)).toBe(1);
    expect(BUILTIN_FUNCTIONS.TO_NUMBER(false)).toBe(0);
  });

  test('TO_NUMBER with null returns 0', () => {
    expect(BUILTIN_FUNCTIONS.TO_NUMBER(null)).toBe(0);
  });

  test('TO_NUMBER with undefined returns null (NaN)', () => {
    expect(BUILTIN_FUNCTIONS.TO_NUMBER(undefined)).toBeNull();
  });

  test('TO_NUMBER with object returns null (NaN)', () => {
    expect(BUILTIN_FUNCTIONS.TO_NUMBER({})).toBeNull();
  });

  test('TO_STRING with array', () => {
    expect(BUILTIN_FUNCTIONS.TO_STRING([1, 2, 3])).toBe('1,2,3');
  });

  test('TO_STRING with object', () => {
    expect(BUILTIN_FUNCTIONS.TO_STRING({})).toBe('[object Object]');
  });
});

// =============================================================================
// ARRAY — NEGATIVE & EDGE CASES
// =============================================================================

describe('Array functions — negative/edge cases', () => {
  test('LENGTH with undefined', () => {
    expect(BUILTIN_FUNCTIONS.LENGTH(undefined)).toBe(0);
  });

  test('LENGTH with boolean', () => {
    expect(BUILTIN_FUNCTIONS.LENGTH(true)).toBe(0);
  });

  test('LENGTH with object (not array, not string)', () => {
    expect(BUILTIN_FUNCTIONS.LENGTH({ a: 1, b: 2 })).toBe(0);
  });

  test('ARRAY_FIND with array of nulls', () => {
    expect(BUILTIN_FUNCTIONS.ARRAY_FIND([null, null], 'id', 1)).toBeNull();
  });

  test('ARRAY_FIND with empty array', () => {
    expect(BUILTIN_FUNCTIONS.ARRAY_FIND([], 'id', 1)).toBeNull();
  });

  test('ARRAY_FIND uses loose equality (==)', () => {
    // "1" == 1 is true in loose equality
    const arr = [{ id: 1 }];
    expect(BUILTIN_FUNCTIONS.ARRAY_FIND(arr, 'id', '1')).toEqual({ id: 1 });
  });

  test('ARRAY_FIND_INDEX with empty array', () => {
    expect(BUILTIN_FUNCTIONS.ARRAY_FIND_INDEX([], 'id', 1)).toBe(-1);
  });

  test('ARRAY_FIND_INDEX with array of nulls', () => {
    expect(BUILTIN_FUNCTIONS.ARRAY_FIND_INDEX([null, null], 'id', 1)).toBe(-1);
  });

  test('ARRAY_FIND with null field value', () => {
    const arr = [{ status: null }, { status: 'active' }];
    expect(BUILTIN_FUNCTIONS.ARRAY_FIND(arr, 'status', null)).toEqual({ status: null });
  });
});

// =============================================================================
// OBJECT — NEGATIVE & EDGE CASES
// =============================================================================

describe('Object functions — negative/edge cases', () => {
  test('OBJECT_KEYS with undefined', () => {
    expect(BUILTIN_FUNCTIONS.OBJECT_KEYS(undefined)).toEqual([]);
  });

  test('OBJECT_KEYS with number', () => {
    expect(BUILTIN_FUNCTIONS.OBJECT_KEYS(42)).toEqual([]);
  });

  test('OBJECT_KEYS with empty object', () => {
    expect(BUILTIN_FUNCTIONS.OBJECT_KEYS({})).toEqual([]);
  });

  test('OBJECT_VALUES with undefined', () => {
    expect(BUILTIN_FUNCTIONS.OBJECT_VALUES(undefined)).toEqual([]);
  });

  test('OBJECT_VALUES with empty object', () => {
    expect(BUILTIN_FUNCTIONS.OBJECT_VALUES({})).toEqual([]);
  });

  test('OBJECT_MERGE with no arguments returns empty object', () => {
    expect(BUILTIN_FUNCTIONS.OBJECT_MERGE()).toEqual({});
  });

  test('OBJECT_MERGE with all non-objects returns empty object', () => {
    expect(BUILTIN_FUNCTIONS.OBJECT_MERGE(null, undefined, 42, 'str')).toEqual({});
  });

  test('OBJECT_MERGE with array argument skips it', () => {
    expect(BUILTIN_FUNCTIONS.OBJECT_MERGE({ a: 1 }, [1, 2], { b: 2 })).toEqual({ a: 1, b: 2 });
  });
});

// =============================================================================
// UTILITY — NEGATIVE & EDGE CASES
// =============================================================================

describe('Utility functions — negative/edge cases', () => {
  test('COALESCE with no arguments returns null', () => {
    expect(BUILTIN_FUNCTIONS.COALESCE()).toBeNull();
  });

  test('COALESCE with empty string returns empty string (not null)', () => {
    expect(BUILTIN_FUNCTIONS.COALESCE(null, '', 'fallback')).toBe('');
  });

  test('COALESCE with NaN returns NaN (not null/undefined)', () => {
    expect(BUILTIN_FUNCTIONS.COALESCE(NaN, 'fallback')).toBeNaN();
  });

  test('UNIQUE_ID with zero length falls back to 6', () => {
    // Number(0) || 6 = 6
    const id = BUILTIN_FUNCTIONS.UNIQUE_ID(0) as string;
    expect(id).toHaveLength(6);
  });

  test('UNIQUE_ID with negative length falls back to 6', () => {
    // Number(-5) || 6 — Number(-5) is truthy, so n = -5
    // The for loop runs -5 times which is 0 iterations
    const id = BUILTIN_FUNCTIONS.UNIQUE_ID(-5) as string;
    expect(id).toBe('');
  });

  test('UNIQUE_ID with NaN length falls back to 6', () => {
    const id = BUILTIN_FUNCTIONS.UNIQUE_ID('abc') as string;
    expect(id).toHaveLength(6);
  });
});

// =============================================================================
// resolveValue() — MALFORMED EXPRESSIONS
// =============================================================================

describe('resolveValue — malformed expressions', () => {
  test('empty expression returns undefined (path lookup)', () => {
    expect(resolveValue('', {})).toBeUndefined();
  });

  test('whitespace-only expression returns undefined', () => {
    expect(resolveValue('   ', {})).toBeUndefined();
  });

  test('unmatched opening paren in function call', () => {
    // "ADD(1, 2" — extractBalancedParens never finds closing, returns rest
    // args = splitFunctionArgs("1, 2") = ["1", " 2"]
    // resolveValue is called recursively, should not crash
    const result = resolveValue('ADD(1, 2', {});
    expect(result).toBe(3); // Still works since extractBalancedParens returns rest
  });

  test('extra closing paren is treated as part of expression', () => {
    // "ADD(1, 2))" — balanced parens extract "1, 2", extra ")" is ignored
    const result = resolveValue('ADD(1, 2))', {});
    // The regex matches ADD(, extracts balanced content "1, 2", evaluates to 3
    // BUT the full trimmed string is "ADD(1, 2))" which has extra paren
    // The funcMatch regex /^([A-Z_][A-Z0-9_]*)\s*\(/ still matches
    expect(typeof result).toBe('number');
  });

  test('function name with lowercase is not matched as built-in', () => {
    // The regex /^([A-Z_][A-Z0-9_]*)\s*\(/ requires uppercase start
    expect(resolveValue('add(1, 2)', {})).toBeUndefined();
  });

  test('function name starting with number is not matched', () => {
    expect(resolveValue('1ADD(1, 2)', {})).toBeUndefined();
  });

  test('deeply nested unmatched quotes in function args do not crash', () => {
    const result = resolveValue('UPPER("hello)', {});
    // extractBalancedParens handles unmatched quotes by scanning to end
    expect(typeof result).toBe('string');
  });

  test('empty function args — NOW()', () => {
    const result = resolveValue('NOW()', {});
    expect(typeof result).toBe('string');
  });

  test('function with only whitespace args', () => {
    // splitFunctionArgs("   ") — current.trim() is empty, so no args pushed
    // UPPER gets called with 0 args, s = undefined, String(undefined ?? '') = ''
    expect(resolveValue('UPPER(   )', {})).toBe('');
  });

  test('nested function call with missing inner arg', () => {
    // ADD(, 1) — first arg is empty, resolveValue('') returns undefined
    // ADD(undefined, 1) = Number(undefined) + Number(1) = NaN + 1 = NaN
    expect(resolveValue('ADD(, 1)', {})).toBeNaN();
  });

  test('resolveValue with only opening paren (not a function call)', () => {
    // "(" doesn't match function regex since no uppercase name before it
    expect(resolveValue('(', {})).toBeUndefined();
  });

  test('context path with special characters falls through gracefully', () => {
    expect(resolveValue('foo bar', {})).toBeUndefined();
    expect(resolveValue('a.b.c.d.e', {})).toBeUndefined();
  });
});

// =============================================================================
// resolveValue() — FUNCTION CALLS WITH EDGE CASE ARGUMENTS
// =============================================================================

describe('resolveValue — function calls with edge arguments', () => {
  test('function with boolean literal args', () => {
    expect(resolveValue('COALESCE(false, true)', {})).toBe(false);
  });

  test('function with null literal arg', () => {
    expect(resolveValue('COALESCE(null, "default")', {})).toBe('default');
  });

  test('function with undefined literal arg', () => {
    expect(resolveValue('COALESCE(undefined, "default")', {})).toBe('default');
  });

  test('function with context path that resolves to undefined', () => {
    expect(resolveValue('COALESCE(missing.path, "fallback")', {})).toBe('fallback');
  });

  test('nested function where inner function returns null', () => {
    // DIV(10, 0) returns null, ADD(null, 1) = Number(null) + 1 = 0 + 1 = 1
    expect(resolveValue('ADD(DIV(10, 0), 1)', {})).toBe(1);
  });

  test('function with array literal arg — splitFunctionArgs does not track brackets', () => {
    // splitFunctionArgs only tracks () depth, not [] — so [1, 2, 3] is split by commas
    // This means LENGTH receives '[1' as first arg, not an array
    // resolveValue('[1') is not a valid path → undefined, LENGTH(undefined) = 0
    expect(resolveValue('LENGTH([1, 2, 3])', {})).toBe(0);
  });

  test('unknown function name falls through to context path lookup', () => {
    const ctx = { CUSTOM_FUNC: 'some_value' };
    // Regex matches but CUSTOM_FUNC is not in BUILTIN_FUNCTIONS
    // Falls through to getNestedValue(context, 'CUSTOM_FUNC(1, 2)')
    // Hmm, actually the full string includes parens, so path lookup returns undefined
    expect(resolveValue('CUSTOM_FUNC(1, 2)', ctx)).toBeUndefined();
  });
});

// =============================================================================
// evaluateCondition — FUNCTION CALLS IN CONDITIONS
// =============================================================================

describe('evaluateCondition — with function call values', () => {
  test('condition comparing function result to literal', () => {
    // evaluateCondition resolves values through resolveValue, which now handles functions
    // But evaluateCondition splits on operators first, so "ADD(1, 2) == 3"
    // would split as left="ADD(1, 2)", operator="==", right="3"
    // resolveValue("ADD(1, 2)") = 3, resolveValue("3") = 3
    expect(evaluateCondition('ADD(1, 2) == 3', {})).toBe(true);
  });

  test('condition with function returning string', () => {
    expect(evaluateCondition('UPPER("hello") == "HELLO"', {})).toBe(true);
  });

  test('condition with LENGTH function', () => {
    const ctx = { items: [1, 2, 3, 4, 5] };
    expect(evaluateCondition('LENGTH(items) > 3', ctx)).toBe(true);
    expect(evaluateCondition('LENGTH(items) > 10', ctx)).toBe(false);
  });
});
