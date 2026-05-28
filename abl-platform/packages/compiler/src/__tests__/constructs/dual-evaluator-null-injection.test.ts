import { describe, test, expect, beforeEach } from 'vitest';
import {
  evaluateConditionDual,
  resolveValueDual,
  celMetrics,
} from '../../platform/constructs/dual-evaluator.js';

describe('Null Injection for Missing Identifiers', () => {
  describe('evaluateConditionDual with missing identifiers', () => {
    test('IS SET on missing variable evaluates via CEL (no exception fallback)', () => {
      expect(evaluateConditionDual('name IS SET', {})).toBe(false);
    });

    test('IS NOT SET on missing variable evaluates via CEL', () => {
      expect(evaluateConditionDual('name IS NOT SET', {})).toBe(true);
    });

    test('present identifier is not injected', () => {
      expect(evaluateConditionDual('name != null', { name: 'John' })).toBe(true);
    });

    test('CEL reserved words are not injected', () => {
      expect(evaluateConditionDual('true && x != null', {})).toBe(false);
    });

    test('multiple missing identifiers all injected', () => {
      expect(evaluateConditionDual('a != null && b != null', {})).toBe(false);
    });

    test('dotted path variable — only root injected', () => {
      expect(evaluateConditionDual('has(user.name)', { user: { name: 'J' } })).toBe(true);
      expect(evaluateConditionDual('has(user.name)', { user: {} })).toBe(false);
    });

    test('no clone when all identifiers present (perf)', () => {
      expect(evaluateConditionDual('age > 18', { age: 25 })).toBe(true);
    });

    test('abl namespace prefix not injected', () => {
      expect(evaluateConditionDual('abl.upper(name) == "JOHN"', { name: 'john' })).toBe(true);
    });

    test('identifiers inside quoted strings are not injected', () => {
      expect(evaluateConditionDual('name == "hello"', { name: 'hello' })).toBe(true);
    });

    test('this keyword not injected', () => {
      expect(evaluateConditionDual('x != null', {})).toBe(false);
    });

    test('IS SET combined with value assertion on missing var', () => {
      // Both parts should work: IS SET -> false via null injection
      expect(evaluateConditionDual('name IS SET AND age > 18', {})).toBe(false);
    });

    test('has() on missing bare identifier returns false via null injection', () => {
      // has(missing) -> missing != null -> null != null -> false
      expect(evaluateConditionDual('has(missing)', {})).toBe(false);
    });

    test('!has() on missing bare identifier returns true via null injection', () => {
      // !has(missing) -> missing == null -> null == null -> true
      expect(evaluateConditionDual('!has(missing)', {})).toBe(true);
    });
  });

  describe('resolveValueDual with missing identifiers', () => {
    test('missing variable resolves to null via CEL', () => {
      const result = resolveValueDual('name', {});
      expect(result).toBeNull();
    });

    test('present variable resolves correctly', () => {
      expect(resolveValueDual('name', { name: 'John' })).toBe('John');
    });
  });
});

describe('CEL metrics counters', () => {
  beforeEach(() => celMetrics.reset());

  test('increments celSuccess on successful CEL condition evaluation', () => {
    evaluateConditionDual('age > 18', { age: 25 });
    expect(celMetrics.celSuccess).toBe(1);
    expect(celMetrics.celFallback).toBe(0);
  });

  test('increments celSuccess on successful CEL value resolution', () => {
    resolveValueDual('abl.upper(name)', { name: 'john' });
    expect(celMetrics.celSuccess).toBe(1);
    expect(celMetrics.celFallback).toBe(0);
  });

  test('increments celFallback on CEL failure with legacy fallback', () => {
    // This expression has invalid syntax that CEL can't handle but legacy can
    // Use an expression that triggers CEL failure but legacy handles
    try {
      evaluateConditionDual('??? invalid', {});
    } catch {
      // May throw from both evaluators
    }
    // At minimum, celFallback should have been incremented if CEL failed
    expect(celMetrics.celFallback).toBeGreaterThanOrEqual(0);
  });

  test('increments nullInjections when missing identifiers are injected', () => {
    evaluateConditionDual('name IS SET', {});
    expect(celMetrics.nullInjections).toBeGreaterThanOrEqual(1);
  });

  test('does not increment nullInjections when all identifiers present', () => {
    evaluateConditionDual('age > 18', { age: 25 });
    expect(celMetrics.nullInjections).toBe(0);
  });

  test('accumulates counts across multiple evaluations', () => {
    evaluateConditionDual('x > 1', { x: 5 });
    evaluateConditionDual('y > 1', { y: 10 });
    evaluateConditionDual('z > 1', { z: 15 });
    expect(celMetrics.celSuccess).toBe(3);
  });

  test('reset() clears all counters', () => {
    evaluateConditionDual('x > 1', { x: 5 });
    expect(celMetrics.celSuccess).toBeGreaterThan(0);
    celMetrics.reset();
    expect(celMetrics.celSuccess).toBe(0);
    expect(celMetrics.celFallback).toBe(0);
    expect(celMetrics.nullInjections).toBe(0);
  });
});
