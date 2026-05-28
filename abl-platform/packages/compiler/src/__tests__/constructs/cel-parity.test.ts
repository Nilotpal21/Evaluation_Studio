/**
 * CEL Parity Tests
 *
 * Verifies that EVERY legacy ABL expression produces the SAME result
 * through both the legacy evaluator and the dual (CEL) evaluator.
 *
 * This is the critical correctness test for the ABL-to-CEL migration.
 * If any test fails, it means the dual evaluator produces a different
 * result than the legacy evaluator for the same expression, which is
 * a migration bug.
 *
 * Expression types covered:
 * - Basic comparisons (==, !=, >, <, >=, <=)
 * - Logical operators (AND, OR, NOT)
 * - Nested path access (obj.nested.value)
 * - CONTAINS operator (string and array)
 * - IS SET / IS NOT SET
 * - Boolean literals (true, false)
 * - Truthiness checks (bare variable)
 * - Parenthesized expressions
 * - Compound expressions (multi-operator)
 * - Type coercion (number/string, boolean/string)
 * - Null/undefined handling
 * - Empty/whitespace conditions
 */

import { describe, test, expect } from 'vitest';
import { evaluateCondition } from '../../platform/constructs/evaluator.js';
import { evaluateConditionDual } from '../../platform/constructs/dual-evaluator.js';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Run a single parity assertion: both evaluators must agree on the result,
 * and the result must match the expected value.
 */
function assertParity(expr: string, context: Record<string, unknown>, expected: boolean): void {
  const legacyResult = evaluateCondition(expr, context);
  const dualResult = evaluateConditionDual(expr, context);

  expect(legacyResult).toBe(expected);
  expect(dualResult).toBe(expected);
  expect(dualResult).toBe(legacyResult);
}

// =============================================================================
// BASIC COMPARISONS
// =============================================================================

