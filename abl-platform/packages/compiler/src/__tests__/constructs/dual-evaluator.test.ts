import { describe, test, expect } from 'vitest';
import {
  evaluateConditionDual,
  evaluateConditionDetailedDual,
  resolveValueDual,
  celMetrics,
} from '../../platform/constructs/dual-evaluator.js';

describe('Dual-Mode Evaluator', () => {
  const context = { age: 25, name: 'John', status: 'active', email: 'john@example.com' };

  describe('evaluateConditionDual', () => {
    describe('legacy ABL expressions', () => {
      test('evaluates legacy ABL logical operators', () => {
        expect(evaluateConditionDual('age >= 18 AND name != ""', context)).toBe(true);
        expect(evaluateConditionDual('age >= 18 AND name == ""', context)).toBe(false);
      });

      test('evaluates legacy ABL CONTAINS operator', () => {
        expect(evaluateConditionDual('email CONTAINS "@"', context)).toBe(true);
        expect(evaluateConditionDual('email CONTAINS "xyz"', context)).toBe(false);
      });

      test('evaluates legacy ABL OR operator', () => {
        expect(evaluateConditionDual('status == "active" OR status == "pending"', context)).toBe(
          true,
        );
        expect(evaluateConditionDual('status == "closed" OR status == "pending"', context)).toBe(
          false,
        );
      });

      test('auto-detects and migrates legacy expressions with functions', () => {
        expect(evaluateConditionDual('UPPER(name) == "JOHN"', context)).toBe(true);
        expect(evaluateConditionDual('UPPER(name) == "JANE"', context)).toBe(false);
      });
    });

    describe('CEL expressions', () => {
      test('evaluates CEL logical operators', () => {
        expect(evaluateConditionDual('age >= 18 && name != ""', context)).toBe(true);
        expect(evaluateConditionDual('age >= 18 && name == ""', context)).toBe(false);
      });

      test('evaluates CEL string methods', () => {
        expect(evaluateConditionDual('email.contains("@")', context)).toBe(true);
        expect(evaluateConditionDual('email.contains("xyz")', context)).toBe(false);
      });

      test('evaluates CEL with abl.* functions', () => {
        expect(evaluateConditionDual('abl.upper(name) == "JOHN"', context)).toBe(true);
        expect(evaluateConditionDual('abl.lower(name) == "john"', context)).toBe(true);
      });

      test('evaluates CEL in operator with list', () => {
        expect(evaluateConditionDual('status in ["active", "pending"]', context)).toBe(true);
        expect(evaluateConditionDual('status in ["active", "pending"]', { status: 'closed' })).toBe(
          false,
        );
      });

      test('evaluates CEL arithmetic comparisons with float literals', () => {
        // CEL integer literals produce BigInt, so use .0 suffix for context-number arithmetic
        expect(evaluateConditionDual('age + 5.0 > 25.0', context)).toBe(true);
        expect(evaluateConditionDual('age + 5.0 > 35.0', context)).toBe(false);
      });

      test('evaluates CEL arithmetic with context-only variables', () => {
        // Both values from context (JS numbers) work without .0 suffix
        expect(evaluateConditionDual('price + tax > 100', { price: 90, tax: 15 })).toBe(true);
        expect(evaluateConditionDual('price + tax > 100', { price: 50, tax: 10 })).toBe(false);
      });
    });

    describe('IS SET / has() handling', () => {
      test('handles legacy IS SET with bare identifiers', () => {
        expect(evaluateConditionDual('name IS SET', context)).toBe(true);
        expect(evaluateConditionDual('name IS SET', {})).toBe(false);
      });

      test('handles legacy IS NOT SET with bare identifiers', () => {
        expect(evaluateConditionDual('name IS NOT SET', {})).toBe(true);
        expect(evaluateConditionDual('name IS NOT SET', context)).toBe(false);
      });

      test('handles has() with bare identifiers in CEL syntax', () => {
        // has(bareIdent) is preprocessed to bareIdent != null
        expect(evaluateConditionDual('has(name)', context)).toBe(true);
        expect(evaluateConditionDual('has(name)', {})).toBe(false);
      });

      test('handles !has() with bare identifiers', () => {
        // !has(bareIdent) is preprocessed to bareIdent == null
        expect(evaluateConditionDual('!has(name)', {})).toBe(true);
        expect(evaluateConditionDual('!has(name)', context)).toBe(false);
      });

      test('handles has() with dotted paths (valid CEL)', () => {
        expect(evaluateConditionDual('has(ctx.name)', { ctx: { name: 'John' } })).toBe(true);
        expect(evaluateConditionDual('has(ctx.name)', { ctx: {} })).toBe(false);
      });

      test('handles !has() with dotted paths', () => {
        expect(evaluateConditionDual('!has(ctx.name)', { ctx: {} })).toBe(true);
        expect(evaluateConditionDual('!has(ctx.name)', { ctx: { name: 'John' } })).toBe(false);
      });

      test('handles IS SET combined with other conditions', () => {
        expect(evaluateConditionDual('name IS SET AND age >= 18', context)).toBe(true);
        expect(evaluateConditionDual('name IS SET AND age >= 30', context)).toBe(false);
      });
    });

    describe('fallback to legacy evaluator', () => {
      test('falls back gracefully when CEL cannot evaluate', () => {
        // Legacy evaluator handles IS SET natively, so even if CEL fails,
        // the fallback catches it
        expect(evaluateConditionDual('name IS SET', { name: 'John' })).toBe(true);
      });

      test('returns false for completely invalid expressions', () => {
        // Both CEL and legacy should fail; legacy returns false on error
        expect(evaluateConditionDual('??? invalid !!!', {})).toBe(false);
      });
    });

    describe('edge cases', () => {
      test('handles empty expression', () => {
        // Empty condition defaults to true in legacy evaluator
        expect(evaluateConditionDual('', {})).toBe(true);
      });

      test('handles boolean literals', () => {
        expect(evaluateConditionDual('true', {})).toBe(true);
        expect(evaluateConditionDual('false', {})).toBe(false);
      });

      test('handles null values in context', () => {
        expect(evaluateConditionDual('has(name)', { name: null })).toBe(false);
      });
    });
  });

  describe('resolveValueDual', () => {
    describe('legacy ABL expressions', () => {
      test('resolves legacy ABL UPPER function', () => {
        expect(resolveValueDual('UPPER(name)', context)).toBe('JOHN');
      });

      test('resolves legacy ABL LOWER function', () => {
        expect(resolveValueDual('LOWER(name)', context)).toBe('john');
      });

      test('resolves legacy ABL ADD function', () => {
        expect(resolveValueDual('ADD(age, 5)', context)).toBe(30);
      });

      test('resolves legacy ABL SUB function', () => {
        expect(resolveValueDual('SUB(age, 5)', context)).toBe(20);
      });
    });

    describe('CEL expressions', () => {
      test('resolves CEL abl.upper function', () => {
        expect(resolveValueDual('abl.upper(name)', context)).toBe('JOHN');
      });

      test('resolves CEL abl.lower function', () => {
        expect(resolveValueDual('abl.lower(name)', context)).toBe('john');
      });

      test('resolves CEL arithmetic with float literals', () => {
        // CEL integer literals produce BigInt; use .0 suffix with context numbers
        expect(resolveValueDual('age + 5.0', context)).toBe(30);
        expect(resolveValueDual('age - 5.0', context)).toBe(20);
      });

      test('resolves CEL arithmetic with context-only variables', () => {
        expect(resolveValueDual('price + tax', { price: 100, tax: 10 })).toBe(110);
      });

      test('resolves CEL string concatenation', () => {
        expect(resolveValueDual('"Hello " + name', context)).toBe('Hello John');
      });
    });

    describe('common expressions', () => {
      test('resolves simple variable paths', () => {
        expect(resolveValueDual('name', context)).toBe('John');
        expect(resolveValueDual('age', context)).toBe(25);
      });

      test('resolves string literals', () => {
        expect(resolveValueDual('"hello"', context)).toBe('hello');
      });

      test('resolves number literals', () => {
        expect(resolveValueDual('42', context)).toBe(42);
      });

      test('resolves boolean literals', () => {
        expect(resolveValueDual('true', context)).toBe(true);
        expect(resolveValueDual('false', context)).toBe(false);
      });

      test('resolves nested paths', () => {
        expect(resolveValueDual('user.name', { user: { name: 'Jane' } })).toBe('Jane');
      });
    });

    describe('fallback to legacy evaluator', () => {
      test('falls back when CEL cannot resolve', () => {
        // Legacy TRIM function should work via fallback if CEL fails
        const result = resolveValueDual('TRIM(name)', { name: '  John  ' });
        expect(result).toBe('John');
      });
    });
  });

  // =========================================================================
  // EXPANDED TESTS: evaluateConditionDetailedDual, match propagation,
  // null injection, CEL/legacy fallback, edge cases
  // =========================================================================

  describe('evaluateConditionDetailedDual', () => {
    test('returns compound_and for AND conditions', () => {
      const detail = evaluateConditionDetailedDual('a == 1 AND b == 2', '', { a: 1, b: 2 });
      expect(detail.matched).toBe(true);
      expect(detail.conditionType).toBe('compound_and');
    });

    test('returns compound_and for && conditions (CEL)', () => {
      const detail = evaluateConditionDetailedDual('a == 1 && b == 2', '', { a: 1, b: 2 });
      expect(detail.matched).toBe(true);
      expect(detail.conditionType).toBe('compound_and');
    });

    test('returns compound_or for OR conditions', () => {
      const detail = evaluateConditionDetailedDual('a == 1 OR b == 99', '', { a: 1, b: 2 });
      expect(detail.matched).toBe(true);
      expect(detail.conditionType).toBe('compound_or');
    });

    test('returns compound_or for || conditions (CEL)', () => {
      const detail = evaluateConditionDetailedDual('a == 1 || b == 99', '', { a: 1, b: 2 });
      expect(detail.matched).toBe(true);
      expect(detail.conditionType).toBe('compound_or');
    });

    test('returns is_set for IS SET', () => {
      const detail = evaluateConditionDetailedDual('name IS SET', '', { name: 'Alice' });
      expect(detail.conditionType).toBe('is_set');
      expect(detail.matched).toBe(true);
    });

    test('returns is_not_set for IS NOT SET', () => {
      const detail = evaluateConditionDetailedDual('missing IS NOT SET', '', {});
      expect(detail.conditionType).toBe('is_not_set');
      expect(detail.matched).toBe(true);
    });

    test('returns variable_comparison for == operator', () => {
      const detail = evaluateConditionDetailedDual('count == 5', '', { count: 5 });
      expect(detail.conditionType).toBe('variable_comparison');
      expect(detail.operator).toBe('==');
      expect(detail.matched).toBe(true);
    });

    test('returns variable_comparison for != operator', () => {
      const detail = evaluateConditionDetailedDual('x != 0', '', { x: 5 });
      expect(detail.conditionType).toBe('variable_comparison');
      expect(detail.operator).toBe('!=');
      expect(detail.matched).toBe(true);
    });

    test('returns variable_comparison for >= operator', () => {
      const detail = evaluateConditionDetailedDual('age >= 18', '', { age: 21 });
      expect(detail.conditionType).toBe('variable_comparison');
      expect(detail.operator).toBe('>=');
      expect(detail.matched).toBe(true);
    });

    test('returns contains for contains operator', () => {
      const detail = evaluateConditionDetailedDual('input contains "hello"', 'say hello', {});
      expect(detail.conditionType).toBe('contains');
      expect(detail.matched).toBe(true);
    });

    test('returns matches for regex match', () => {
      const ctx: Record<string, unknown> = {};
      const detail = evaluateConditionDetailedDual('input matches "^hello"', 'hello world', ctx);
      expect(detail.conditionType).toBe('matches');
      expect(detail.matched).toBe(true);
    });

    test('returns other for fallback expressions', () => {
      const detail = evaluateConditionDetailedDual('true', '', {});
      expect(detail.conditionType).toBe('other');
      expect(detail.matched).toBe(true);
    });

    test('propagates regex capture groups back to original context', () => {
      const ctx: Record<string, unknown> = {};
      const detail = evaluateConditionDetailedDual(
        'input matches "order-(\\d+)"',
        'order-456',
        ctx,
      );
      expect(detail.matched).toBe(true);
      expect(ctx.match).toBeDefined();
      const match = ctx.match as Record<string, string>;
      expect(match['0']).toBe('order-456');
      expect(match['1']).toBe('456');
    });

    test('does not propagate match on regex failure', () => {
      const ctx: Record<string, unknown> = {};
      evaluateConditionDetailedDual('input matches "^xyz"', 'hello', ctx);
      expect(ctx.match).toBeUndefined();
    });

    test('handles input parameter merged as context.input', () => {
      const detail = evaluateConditionDetailedDual('input == "yes"', 'yes', {});
      expect(detail.matched).toBe(true);
    });

    test('compound AND with partial failure', () => {
      const detail = evaluateConditionDetailedDual('a == 1 AND b == 99', '', { a: 1, b: 2 });
      expect(detail.conditionType).toBe('compound_and');
      expect(detail.matched).toBe(false);
    });

    test('explanation contains human-readable info', () => {
      const detail = evaluateConditionDetailedDual('count == 5', '', { count: 5 });
      expect(detail.explanation).toContain('count');
      expect(detail.explanation).toContain('5');
    });
  });

  describe('Null injection edge cases', () => {
    test('missing variables get injected as null for CEL evaluation', () => {
      // 'missing_var != null' should be false (missing_var injected as null)
      expect(evaluateConditionDual('missing_var != null', {})).toBe(false);
    });

    test('null-injected variable equals null', () => {
      expect(evaluateConditionDual('missing_var == null', {})).toBe(true);
    });

    test('does not inject CEL reserved words', () => {
      // 'true' is a CEL reserved word, should not be injected
      expect(evaluateConditionDual('true', {})).toBe(true);
      expect(evaluateConditionDual('false', {})).toBe(false);
    });

    test('does not inject identifiers inside quoted strings', () => {
      // 'name == "John"' — "John" is in quotes, should not be injected
      expect(evaluateConditionDual('name == "John"', { name: 'John' })).toBe(true);
    });

    test('handles multiple missing variables', () => {
      // Both a and b are missing, injected as null
      expect(evaluateConditionDual('a == null && b == null', {})).toBe(true);
    });
  });

  describe('CEL/legacy interoperability', () => {
    test('legacy AND maps to CEL && semantics', () => {
      const ctx = { a: 1, b: 2 };
      expect(evaluateConditionDual('a == 1 AND b == 2', ctx)).toBe(true);
      expect(evaluateConditionDual('a == 1 && b == 2', ctx)).toBe(true);
    });

    test('legacy OR maps to CEL || semantics', () => {
      const ctx = { a: 1, b: 2 };
      expect(evaluateConditionDual('a == 99 OR b == 2', ctx)).toBe(true);
      expect(evaluateConditionDual('a == 99 || b == 2', ctx)).toBe(true);
    });

    test('legacy UPPER maps to CEL abl.upper', () => {
      expect(resolveValueDual('UPPER(name)', { name: 'alice' })).toBe('ALICE');
      expect(resolveValueDual('abl.upper(name)', { name: 'alice' })).toBe('ALICE');
    });

    test('legacy LOWER maps to CEL abl.lower', () => {
      expect(resolveValueDual('LOWER(name)', { name: 'ALICE' })).toBe('alice');
      expect(resolveValueDual('abl.lower(name)', { name: 'ALICE' })).toBe('alice');
    });

    test('legacy CONTAINS maps to CEL .contains()', () => {
      expect(evaluateConditionDual('email CONTAINS "@"', { email: 'a@b.com' })).toBe(true);
      expect(evaluateConditionDual('email.contains("@")', { email: 'a@b.com' })).toBe(true);
    });
  });

  describe('evaluateConditionDual — expanded edge cases', () => {
    test('handles deeply nested context paths', () => {
      const ctx = { user: { profile: { settings: { theme: 'dark' } } } };
      expect(evaluateConditionDual('user.profile.settings.theme == "dark"', ctx)).toBe(true);
    });

    test('handles comparison with 0', () => {
      expect(evaluateConditionDual('count == 0', { count: 0 })).toBe(true);
      expect(evaluateConditionDual('count != 0', { count: 0 })).toBe(false);
    });

    test('handles comparison with empty string', () => {
      expect(evaluateConditionDual('name == ""', { name: '' })).toBe(true);
      expect(evaluateConditionDual('name != ""', { name: '' })).toBe(false);
    });

    test('handles comparison with boolean values', () => {
      expect(evaluateConditionDual('active == true', { active: true })).toBe(true);
      expect(evaluateConditionDual('active == false', { active: false })).toBe(true);
    });

    test('handles multiple conditions with mixed operators', () => {
      const ctx = { age: 25, name: 'John', active: true };
      expect(evaluateConditionDual('age >= 18 AND name != "" AND active == true', ctx)).toBe(true);
    });

    test('handles IS SET combined with != in AND chain', () => {
      const ctx = { origin: 'Paris', destination: 'London' };
      expect(
        evaluateConditionDual(
          'origin IS SET AND destination IS SET AND origin != destination',
          ctx,
        ),
      ).toBe(true);
    });

    test('handles IS SET combined with != where values are same', () => {
      const ctx = { origin: 'Paris', destination: 'Paris' };
      expect(
        evaluateConditionDual(
          'origin IS SET AND destination IS SET AND origin != destination',
          ctx,
        ),
      ).toBe(false);
    });

    test('handles numeric comparison with string context value', () => {
      expect(evaluateConditionDual('age >= 18', { age: '25' })).toBe(true);
    });
  });

  describe('resolveValueDual — expanded edge cases', () => {
    test('resolves null literal', () => {
      expect(resolveValueDual('null', {})).toBeNull();
    });

    test('resolves nested object path', () => {
      const ctx = { config: { db: { port: 5432 } } };
      expect(resolveValueDual('config.db.port', ctx)).toBe(5432);
    });

    test('resolves missing nested path as null/undefined', () => {
      const result = resolveValueDual('config.missing.path', { config: {} });
      expect(result == null).toBe(true);
    });

    test('resolves CEL ternary expression', () => {
      expect(resolveValueDual('age >= 18 ? "adult" : "minor"', { age: 25 })).toBe('adult');
      expect(resolveValueDual('age >= 18 ? "adult" : "minor"', { age: 10 })).toBe('minor');
    });

    test('resolves empty string literal', () => {
      expect(resolveValueDual('""', {})).toBe('');
    });

    test('resolves float literal', () => {
      expect(resolveValueDual('3.14', {})).toBeCloseTo(3.14);
    });

    test('resolves negative number literal', () => {
      expect(resolveValueDual('-42', {})).toBe(-42);
    });
  });

  describe('celMetrics tracking', () => {
    test('metrics object has expected keys', () => {
      expect(typeof celMetrics.celSuccess).toBe('number');
      expect(typeof celMetrics.celFallback).toBe('number');
      expect(typeof celMetrics.nullInjections).toBe('number');
    });

    test('reset clears all counters', () => {
      celMetrics.celSuccess = 100;
      celMetrics.celFallback = 50;
      celMetrics.nullInjections = 25;
      celMetrics.reset();
      expect(celMetrics.celSuccess).toBe(0);
      expect(celMetrics.celFallback).toBe(0);
      expect(celMetrics.nullInjections).toBe(0);
    });

    test('successful CEL evaluation increments celSuccess', () => {
      celMetrics.reset();
      evaluateConditionDual('1 == 1', {});
      expect(celMetrics.celSuccess).toBeGreaterThan(0);
    });
  });
});
