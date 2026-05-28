import { describe, test, expect } from 'vitest';
import { evaluateCel, evaluateCelCondition } from '../../platform/constructs/cel-evaluator.js';

describe('CEL Evaluator', () => {
  describe('evaluateCelCondition', () => {
    test('evaluates simple comparison', () => {
      expect(evaluateCelCondition('age >= 18', { age: 25 })).toBe(true);
      expect(evaluateCelCondition('age >= 18', { age: 10 })).toBe(false);
    });

    test('evaluates logical AND', () => {
      expect(evaluateCelCondition('age >= 18 && name != ""', { age: 25, name: 'John' })).toBe(true);
      expect(evaluateCelCondition('age >= 18 && name != ""', { age: 25, name: '' })).toBe(false);
    });

    test('evaluates logical OR', () => {
      expect(
        evaluateCelCondition('status == "active" || status == "pending"', { status: 'pending' }),
      ).toBe(true);
      expect(
        evaluateCelCondition('status == "active" || status == "pending"', { status: 'closed' }),
      ).toBe(false);
    });

    test('evaluates NOT', () => {
      expect(evaluateCelCondition('!(age < 18)', { age: 25 })).toBe(true);
    });

    test('evaluates in operator with list', () => {
      expect(evaluateCelCondition('status in ["active", "pending"]', { status: 'active' })).toBe(
        true,
      );
      expect(evaluateCelCondition('status in ["active", "pending"]', { status: 'closed' })).toBe(
        false,
      );
    });

    test('evaluates string methods', () => {
      expect(evaluateCelCondition('email.contains("@")', { email: 'user@example.com' })).toBe(true);
      expect(evaluateCelCondition('name.startsWith("Dr")', { name: 'Dr. Smith' })).toBe(true);
      expect(evaluateCelCondition('name.endsWith("th")', { name: 'Dr. Smith' })).toBe(true);
      expect(evaluateCelCondition('name.matches("Dr.*")', { name: 'Dr. Smith' })).toBe(true);
    });

    test('evaluates has() for field existence checks on objects', () => {
      // CEL spec: has() requires member access syntax — has(obj.field)
      expect(evaluateCelCondition('has(ctx.name)', { ctx: { name: 'John' } })).toBe(true);
      expect(evaluateCelCondition('has(ctx.name)', { ctx: {} })).toBe(false);
    });

    test('evaluates size()', () => {
      expect(evaluateCelCondition('size(items) > 0', { items: [1, 2, 3] })).toBe(true);
      expect(evaluateCelCondition('size(items) == 0', { items: [] })).toBe(true);
    });

    test('evaluates arithmetic with context numbers', () => {
      expect(evaluateCelCondition('price + tax > 100', { price: 90, tax: 15 })).toBe(true);
      expect(evaluateCelCondition('price + tax > 100', { price: 50, tax: 10 })).toBe(false);
    });

    test('evaluates ternary', () => {
      const result = evaluateCel('has(ctx.name) ? ctx.name : "Anonymous"', {
        ctx: { name: 'John' },
      });
      expect(result).toBe('John');
      const fallback = evaluateCel('has(ctx.name) ? ctx.name : "Anonymous"', { ctx: {} });
      expect(fallback).toBe('Anonymous');
    });

    test('evaluates .contains() for substring check', () => {
      // Use .contains() for substring checks — idiomatic CEL
      expect(evaluateCelCondition('"hello".contains("ell")', {})).toBe(true);
      expect(evaluateCelCondition('"hello".contains("xyz")', {})).toBe(false);
      expect(evaluateCelCondition('greeting.contains("ell")', { greeting: 'hello' })).toBe(true);
      expect(evaluateCelCondition('greeting.contains("xyz")', { greeting: 'hello' })).toBe(false);
    });
  });

  describe('evaluateCel (value resolution)', () => {
    test('resolves string literals', () => {
      expect(evaluateCel('"hello"', {})).toBe('hello');
    });

    test('resolves number literals (BigInt normalized to Number)', () => {
      expect(evaluateCel('42', {})).toBe(42);
      expect(typeof evaluateCel('42', {})).toBe('number');
    });

    test('resolves boolean literals', () => {
      expect(evaluateCel('true', {})).toBe(true);
      expect(evaluateCel('false', {})).toBe(false);
    });

    test('resolves null literal', () => {
      expect(evaluateCel('null', {})).toBe(null);
    });

    test('resolves variable paths', () => {
      expect(evaluateCel('user.name', { user: { name: 'John' } })).toBe('John');
    });

    test('resolves arithmetic expressions with context numbers', () => {
      expect(evaluateCel('price + tax', { price: 100, tax: 10 })).toBe(110);
    });

    test('resolves size() as a normalized number', () => {
      expect(evaluateCel('size(items)', { items: [1, 2, 3] })).toBe(3);
      expect(typeof evaluateCel('size(items)', { items: [1, 2, 3] })).toBe('number');
    });

    test('resolves list expressions', () => {
      const result = evaluateCel('[1, 2, 3]', {});
      // CEL list literals with integer values are BigInt, normalized to numbers
      expect(result).toEqual([1, 2, 3]);
    });

    test('resolves map expressions', () => {
      const result = evaluateCel('{"a": 1, "b": 2}', {});
      expect(result).toEqual({ a: 1, b: 2 });
    });
  });

  describe('error handling', () => {
    test('wraps parse errors with expression context', () => {
      expect(() => evaluateCel('+ + invalid', {})).toThrow('CEL evaluation failed');
    });

    test('wraps evaluation errors with expression context', () => {
      expect(() => evaluateCel('nonexistent.field.deep', {})).toThrow('CEL evaluation failed');
    });

    test('evaluateCelCondition wraps errors from evaluateCel', () => {
      expect(() => evaluateCelCondition('+ + invalid', {})).toThrow('CEL evaluation failed');
    });
  });
});