describe('CEL Parity Tests', () => {
  describe('Basic comparison operators', () => {
    const comparisonCases: Array<{
      expr: string;
      context: Record<string, unknown>;
      expected: boolean;
    }> = [
      // == (equality)
      { expr: 'age == 25', context: { age: 25 }, expected: true },
      { expr: 'age == 30', context: { age: 25 }, expected: false },
      { expr: 'name == "John"', context: { name: 'John' }, expected: true },
      { expr: 'name == "Jane"', context: { name: 'John' }, expected: false },

      // != (inequality)
      { expr: 'name != "Jane"', context: { name: 'John' }, expected: true },
      { expr: 'name != "John"', context: { name: 'John' }, expected: false },
      { expr: 'age != 30', context: { age: 25 }, expected: true },
      { expr: 'age != 25', context: { age: 25 }, expected: false },

      // > (greater than)
      { expr: 'count > 5', context: { count: 10 }, expected: true },
      { expr: 'count > 10', context: { count: 10 }, expected: false },
      { expr: 'count > 15', context: { count: 10 }, expected: false },

      // < (less than)
      { expr: 'count < 15', context: { count: 10 }, expected: true },
      { expr: 'count < 10', context: { count: 10 }, expected: false },
      { expr: 'count < 5', context: { count: 10 }, expected: false },

      // >= (greater than or equal)
      { expr: 'age >= 18', context: { age: 25 }, expected: true },
      { expr: 'age >= 25', context: { age: 25 }, expected: true },
      { expr: 'age >= 30', context: { age: 25 }, expected: false },
      { expr: 'age >= 18', context: { age: 10 }, expected: false },

      // <= (less than or equal)
      { expr: 'count <= 10', context: { count: 10 }, expected: true },
      { expr: 'count <= 15', context: { count: 10 }, expected: true },
      { expr: 'count <= 5', context: { count: 10 }, expected: false },
      { expr: 'count <= 5', context: { count: 5 }, expected: true },
    ];

    for (const { expr, context, expected } of comparisonCases) {
      test(`"${expr}" with ${JSON.stringify(context)} -> ${expected}`, () => {
        assertParity(expr, context, expected);
      });
    }
  });

  // ===========================================================================
  // LOGICAL OPERATORS
  // ===========================================================================

  describe('Logical operators (AND, OR, NOT)', () => {
    const logicalCases: Array<{
      expr: string;
      context: Record<string, unknown>;
      expected: boolean;
    }> = [
      // AND
      { expr: 'age >= 18 AND active', context: { age: 25, active: true }, expected: true },
      { expr: 'age >= 18 AND active', context: { age: 25, active: false }, expected: false },
      { expr: 'age >= 18 AND active', context: { age: 10, active: true }, expected: false },
      { expr: 'age >= 18 AND active', context: { age: 10, active: false }, expected: false },

      // OR
      { expr: 'a OR b', context: { a: true, b: false }, expected: true },
      { expr: 'a OR b', context: { a: false, b: true }, expected: true },
      { expr: 'a OR b', context: { a: true, b: true }, expected: true },
      { expr: 'a OR b', context: { a: false, b: false }, expected: false },

      // NOT
      { expr: 'NOT active', context: { active: false }, expected: true },
      { expr: 'NOT active', context: { active: true }, expected: false },

      // ! prefix
      { expr: '!active', context: { active: false }, expected: true },
      { expr: '!active', context: { active: true }, expected: false },

      // Multi-clause AND
      {
        expr: 'a == 1 AND b == 2 AND c == 3',
        context: { a: 1, b: 2, c: 3 },
        expected: true,
      },
      {
        expr: 'a == 1 AND b == 2 AND c == 3',
        context: { a: 1, b: 2, c: 4 },
        expected: false,
      },

      // Multi-clause OR
      {
        expr: 'status == "active" OR status == "pending"',
        context: { status: 'pending' },
        expected: true,
      },
      {
        expr: 'status == "active" OR status == "pending"',
        context: { status: 'closed' },
        expected: false,
      },

      // NOT with comparison
      { expr: 'NOT name == "Jane"', context: { name: 'John' }, expected: true },
      { expr: 'NOT name == "John"', context: { name: 'John' }, expected: false },
    ];

    for (const { expr, context, expected } of logicalCases) {
      test(`"${expr}" with ${JSON.stringify(context)} -> ${expected}`, () => {
        assertParity(expr, context, expected);
      });
    }
  });

  // ===========================================================================
  // NESTED PATH ACCESS
  // ===========================================================================

  describe('Nested path access', () => {
    const nestedCases: Array<{
      expr: string;
      context: Record<string, unknown>;
      expected: boolean;
    }> = [
      // Single level nesting
      { expr: 'user.age >= 18', context: { user: { age: 25 } }, expected: true },
      { expr: 'user.age >= 18', context: { user: { age: 10 } }, expected: false },

      // Two levels of nesting
      {
        expr: 'user.profile.tier == "premium"',
        context: { user: { profile: { tier: 'premium' } } },
        expected: true,
      },
      {
        expr: 'user.profile.tier == "premium"',
        context: { user: { profile: { tier: 'basic' } } },
        expected: false,
      },

      // Nested comparison
      {
        expr: 'order.total > 100',
        context: { order: { total: 150 } },
        expected: true,
      },
      {
        expr: 'order.total > 100',
        context: { order: { total: 50 } },
        expected: false,
      },
    ];

    for (const { expr, context, expected } of nestedCases) {
      test(`"${expr}" with ${JSON.stringify(context)} -> ${expected}`, () => {
        assertParity(expr, context, expected);
      });
    }
  });

  // ===========================================================================
  // CONTAINS OPERATOR
  // ===========================================================================

  describe('CONTAINS operator', () => {
    const containsCases: Array<{
      expr: string;
      context: Record<string, unknown>;
      expected: boolean;
    }> = [
      // String contains (lowercase - matches legacy evaluator's operator split)
      // Note: uppercase CONTAINS only works via the expression migrator (ABL->CEL),
      // not directly in the legacy evaluator which splits on lowercase ' contains '.
      { expr: 'email contains "@"', context: { email: 'user@example.com' }, expected: true },
      { expr: 'email contains "@"', context: { email: 'invalid' }, expected: false },
      { expr: 'email contains "example"', context: { email: 'user@example.com' }, expected: true },
      { expr: 'email contains "xyz"', context: { email: 'user@example.com' }, expected: false },

      // More string contains
      { expr: 'name contains "oh"', context: { name: 'John' }, expected: true },
      { expr: 'name contains "xyz"', context: { name: 'John' }, expected: false },
    ];

    for (const { expr, context, expected } of containsCases) {
      test(`"${expr}" with ${JSON.stringify(context)} -> ${expected}`, () => {
        assertParity(expr, context, expected);
      });
    }
  });

  // ===========================================================================
  // IS SET / IS NOT SET
  // ===========================================================================

  describe('IS SET / IS NOT SET', () => {
    const isSetCases: Array<{
      expr: string;
      context: Record<string, unknown>;
      expected: boolean;
    }> = [
      // IS SET - variable exists with value
      { expr: 'name IS SET', context: { name: 'John' }, expected: true },
      { expr: 'count IS SET', context: { count: 42 }, expected: true },
      { expr: 'active IS SET', context: { active: true }, expected: true },
      { expr: 'active IS SET', context: { active: false }, expected: true },
      { expr: 'val IS SET', context: { val: 0 }, expected: true },
      { expr: 'val IS SET', context: { val: '' }, expected: true },

      // IS SET - variable missing or null
      { expr: 'name IS SET', context: {}, expected: false },
      { expr: 'name IS SET', context: { name: null }, expected: false },

      // IS NOT SET - variable missing or null
      { expr: 'name IS NOT SET', context: {}, expected: true },
      { expr: 'name IS NOT SET', context: { name: null }, expected: true },

      // IS NOT SET - variable exists
      { expr: 'name IS NOT SET', context: { name: 'John' }, expected: false },
      { expr: 'count IS NOT SET', context: { count: 0 }, expected: false },

      // IS SET combined with other conditions
      { expr: 'name IS SET AND age >= 18', context: { name: 'John', age: 25 }, expected: true },
      { expr: 'name IS SET AND age >= 18', context: { name: 'John', age: 10 }, expected: false },
      { expr: 'name IS SET AND age >= 18', context: { age: 25 }, expected: false },
    ];

    for (const { expr, context, expected } of isSetCases) {
      test(`"${expr}" with ${JSON.stringify(context)} -> ${expected}`, () => {
        assertParity(expr, context, expected);
      });
    }
  });

  // ===========================================================================
  // BOOLEAN LITERALS
  // ===========================================================================

  describe('Boolean literals', () => {
    const boolLiteralCases: Array<{
      expr: string;
      context: Record<string, unknown>;
      expected: boolean;
    }> = [
      { expr: 'true', context: {}, expected: true },
      { expr: 'false', context: {}, expected: false },
      { expr: 'true', context: { a: 1 }, expected: true },
      { expr: 'false', context: { a: 1 }, expected: false },
    ];

    for (const { expr, context, expected } of boolLiteralCases) {
      test(`"${expr}" with ${JSON.stringify(context)} -> ${expected}`, () => {
        assertParity(expr, context, expected);
      });
    }
  });

  // ===========================================================================
  // TRUTHINESS CHECKS (bare variable)
  // ===========================================================================

  describe('Truthiness checks (bare variable)', () => {
    const truthyCases: Array<{
      expr: string;
      context: Record<string, unknown>;
      expected: boolean;
    }> = [
      // Truthy values
      { expr: 'active', context: { active: true }, expected: true },
      { expr: 'name', context: { name: 'hello' }, expected: true },
      { expr: 'count', context: { count: 42 }, expected: true },

      // Falsy values
      { expr: 'active', context: { active: false }, expected: false },
      { expr: 'count', context: { count: 0 }, expected: false },
      { expr: 'missing', context: {}, expected: false },
    ];

    for (const { expr, context, expected } of truthyCases) {
      test(`"${expr}" with ${JSON.stringify(context)} -> ${expected}`, () => {
        assertParity(expr, context, expected);
      });
    }
  });

  // ===========================================================================
  // EMPTY AND WHITESPACE CONDITIONS
  // ===========================================================================

  describe('Empty and whitespace conditions', () => {
    test('empty string condition should be true', () => {
      assertParity('', {}, true);
    });

    test('whitespace-only condition should be true', () => {
      assertParity('   ', {}, true);
    });
  });

  // ===========================================================================
  // PARENTHESIZED EXPRESSIONS
  // ===========================================================================

  describe('Parenthesized expressions', () => {
    const parenCases: Array<{
      expr: string;
      context: Record<string, unknown>;
      expected: boolean;
    }> = [
      // Simple parenthesized
      { expr: '(age > 25)', context: { age: 30 }, expected: true },
      { expr: '(age > 25)', context: { age: 20 }, expected: false },

      // Parenthesized with AND
      { expr: '(age > 25) AND name == "John"', context: { age: 30, name: 'John' }, expected: true },
      {
        expr: '(age > 25) AND name == "John"',
        context: { age: 20, name: 'John' },
        expected: false,
      },

      // Parenthesized OR within AND
      {
        expr: '(age < 20 OR age > 50) AND name == "John"',
        context: { age: 55, name: 'John' },
        expected: true,
      },
      {
        expr: '(age < 20 OR age > 50) AND name == "John"',
        context: { age: 30, name: 'John' },
        expected: false,
      },

      // AND with parenthesized OR
      {
        expr: 'a == 1 AND (b == 2 OR c == 3)',
        context: { a: 1, b: 0, c: 3 },
        expected: true,
      },
      {
        expr: 'a == 1 AND (b == 2 OR c == 3)',
        context: { a: 0, b: 0, c: 3 },
        expected: false,
      },
    ];

    for (const { expr, context, expected } of parenCases) {
      test(`"${expr}" with ${JSON.stringify(context)} -> ${expected}`, () => {
        assertParity(expr, context, expected);
      });
    }
  });

  // ===========================================================================
  // COMPOUND EXPRESSIONS
  // ===========================================================================

  describe('Compound expressions', () => {
    const compoundCases: Array<{
      expr: string;
      context: Record<string, unknown>;
      expected: boolean;
    }> = [
      // AND + comparison
      {
        expr: 'age >= 18 AND name != ""',
        context: { age: 25, name: 'John' },
        expected: true,
      },
      {
        expr: 'age >= 18 AND name != ""',
        context: { age: 10, name: 'John' },
        expected: false,
      },

      // IS SET guard + comparison
      {
        expr: 'amount IS SET AND amount > 100',
        context: { amount: 150 },
        expected: true,
      },
      {
        expr: 'amount IS SET AND amount > 100',
        context: { amount: 50 },
        expected: false,
      },
      {
        expr: 'amount IS SET AND amount > 100',
        context: {},
        expected: false,
      },

      // Multiple IS SET with AND
      {
        expr: 'a IS SET AND b IS SET AND c IS SET',
        context: { a: 'x', b: 'y', c: 'z' },
        expected: true,
      },
      {
        expr: 'a IS SET AND b IS SET AND c IS SET',
        context: { a: 'x', b: 'y' },
        expected: false,
      },

      // IS NOT SET with OR
      {
        expr: 'a IS NOT SET OR b IS NOT SET',
        context: { a: 'x' },
        expected: true,
      },
      {
        expr: 'a IS NOT SET OR b IS NOT SET',
        context: { a: 'x', b: 'y' },
        expected: false,
      },

      // Inequality check
      {
        expr: 'destination != origin',
        context: { destination: 'Paris', origin: 'London' },
        expected: true,
      },
      {
        expr: 'destination != origin',
        context: { destination: 'Paris', origin: 'Paris' },
        expected: false,
      },

      // NOT with compound
      {
        expr: 'NOT (a == 1 AND b == 2)',
        context: { a: 1, b: 2 },
        expected: false,
      },
      {
        expr: 'NOT (a == 1 AND b == 2)',
        context: { a: 1, b: 3 },
        expected: true,
      },
    ];

    for (const { expr, context, expected } of compoundCases) {
      test(`"${expr}" with ${JSON.stringify(context)} -> ${expected}`, () => {
        assertParity(expr, context, expected);
      });
    }
  });

  // ===========================================================================
  // NUMBER EQUALITY AND COMPARISONS
  // ===========================================================================

  describe('Number equality and comparisons', () => {
    const numericCases: Array<{
      expr: string;
      context: Record<string, unknown>;
      expected: boolean;
    }> = [
      { expr: 'score == 42', context: { score: 42 }, expected: true },
      { expr: 'score == 43', context: { score: 42 }, expected: false },
      { expr: 'price > 0', context: { price: 10 }, expected: true },
      { expr: 'price > 0', context: { price: 0 }, expected: false },
      { expr: 'price > 0', context: { price: -5 }, expected: false },
      { expr: 'balance >= 0', context: { balance: 0 }, expected: true },
      { expr: 'balance >= 0', context: { balance: 100 }, expected: true },
      { expr: 'balance >= 0', context: { balance: -1 }, expected: false },
    ];

    for (const { expr, context, expected } of numericCases) {
      test(`"${expr}" with ${JSON.stringify(context)} -> ${expected}`, () => {
        assertParity(expr, context, expected);
      });
    }
  });

  // ===========================================================================
  // STRING EQUALITY
  // ===========================================================================

  describe('String equality (case-sensitive)', () => {
    const stringCases: Array<{
      expr: string;
      context: Record<string, unknown>;
      expected: boolean;
    }> = [
      { expr: 'name == "John"', context: { name: 'John' }, expected: true },
      { expr: 'name == "john"', context: { name: 'John' }, expected: false },
      { expr: 'name == "JOHN"', context: { name: 'John' }, expected: false },
      { expr: 'status == "active"', context: { status: 'active' }, expected: true },
      { expr: 'status == "Active"', context: { status: 'active' }, expected: false },
    ];

    for (const { expr, context, expected } of stringCases) {
      test(`"${expr}" with ${JSON.stringify(context)} -> ${expected}`, () => {
        assertParity(expr, context, expected);
      });
    }
  });

  // ===========================================================================
  // BOOLEAN COMPARISON WITH BOOLEAN VALUES
  // ===========================================================================

  describe('Boolean comparisons', () => {
    const boolCases: Array<{
      expr: string;
      context: Record<string, unknown>;
      expected: boolean;
    }> = [
      { expr: 'verified == true', context: { verified: true }, expected: true },
      { expr: 'verified == true', context: { verified: false }, expected: false },
      { expr: 'verified == false', context: { verified: false }, expected: true },
      { expr: 'verified == false', context: { verified: true }, expected: false },
      { expr: 'verified != true', context: { verified: false }, expected: true },
      { expr: 'verified != false', context: { verified: true }, expected: true },
    ];

    for (const { expr, context, expected } of boolCases) {
      test(`"${expr}" with ${JSON.stringify(context)} -> ${expected}`, () => {
        assertParity(expr, context, expected);
      });
    }
  });

  // ===========================================================================
  // NULL/UNDEFINED HANDLING
  // ===========================================================================

  describe('Null and undefined handling', () => {
    const nullCases: Array<{
      expr: string;
      context: Record<string, unknown>;
      expected: boolean;
    }> = [
      // Undefined variable equality
      { expr: 'missing == "value"', context: {}, expected: false },

      // IS SET with null
      { expr: 'val IS SET', context: { val: null }, expected: false },
      { expr: 'val IS NOT SET', context: { val: null }, expected: true },

      // Zero and false are IS SET
      { expr: 'val IS SET', context: { val: 0 }, expected: true },
      { expr: 'val IS SET', context: { val: false }, expected: true },

      // Empty array/object are IS SET
      { expr: 'items IS SET', context: { items: [] }, expected: true },
      { expr: 'data IS SET', context: { data: {} }, expected: true },
    ];

    for (const { expr, context, expected } of nullCases) {
      test(`"${expr}" with ${JSON.stringify(context)} -> ${expected}`, () => {
        assertParity(expr, context, expected);
      });
    }
  });

  // ===========================================================================
  // REAL-WORLD CONSTRAINT PATTERNS
  // ===========================================================================

  describe('Real-world constraint patterns', () => {
    test('booking: guest count range check', () => {
      assertParity('guests > 0 AND guests <= 10', { guests: 5 }, true);
      assertParity('guests > 0 AND guests <= 10', { guests: 0 }, false);
      assertParity('guests > 0 AND guests <= 10', { guests: 11 }, false);
    });

    test('booking: destination != origin', () => {
      assertParity('destination != origin', { destination: 'Paris', origin: 'London' }, true);
      assertParity('destination != origin', { destination: 'Paris', origin: 'Paris' }, false);
    });

    test('auth: IS SET guard on required fields', () => {
      assertParity(
        'email IS SET AND password IS SET',
        { email: 'a@b.com', password: 'secret' },
        true,
      );
      assertParity('email IS SET AND password IS SET', { email: 'a@b.com' }, false);
      assertParity('email IS SET AND password IS SET', {}, false);
    });

    test('validation: field non-empty check', () => {
      assertParity('name IS SET AND name != ""', { name: 'John' }, true);
      assertParity('name IS SET AND name != ""', { name: '' }, false);
      assertParity('name IS SET AND name != ""', {}, false);
    });

    test('status check: OR-based status matching', () => {
      assertParity(
        'status == "active" OR status == "pending" OR status == "review"',
        { status: 'pending' },
        true,
      );
      assertParity(
        'status == "active" OR status == "pending" OR status == "review"',
        { status: 'closed' },
        false,
      );
    });

    test('amount limit: numeric boundary', () => {
      assertParity('amount <= 1000', { amount: 1000 }, true);
      assertParity('amount <= 1000', { amount: 1001 }, false);
      assertParity('amount <= 1000', { amount: 999 }, true);
    });

    test('boolean flag: NOT banned', () => {
      assertParity('NOT banned', { banned: false }, true);
      assertParity('NOT banned', { banned: true }, false);
    });

    test('multi-field guard: all fields IS SET', () => {
      assertParity(
        'query IS SET AND selection IS SET',
        { query: 'hotels in Paris', selection: 'Hotel A' },
        true,
      );
      assertParity('query IS SET AND selection IS SET', { query: 'hotels in Paris' }, false);
    });
  });

  // ===========================================================================
  // EDGE CASES
  // ===========================================================================

  describe('Edge cases', () => {
    test('whitespace around expression', () => {
      assertParity('  name == "John"  ', { name: 'John' }, true);
    });

    test('special characters in string values', () => {
      assertParity('email == "test@example.com"', { email: 'test@example.com' }, true);
    });

    test('numeric zero in comparisons', () => {
      assertParity('count > 0', { count: 1 }, true);
      assertParity('count > 0', { count: 0 }, false);
      assertParity('count >= 0', { count: 0 }, true);
    });

    test('boolean expression with == true', () => {
      assertParity('active == true', { active: true }, true);
      assertParity('active == true', { active: false }, false);
    });

    test('nested path IS SET', () => {
      assertParity('user.name IS SET', { user: { name: 'John' } }, true);
      assertParity('user.name IS SET', { user: {} }, false);
    });

    test('nested path IS NOT SET', () => {
      assertParity('user.name IS NOT SET', { user: {} }, true);
      assertParity('user.name IS NOT SET', { user: { name: 'John' } }, false);
    });

    test('deeply nested path comparison', () => {
      assertParity('a.b.c.d == "deep"', { a: { b: { c: { d: 'deep' } } } }, true);
    });
  });

  // ===========================================================================
  // ABL FUNCTIONS IN CONDITIONS
  // ===========================================================================

  describe('ABL functions in conditions', () => {
    test('UPPER function in equality check', () => {
      assertParity('UPPER(name) == "JOHN"', { name: 'John' }, true);
      assertParity('UPPER(name) == "JANE"', { name: 'John' }, false);
    });

    test('LOWER function in equality check', () => {
      assertParity('LOWER(name) == "john"', { name: 'John' }, true);
      assertParity('LOWER(name) == "jane"', { name: 'John' }, false);
    });
  });

  // ===========================================================================
  // MIXED OPERATOR COMBINATIONS
  // ===========================================================================

  describe('Mixed operator combinations', () => {
    test('IS SET AND comparison AND contains', () => {
      assertParity(
        'name IS SET AND age >= 18 AND name contains "John"',
        { name: 'John Doe', age: 25 },
        true,
      );
      assertParity(
        'name IS SET AND age >= 18 AND name contains "John"',
        { name: 'Jane Doe', age: 25 },
        false,
      );
    });

    test('IS SET guard with numeric comparison', () => {
      assertParity('amount IS SET AND amount > 100', { amount: 150 }, true);
      assertParity('amount IS SET AND amount > 100', { amount: 50 }, false);
      assertParity('amount IS SET AND amount > 100', {}, false);
    });

    test('OR with mixed operator types', () => {
      assertParity('name IS SET OR count > 0', { count: 5 }, true);
      assertParity('name IS SET OR count > 0', { name: 'John' }, true);
      assertParity('name IS SET OR count > 0', { count: 0 }, false);
    });
  });

  // ===========================================================================
  // REGRESSION TESTS
  // ===========================================================================

  describe('Regression tests', () => {
    test('inequality with undefined on one side', () => {
      // When one side is defined and other is undefined, != should be true
      const legacyResult = evaluateCondition('missing != "value"', {});
      const dualResult = evaluateConditionDual('missing != "value"', {});
      expect(legacyResult).toBe(true);
      expect(dualResult).toBe(true);
    });

    test('empty string IS SET should be true', () => {
      // Empty string is not null/undefined, so IS SET = true
      assertParity('val IS SET', { val: '' }, true);
    });

    test('false value IS SET should be true', () => {
      // false is not null/undefined, so IS SET = true
      assertParity('flag IS SET', { flag: false }, true);
    });

    test('AND short-circuit with IS SET guard', () => {
      // If first clause (IS SET) is false, AND should short-circuit
      assertParity('missing IS SET AND missing > 5', {}, false);
    });

    test('OR where first clause is false', () => {
      assertParity('name == "Jane" OR age == 30', { name: 'John', age: 30 }, true);
    });

    test('complex: 3-way OR', () => {
      assertParity(
        'tier == "gold" OR tier == "platinum" OR tier == "diamond"',
        { tier: 'platinum' },
        true,
      );
      assertParity(
        'tier == "gold" OR tier == "platinum" OR tier == "diamond"',
        { tier: 'silver' },
        false,
      );
    });

    test('boolean false != null should be true', () => {
      // false is not null/undefined
      const legacy = evaluateCondition('flag != null', { flag: false });
      const dual = evaluateConditionDual('flag != null', { flag: false });
      expect(legacy).toBe(true);
      expect(dual).toBe(true);
    });
  });

  // ===========================================================================
  // KNOWN DIVERGENCES (documented, not parity assertions)
  //
  // These test cases document expressions where the legacy evaluator and the
  // dual evaluator intentionally or unavoidably differ. They use individual
  // assertions (not assertParity) to verify each evaluator's behavior.
  // ===========================================================================

  describe('Known divergences (legacy vs dual)', () => {
    test('uppercase CONTAINS: legacy does not support, dual migrates to CEL', () => {
      // Legacy splits on lowercase ' contains ' only.
      // Dual detects CONTAINS as legacy ABL, migrates to .contains(), evaluates via CEL.
      const legacy = evaluateCondition('email CONTAINS "@"', { email: 'user@example.com' });
      const dual = evaluateConditionDual('email CONTAINS "@"', { email: 'user@example.com' });
      expect(legacy).toBe(false); // legacy fails to parse CONTAINS (uppercase)
      expect(dual).toBe(true); // dual migrates and evaluates correctly
    });

    test('IN operator: legacy does not support, dual evaluates via CEL', () => {
      // The IN operator is a CEL feature not present in the legacy evaluator.
      // Legacy tries to parse 'status IN ["active", "pending"]' and falls through
      // to a truthy check on the whole expression, which fails.
      const dual = evaluateConditionDual('status in ["active", "pending"]', { status: 'active' });
      expect(dual).toBe(true);

      const dualFalse = evaluateConditionDual('status in ["active", "pending"]', {
        status: 'closed',
      });
      expect(dualFalse).toBe(false);
    });

    test('CEL-native string methods: .startsWith(), .endsWith()', () => {
      // These are CEL-native string methods, not legacy ABL operators.
      // Legacy uses ' startsWith ' and ' endsWith ' as operator keywords.
      const dual = evaluateConditionDual('name.startsWith("Jo")', { name: 'John' });
      expect(dual).toBe(true);

      const dualEnd = evaluateConditionDual('name.endsWith("hn")', { name: 'John' });
      expect(dualEnd).toBe(true);
    });

    test('CEL ternary: condition ? a : b is CEL-only', () => {
      // The ternary operator is a CEL feature, not available in legacy.
      const dual = evaluateConditionDual('age >= 18 ? true : false', { age: 25 });
      expect(dual).toBe(true);
    });

    test('CEL arithmetic in conditions', () => {
      // CEL supports inline arithmetic; legacy does not.
      // Use .0 suffix to avoid BigInt/number mixing.
      const dual = evaluateConditionDual('age + 5.0 > 25.0', { age: 25 });
      expect(dual).toBe(true);
    });
  });

  // ===========================================================================
  // STRESS: MANY CLAUSES
  // ===========================================================================

  describe('Stress: many clauses', () => {
    test('5-clause AND: all true', () => {
      assertParity(
        'a == 1 AND b == 2 AND c == 3 AND d == 4 AND e == 5',
        { a: 1, b: 2, c: 3, d: 4, e: 5 },
        true,
      );
    });

    test('5-clause AND: last false', () => {
      assertParity(
        'a == 1 AND b == 2 AND c == 3 AND d == 4 AND e == 5',
        { a: 1, b: 2, c: 3, d: 4, e: 99 },
        false,
      );
    });

    test('5-clause OR: all false', () => {
      assertParity('x == 1 OR x == 2 OR x == 3 OR x == 4 OR x == 5', { x: 99 }, false);
    });

    test('5-clause OR: third is true', () => {
      assertParity('x == 1 OR x == 2 OR x == 3 OR x == 4 OR x == 5', { x: 3 }, true);
    });
  });

  // ===========================================================================
  // FLOAT COMPARISONS
  // ===========================================================================

  describe('Float comparisons', () => {
    test('float equality', () => {
      assertParity('price == 99.99', { price: 99.99 }, true);
      assertParity('price == 99.98', { price: 99.99 }, false);
    });

    test('float greater than', () => {
      assertParity('price > 50.0', { price: 99.99 }, true);
      assertParity('price > 100.0', { price: 99.99 }, false);
    });

    test('float less than or equal', () => {
      assertParity('price <= 100.0', { price: 99.99 }, true);
      assertParity('price <= 50.0', { price: 99.99 }, false);
    });
  });

  // ===========================================================================
  // NESTED PATH WITH IS SET IN COMPOUND
  // ===========================================================================

  describe('Nested path IS SET in compound expressions', () => {
    test('nested IS SET AND comparison', () => {
      assertParity(
        'user.email IS SET AND user.email contains "@"',
        { user: { email: 'a@b.com' } },
        true,
      );
      assertParity('user.email IS SET AND user.email contains "@"', { user: {} }, false);
    });

    test('nested IS NOT SET OR fallback', () => {
      assertParity('user.name IS NOT SET OR user.name == "admin"', { user: {} }, true);
      assertParity(
        'user.name IS NOT SET OR user.name == "admin"',
        { user: { name: 'admin' } },
        true,
      );
      assertParity(
        'user.name IS NOT SET OR user.name == "admin"',
        { user: { name: 'guest' } },
        false,
      );
    });
  });

  // ===========================================================================
  // MULTIPLE NESTED PATH COMPARISONS
  // ===========================================================================

  describe('Multiple nested path comparisons', () => {
    test('two nested paths compared', () => {
      assertParity('order.from != order.to', { order: { from: 'NYC', to: 'LAX' } }, true);
      assertParity('order.from != order.to', { order: { from: 'NYC', to: 'NYC' } }, false);
    });

    test('nested path with AND', () => {
      assertParity(
        'user.role == "admin" AND user.active == true',
        { user: { role: 'admin', active: true } },
        true,
      );
      assertParity(
        'user.role == "admin" AND user.active == true',
        { user: { role: 'admin', active: false } },
        false,
      );
    });
  });

  // ===========================================================================
  // ABL FUNCTION PARITY IN CONDITIONS
  // ===========================================================================

  describe('ABL function parity in conditions', () => {
    test('UPPER in comparison', () => {
      assertParity('UPPER(name) == "ALICE"', { name: 'Alice' }, true);
      assertParity('UPPER(name) == "BOB"', { name: 'Alice' }, false);
    });

    test('LOWER in comparison', () => {
      assertParity('LOWER(name) == "alice"', { name: 'Alice' }, true);
      assertParity('LOWER(name) == "bob"', { name: 'Alice' }, false);
    });

    test('UPPER in AND condition', () => {
      assertParity('UPPER(name) == "JOHN" AND age >= 18', { name: 'John', age: 25 }, true);
      assertParity('UPPER(name) == "JOHN" AND age >= 18', { name: 'John', age: 10 }, false);
    });
  });
});
