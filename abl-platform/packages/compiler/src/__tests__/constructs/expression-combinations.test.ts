/**
 * Expression Combination Tests
 *
 * Tests for null values, correct/incorrect values within constraints,
 * IS SET guard evaluation, and conditional expression combinations.
 *
 * Updated for flattened constraint system:
 * - No phases — constraints is a flat Constraint[] list
 * - All constraints fire every turn — IS SET guards handle partial data
 * - ConstraintCheckInfo.type is 'guardrail' | 'constraint'
 * - failedConstraint metadata contains the condition string
 * - No failedPhase metadata field
 */

import { describe, test, expect, vi } from 'vitest';
import {
  evaluateCondition,
  evaluateConditions,
  evaluateConditionList,
  evaluateConditionWithInput,
  evaluateConditionDetailed,
  resolveValue,
} from '../../platform/constructs/evaluator.js';
import { ConstraintExecutor } from '../../platform/constructs/executors/constraint-executor.js';
import type { ExecutionContext } from '../../platform/constructs/types.js';
import type { Constraint, Guardrail, ConstraintAction } from '../../platform/ir/schema.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeContext(
  constraints: Constraint[] = [],
  guardrails: Guardrail[] = [],
  stateContext: Record<string, unknown> = {},
): ExecutionContext {
  return {
    agentIR: {
      constraints: { constraints, guardrails },
    } as ExecutionContext['agentIR'],
    state: {
      context: stateContext,
      conversationPhase: null,
      constraintResults: {},
      gatherProgress: {},
    },
    trace: {
      logConstraintCheck: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExecutionContext['trace'],
  } as ExecutionContext;
}

/** Helper that returns a flat Constraint[] from requirement specs */
function makeConstraints(
  requirements: Array<{ condition: string; on_fail: ConstraintAction }>,
): Constraint[] {
  return requirements.map((r) => ({ condition: r.condition, on_fail: r.on_fail }));
}

function respond(message: string): ConstraintAction {
  return { type: 'respond', message };
}

function block(reason: string): ConstraintAction {
  return { type: 'block', reason };
}

function escalate(reason: string): ConstraintAction {
  return { type: 'escalate', reason };
}

// =============================================================================
// NULL VALUE EXPRESSIONS
// =============================================================================

describe('Null value expressions', () => {
  describe('null literal resolution', () => {
    test('resolveValue should return null for "null" literal', () => {
      expect(resolveValue('null', {})).toBeNull();
    });

    test('resolveValue should return undefined for "undefined" literal', () => {
      expect(resolveValue('undefined', {})).toBeUndefined();
    });
  });

  describe('equality with null', () => {
    test('null context value == null literal should be true', () => {
      const ctx = { value: null };
      expect(evaluateCondition('value == null', ctx)).toBe(true);
    });

    test('undefined context value == null literal should be true', () => {
      const ctx = {};
      expect(evaluateCondition('missing == null', ctx)).toBe(true);
    });

    test('defined value == null should be false', () => {
      const ctx = { name: 'John' };
      expect(evaluateCondition('name == null', ctx)).toBe(false);
    });

    test('zero == null should be false', () => {
      const ctx = { count: 0 };
      expect(evaluateCondition('count == null', ctx)).toBe(false);
    });

    test('empty string == null should be false', () => {
      const ctx = { name: '' };
      expect(evaluateCondition('name == null', ctx)).toBe(false);
    });

    test('false == null should be false', () => {
      const ctx = { flag: false };
      expect(evaluateCondition('flag == null', ctx)).toBe(false);
    });
  });

  describe('inequality with null', () => {
    test('null != null should be false', () => {
      const ctx = { value: null };
      expect(evaluateCondition('value != null', ctx)).toBe(false);
    });

    test('defined value != null should be true', () => {
      const ctx = { name: 'John' };
      expect(evaluateCondition('name != null', ctx)).toBe(true);
    });

    test('undefined != null should be false (both nullish)', () => {
      const ctx = {};
      expect(evaluateCondition('missing != null', ctx)).toBe(false);
    });
  });

  describe('numeric comparisons with null', () => {
    test('null > 0 should be false (toNumber(null) = 0)', () => {
      const ctx = { value: null };
      expect(evaluateCondition('value > 0', ctx)).toBe(false);
    });

    test('null >= 0 should be true (toNumber(null) = 0)', () => {
      const ctx = { value: null };
      expect(evaluateCondition('value >= 0', ctx)).toBe(true);
    });

    test('null < 1 should be true (toNumber(null) = 0)', () => {
      const ctx = { value: null };
      expect(evaluateCondition('value < 1', ctx)).toBe(true);
    });

    test('undefined < 1 should be true (toNumber(undefined) = 0)', () => {
      const ctx = {};
      expect(evaluateCondition('missing < 1', ctx)).toBe(true);
    });
  });

  describe('null with contains operator', () => {
    test('null contains "x" should be false', () => {
      const ctx = { value: null };
      expect(evaluateCondition('value contains "x"', ctx)).toBe(false);
    });

    test('undefined contains "x" should be false', () => {
      const ctx = {};
      expect(evaluateCondition('missing contains "x"', ctx)).toBe(false);
    });

    test('array contains null should check via isEqual', () => {
      const ctx = { items: [null, 'a', 'b'] };
      expect(evaluateCondition('items contains null', ctx)).toBe(true);
    });

    test('string contains undefined variable coerces to "undefined" string', () => {
      // 'missing' resolves to undefined, String(undefined) = "undefined"
      // so "hello undefined world" contains "undefined" → true
      const ctx = { text: 'hello undefined world' };
      expect(evaluateCondition('text contains missing', ctx)).toBe(true);
    });

    test('string without "undefined" does not contain undefined variable', () => {
      const ctx = { text: 'hello world' };
      expect(evaluateCondition('text contains missing', ctx)).toBe(false);
    });
  });

  describe('null with startsWith / endsWith', () => {
    test('null startsWith "x" should be false (String(null) = "null")', () => {
      const ctx = { value: null };
      // String(null) = "null", startsWith "x" = false
      expect(evaluateCondition('value startsWith "x"', ctx)).toBe(false);
    });

    test('null startsWith "null" should be true (String(null) = "null")', () => {
      const ctx = { value: null };
      expect(evaluateCondition('value startsWith "null"', ctx)).toBe(true);
    });

    test('undefined endsWith "x" should be false', () => {
      const ctx = {};
      expect(evaluateCondition('missing endsWith "x"', ctx)).toBe(false);
    });
  });

  describe('null with matches', () => {
    test('null matches any pattern should coerce to "null" string', () => {
      const ctx = { value: null };
      expect(evaluateCondition('value matches "^null$"', ctx)).toBe(true);
    });

    test('undefined matches pattern should coerce to "undefined" string', () => {
      const ctx = {};
      expect(evaluateCondition('missing matches "^undefined$"', ctx)).toBe(true);
    });
  });

  describe('null with IS SET / IS NOT SET', () => {
    test('null IS SET should be false', () => {
      const ctx = { value: null };
      expect(evaluateCondition('value IS SET', ctx)).toBe(false);
    });

    test('null IS NOT SET should be true', () => {
      const ctx = { value: null };
      expect(evaluateCondition('value IS NOT SET', ctx)).toBe(true);
    });

    test('zero IS SET should be true (0 is not null)', () => {
      const ctx = { count: 0 };
      expect(evaluateCondition('count IS SET', ctx)).toBe(true);
    });

    test('false IS SET should be true (false is not null)', () => {
      const ctx = { flag: false };
      expect(evaluateCondition('flag IS SET', ctx)).toBe(true);
    });

    test('empty array IS SET should be true', () => {
      const ctx = { items: [] };
      expect(evaluateCondition('items IS SET', ctx)).toBe(true);
    });

    test('empty object IS SET should be true', () => {
      const ctx = { data: {} };
      expect(evaluateCondition('data IS SET', ctx)).toBe(true);
    });
  });

  describe('null with is_number', () => {
    test('null is_number should be false', () => {
      const ctx = { value: null };
      expect(evaluateCondition('value is_number', ctx)).toBe(false);
    });

    test('undefined is_number should be false', () => {
      const ctx = {};
      expect(evaluateCondition('missing is_number', ctx)).toBe(false);
    });
  });

  describe('null in truthiness check', () => {
    test('null as bare expression should be false', () => {
      const ctx = { value: null };
      expect(evaluateCondition('value', ctx)).toBe(false);
    });

    test('undefined as bare expression should be false', () => {
      const ctx = {};
      expect(evaluateCondition('missing', ctx)).toBe(false);
    });

    test('zero as bare expression should be false', () => {
      const ctx = { count: 0 };
      expect(evaluateCondition('count', ctx)).toBe(false);
    });

    test('empty string as bare expression should be false', () => {
      const ctx = { name: '' };
      expect(evaluateCondition('name', ctx)).toBe(false);
    });

    test('empty array as bare expression should be false', () => {
      const ctx = { items: [] };
      expect(evaluateCondition('items', ctx)).toBe(false);
    });

    test('empty object as bare expression should be false', () => {
      const ctx = { data: {} };
      expect(evaluateCondition('data', ctx)).toBe(false);
    });

    test('"false" string as bare expression should be false', () => {
      const ctx = { value: 'false' };
      expect(evaluateCondition('value', ctx)).toBe(false);
    });

    test('non-empty string as bare expression should be true', () => {
      const ctx = { name: 'hello' };
      expect(evaluateCondition('name', ctx)).toBe(true);
    });

    test('non-zero number as bare expression should be true', () => {
      const ctx = { count: 42 };
      expect(evaluateCondition('count', ctx)).toBe(true);
    });

    test('non-empty array as bare expression should be true', () => {
      const ctx = { items: [1] };
      expect(evaluateCondition('items', ctx)).toBe(true);
    });
  });
});

// =============================================================================
// COMPLEX CONDITIONAL EXPRESSION COMBINATIONS
// =============================================================================

describe('Complex conditional expression combinations', () => {
  describe('AND with null values', () => {
    test('null AND defined: should short-circuit false', () => {
      const ctx = { name: 'John' };
      expect(evaluateCondition('missing IS SET AND name == "John"', ctx)).toBe(false);
    });

    test('defined AND null check: second clause with null field', () => {
      const ctx = { name: 'John', email: null };
      expect(evaluateCondition('name == "John" AND email IS SET', ctx)).toBe(false);
    });

    test('both null fields in AND', () => {
      const ctx = {};
      expect(evaluateCondition('a IS SET AND b IS SET', ctx)).toBe(false);
    });

    test('AND with null equality on both sides', () => {
      const ctx = { a: null, b: null };
      expect(evaluateCondition('a == null AND b == null', ctx)).toBe(true);
    });
  });

  describe('OR with null values', () => {
    test('null field OR valid field: should pass via second clause', () => {
      const ctx = { name: 'John' };
      expect(evaluateCondition('missing IS SET OR name == "John"', ctx)).toBe(true);
    });

    test('null OR null: both IS SET checks fail', () => {
      const ctx = {};
      expect(evaluateCondition('a IS SET OR b IS SET', ctx)).toBe(false);
    });

    test('defined OR null: passes via first clause', () => {
      const ctx = { name: 'John' };
      expect(evaluateCondition('name IS SET OR missing IS SET', ctx)).toBe(true);
    });

    test('null comparison OR valid comparison', () => {
      const ctx = { age: 25 };
      expect(evaluateCondition('missing > 5 OR age >= 18', ctx)).toBe(true);
    });
  });

  describe('NOT with null values', () => {
    test('NOT null IS SET should be true', () => {
      const ctx = {};
      expect(evaluateCondition('NOT missing IS SET', ctx)).toBe(true);
    });

    test('NOT defined IS SET should be false', () => {
      const ctx = { name: 'John' };
      expect(evaluateCondition('NOT name IS SET', ctx)).toBe(false);
    });

    test('NOT null value should be true (null is falsy)', () => {
      const ctx = { value: null };
      expect(evaluateCondition('NOT value', ctx)).toBe(true);
    });

    test('NOT non-empty value should be false', () => {
      const ctx = { value: 'hello' };
      expect(evaluateCondition('NOT value', ctx)).toBe(false);
    });

    test('! prefix with null should be true', () => {
      const ctx = { value: null };
      expect(evaluateCondition('!value', ctx)).toBe(true);
    });
  });

  describe('Multi-level AND/OR combinations', () => {
    test('A AND B OR C: should evaluate AND before OR', () => {
      // 'false AND true OR true' → (false AND true) evaluated first on AND branch
      // Actually the parser splits by AND first, then OR
      // 'a == 1 AND b == 2 OR c == 3' with a=0, b=2, c=3
      // Split by AND: ['a == 1', 'b == 2 OR c == 3']
      // a == 1 fails → AND fails. But wait - AND splits first, so:
      // AND parts: ['a == 1', 'b == 2 OR c == 3']
      // 'a == 1' = false, so AND fails overall
      const ctx = { a: 0, b: 2, c: 3 };
      expect(evaluateCondition('a == 1 AND b == 2 OR c == 3', ctx)).toBe(false);
    });

    test('A OR B AND C: OR evaluated after AND', () => {
      // 'a == 1 OR b == 2 AND c == 3' with a=1, b=0, c=0
      // AND splits first: ['a == 1 OR b == 2', 'c == 3']
      // 'c == 3' = false → AND fails
      const ctx = { a: 1, b: 0, c: 0 };
      expect(evaluateCondition('a == 1 OR b == 2 AND c == 3', ctx)).toBe(false);
    });

    test('(A OR B) AND C with parentheses', () => {
      const ctx = { a: 1, b: 0, c: 3 };
      expect(evaluateCondition('(a == 1 OR b == 2) AND c == 3', ctx)).toBe(true);
    });

    test('A AND (B OR C) with parentheses', () => {
      const ctx = { a: 1, b: 0, c: 3 };
      expect(evaluateCondition('a == 1 AND (b == 2 OR c == 3)', ctx)).toBe(true);
    });

    test('NOT (A AND B) should negate compound', () => {
      const ctx = { a: 1, b: 2 };
      expect(evaluateCondition('NOT (a == 1 AND b == 2)', ctx)).toBe(false);
      expect(evaluateCondition('NOT (a == 1 AND b == 3)', ctx)).toBe(true);
    });

    test('NOT (A OR B) should negate compound', () => {
      const ctx = { a: 0, b: 0 };
      expect(evaluateCondition('NOT (a == 1 OR b == 1)', ctx)).toBe(true);
    });
  });

  describe('Parenthesized expressions with null', () => {
    test('(null IS SET) AND true should be false', () => {
      const ctx = { valid: true };
      expect(evaluateCondition('(missing IS SET) AND valid == true', ctx)).toBe(false);
    });

    test('(null IS NOT SET) OR false should be true', () => {
      const ctx = {};
      expect(evaluateCondition('(missing IS NOT SET) OR false', ctx)).toBe(true);
    });

    test('(null == null) AND (defined == defined) should be true', () => {
      const ctx = { a: null, b: 'hello' };
      expect(evaluateCondition('(a == null) AND (b == "hello")', ctx)).toBe(true);
    });

    test('nested parens with null: ((A OR B) AND C)', () => {
      const ctx = { a: null, c: true };
      expect(evaluateCondition('((a IS SET OR missing IS SET) AND c == true)', ctx)).toBe(false);
    });
  });

  describe('Mixed operator types in single expression', () => {
    test('IS SET AND comparison AND contains', () => {
      const ctx = { name: 'John Doe', age: 25 };
      expect(evaluateCondition('name IS SET AND age >= 18 AND name contains "John"', ctx)).toBe(
        true,
      );
    });

    test('IS SET guard with numeric comparison', () => {
      const ctx = { amount: 150 };
      expect(evaluateCondition('amount IS SET AND amount > 100', ctx)).toBe(true);
    });

    test('IS SET guard fails, short-circuits numeric comparison', () => {
      const ctx = {};
      expect(evaluateCondition('amount IS SET AND amount > 100', ctx)).toBe(false);
    });

    test('multiple IS NOT SET with OR', () => {
      const ctx = { a: 'set' };
      expect(evaluateCondition('a IS NOT SET OR b IS NOT SET OR c IS NOT SET', ctx)).toBe(true);
    });

    test('all fields IS NOT SET with OR should be true when none are set', () => {
      const ctx = {};
      expect(evaluateCondition('a IS NOT SET OR b IS NOT SET', ctx)).toBe(true);
    });

    test('all fields IS SET with AND should fail when any is missing', () => {
      const ctx = { a: 'set' };
      expect(evaluateCondition('a IS SET AND b IS SET AND c IS SET', ctx)).toBe(false);
    });

    test('all fields IS SET with AND should pass when all present', () => {
      const ctx = { a: 'x', b: 'y', c: 'z' };
      expect(evaluateCondition('a IS SET AND b IS SET AND c IS SET', ctx)).toBe(true);
    });
  });
});

// =============================================================================
// CONSTRAINT EXECUTOR WITH NULL/CORRECT/INCORRECT VALUES
// =============================================================================

describe('Constraint executor with null and mixed values', () => {
  const executor = new ConstraintExecutor();

  describe('Constraints with null context values', () => {
    test('constraint on null field should fail when expecting IS SET', async () => {
      const ctx = makeContext(
        makeConstraints([
          { condition: 'destination IS SET', on_fail: respond('Please provide a destination') },
        ]),
        [],
        { destination: null },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBe('destination IS SET');
    });

    test('constraint on null field should pass with IS NOT SET', async () => {
      const ctx = makeContext(
        makeConstraints([{ condition: 'preference IS NOT SET', on_fail: respond('Unexpected') }]),
        [],
        { preference: null },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBeUndefined();
    });

    test('constraint comparing null to null should pass', async () => {
      const ctx = makeContext(
        makeConstraints([{ condition: 'value == null', on_fail: respond('Should not fail') }]),
        [],
        { value: null },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBeUndefined();
    });

    test('constraint comparing defined to null should fail equality', async () => {
      const ctx = makeContext(
        makeConstraints([{ condition: 'name == null', on_fail: respond('Name is set') }]),
        [],
        { name: 'John' },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBe('name == null');
    });
  });

  describe('Constraints with correct values', () => {
    test('all constraints pass with correct values', async () => {
      const ctx = makeContext(
        makeConstraints([
          { condition: 'guests > 0', on_fail: respond('Need guests') },
          { condition: 'guests <= 10', on_fail: respond('Too many') },
          { condition: 'destination IS SET', on_fail: respond('Need destination') },
          { condition: 'destination != origin', on_fail: respond('Same dest and origin') },
        ]),
        [],
        { guests: 3, destination: 'Paris', origin: 'London' },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBeUndefined();
    });

    test('boundary value passes (exactly at limit)', async () => {
      const ctx = makeContext(
        makeConstraints([
          { condition: 'count <= 100', on_fail: respond('Over limit') },
          { condition: 'count >= 1', on_fail: respond('Under limit') },
        ]),
        [],
        { count: 100 },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBeUndefined();
    });
  });

  describe('Constraints with incorrect values', () => {
    test('numeric constraint fails with value over limit', async () => {
      const ctx = makeContext(
        makeConstraints([{ condition: 'amount <= 1000', on_fail: respond('Amount too high') }]),
        [],
        { amount: 1500 },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBe('amount <= 1000');
    });

    test('string inequality fails when values are equal', async () => {
      const ctx = makeContext(
        makeConstraints([{ condition: 'destination != origin', on_fail: respond('Same places') }]),
        [],
        { destination: 'Paris', origin: 'Paris' },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBe('destination != origin');
    });

    test('empty string fails non-empty check', async () => {
      const ctx = makeContext(
        makeConstraints([{ condition: 'name != ""', on_fail: respond('Name required') }]),
        [],
        { name: '' },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBe('name != ""');
    });
  });

  describe('Constraints with mixed correct and incorrect values', () => {
    test('first constraint passes, second fails', async () => {
      const ctx = makeContext(
        makeConstraints([
          { condition: 'destination IS SET', on_fail: respond('Need destination') },
          { condition: 'guests <= 10', on_fail: respond('Too many guests') },
          { condition: 'guests > 0', on_fail: respond('Need at least one guest') },
        ]),
        [],
        { destination: 'Paris', guests: 15 },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBe('guests <= 10');
    });

    test('first two pass, third fails', async () => {
      const ctx = makeContext(
        makeConstraints([
          { condition: 'destination IS SET', on_fail: respond('Need destination') },
          { condition: 'guests <= 10', on_fail: respond('Too many guests') },
          { condition: 'guests > 0', on_fail: respond('Need at least one guest') },
        ]),
        [],
        { destination: 'Paris', guests: 0 },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBe('guests > 0');
    });

    test('all pass when all values are valid', async () => {
      const ctx = makeContext(
        makeConstraints([
          { condition: 'destination IS SET', on_fail: respond('Need destination') },
          { condition: 'guests <= 10', on_fail: respond('Too many guests') },
          { condition: 'guests > 0', on_fail: respond('Need at least one guest') },
        ]),
        [],
        { destination: 'Paris', guests: 5 },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBeUndefined();
    });
  });

  describe('Multiple on_fail action types', () => {
    test('respond action on constraint failure', async () => {
      const ctx = makeContext(
        makeConstraints([{ condition: 'valid == true', on_fail: respond('Invalid') }]),
        [],
        { valid: false },
      );
      const result = await executor.execute(ctx, {});
      expect(result.action.type).toBe('respond');
    });

    test('block action on constraint failure', async () => {
      const ctx = makeContext(
        makeConstraints([{ condition: 'allowed == true', on_fail: block('Not allowed') }]),
        [],
        { allowed: false },
      );
      const result = await executor.execute(ctx, {});
      expect(result.action.type).toBe('block');
    });

    test('escalate action on constraint failure', async () => {
      const ctx = makeContext(
        makeConstraints([
          { condition: 'amount <= 10000', on_fail: escalate('High value transaction') },
        ]),
        [],
        { amount: 50000 },
      );
      const result = await executor.execute(ctx, {});
      expect(result.action.type).toBe('escalate');
    });
  });
});

// =============================================================================
// ALL CONSTRAINTS FIRE EVERY TURN — IS SET GUARDS HANDLE PARTIAL DATA
// =============================================================================

describe('All constraints fire every turn (no phases, no applies_when)', () => {
  const executor = new ConstraintExecutor();

  describe('IS SET guards prevent false failures on partial data', () => {
    test('IS SET guard prevents failure when field is not yet collected', async () => {
      // With the flat constraint system, all constraints fire every turn.
      // IS SET guards handle partial data — if destination is not set yet,
      // a constraint like "destination IS SET AND destination != origin"
      // would fail on the IS SET guard, which is expected behavior.
      const ctx = makeContext(
        makeConstraints([
          { condition: 'destination IS SET', on_fail: respond('Need destination') },
        ]),
        [],
        { destination: null },
      );
      const result = await executor.execute(ctx, {});
      // The constraint fires and fails because destination IS NOT SET
      expect(result.metadata?.failedConstraint).toBe('destination IS SET');
    });

    test('constraint passes once field is collected', async () => {
      const ctx = makeContext(
        makeConstraints([
          { condition: 'destination IS SET', on_fail: respond('Need destination') },
        ]),
        [],
        { destination: 'Paris' },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBeUndefined();
    });

    test('multiple constraints all fire — short-circuit on first failure', async () => {
      const ctx = makeContext(
        makeConstraints([
          { condition: 'query IS SET', on_fail: respond('Need query') },
          { condition: 'selection IS SET', on_fail: respond('Need selection') },
        ]),
        [],
        {},
      );
      const result = await executor.execute(ctx, {});
      // First constraint fails, short-circuits before second
      expect(result.metadata?.failedConstraint).toBe('query IS SET');
    });

    test('first constraint passes, second fails', async () => {
      const ctx = makeContext(
        makeConstraints([
          { condition: 'query IS SET', on_fail: respond('Need query') },
          { condition: 'selection IS SET', on_fail: respond('Need selection') },
        ]),
        [],
        { query: 'hotels in Paris' },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBe('selection IS SET');
    });

    test('all constraints pass when all data is collected', async () => {
      const ctx = makeContext(
        makeConstraints([
          { condition: 'query IS SET', on_fail: respond('Need query') },
          { condition: 'selection IS SET', on_fail: respond('Need selection') },
        ]),
        [],
        { query: 'hotels in Paris', selection: 'Hotel A' },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBeUndefined();
    });
  });

  describe('Constraints with boolean conditions', () => {
    test('constraint with boolean check fires and fails', async () => {
      const ctx = makeContext(
        makeConstraints([{ condition: 'email IS SET', on_fail: respond('Need email') }]),
        [],
        { needs_verification: true },
      );
      const result = await executor.execute(ctx, {});
      // Constraint fires (all fire every turn) and email is not set
      expect(result.metadata?.failedConstraint).toBe('email IS SET');
    });

    test('constraint always fires regardless of other context values', async () => {
      const ctx = makeContext(
        makeConstraints([{ condition: 'valid == true', on_fail: respond('Invalid') }]),
        [],
        { valid: false },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBe('valid == true');
    });

    test('constraint always fires and passes when condition is met', async () => {
      const ctx = makeContext(
        makeConstraints([{ condition: 'valid == true', on_fail: respond('Invalid') }]),
        [],
        { valid: true },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBeUndefined();
    });
  });

  describe('Complex conditions with AND/OR/NOT', () => {
    test('AND constraint fails when one part is false', async () => {
      const ctx = makeContext(
        makeConstraints([{ condition: 'amount <= 500', on_fail: respond('Too much') }]),
        [],
        { mode: 'strict', level: 'high', amount: 1000 },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBe('amount <= 500');
    });

    test('constraint with OR passes when either branch is true', async () => {
      const ctx = makeContext(
        makeConstraints([{ condition: 'count <= 5', on_fail: respond('Over limit') }]),
        [],
        { tier: 'free', count: 10 },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBe('count <= 5');
    });

    test('NOT condition in constraint', async () => {
      const ctx = makeContext(
        makeConstraints([{ condition: 'NOT is_admin', on_fail: respond('Admin detected') }]),
        [],
        { is_admin: true },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBe('NOT is_admin');
    });

    test('NOT condition passes when variable is falsy', async () => {
      const ctx = makeContext(
        makeConstraints([{ condition: 'NOT banned', on_fail: respond('Account banned') }]),
        [],
        { banned: false },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBeUndefined();
    });
  });

  describe('Constraints with null context values and IS SET guards', () => {
    test('IS SET guard with null variable fails constraint', async () => {
      const ctx = makeContext(
        makeConstraints([{ condition: 'price > 0', on_fail: respond('Invalid price') }]),
        [],
        { selected_item: null, price: -5 },
      );
      const result = await executor.execute(ctx, {});
      // All constraints fire every turn — price > 0 fails
      expect(result.metadata?.failedConstraint).toBe('price > 0');
    });

    test('IS SET guard with defined variable applies constraint', async () => {
      const ctx = makeContext(
        makeConstraints([{ condition: 'price > 0', on_fail: respond('Invalid price') }]),
        [],
        { selected_item: 'Hotel A', price: -5 },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBe('price > 0');
    });

    test('constraint on undefined field fires and evaluates', async () => {
      const ctx = makeContext(
        makeConstraints([{ condition: 'x > 0', on_fail: respond('Bad') }]),
        [],
        { x: -1 },
      );
      const result = await executor.execute(ctx, {});
      // All constraints fire — no phase skipping
      expect(result.metadata?.failedConstraint).toBe('x > 0');
    });
  });

  describe('Multiple constraints — all fire, short-circuit on first failure', () => {
    test('first constraint fails, stops before second', async () => {
      const ctx = makeContext(
        makeConstraints([
          { condition: 'banned != true', on_fail: respond('Banned') },
          { condition: 'query IS SET', on_fail: respond('Need query') },
        ]),
        [],
        { banned: true, step: 'search' },
      );
      const result = await executor.execute(ctx, {});
      // First constraint fails, short-circuits
      expect(result.metadata?.failedConstraint).toBe('banned != true');
    });

    test('first passes, second fails', async () => {
      const ctx = makeContext(
        makeConstraints([
          { condition: 'banned != true', on_fail: respond('Banned') },
          { condition: 'query IS SET', on_fail: respond('Need query') },
        ]),
        [],
        { banned: false },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBe('query IS SET');
    });

    test('all constraints pass', async () => {
      const ctx = makeContext(
        makeConstraints([
          { condition: 'banned != true', on_fail: respond('Banned') },
          { condition: 'query IS SET', on_fail: respond('Need query') },
        ]),
        [],
        { banned: false, query: 'search term' },
      );
      const result = await executor.execute(ctx, {});
      expect(result.metadata?.failedConstraint).toBeUndefined();
    });
  });
});

// =============================================================================
// GUARDRAILS WITH NULL AND MIXED VALUES
// =============================================================================

describe('Guardrails with null and mixed values', () => {
  const executor = new ConstraintExecutor();

  test('guardrail with null field in check passes when null is expected', async () => {
    const ctx = makeContext(
      [],
      [
        {
          name: 'no_override',
          description: 'Prevent overrides',
          check: 'override IS SET',
          action: block('Override attempted'),
        },
      ],
      { override: null },
    );
    const result = await executor.execute(ctx, {});
    expect(result.metadata?.failedGuardrail).toBeUndefined();
  });

  test('guardrail with defined field fails IS NOT SET check', async () => {
    const ctx = makeContext(
      [],
      [
        {
          name: 'no_override',
          description: 'Prevent overrides',
          check: 'override IS SET',
          action: block('Override attempted'),
        },
      ],
      { override: 'force' },
    );
    const result = await executor.execute(ctx, {});
    expect(result.metadata?.failedGuardrail).toBe('no_override');
  });

  test('guardrail runs before constraints and blocks first', async () => {
    const ctx = makeContext(
      makeConstraints([{ condition: 'value > 0', on_fail: respond('Bad value') }]),
      [
        {
          name: 'safety',
          description: 'Safety check',
          check: 'safe == false',
          action: block('Unsafe'),
        },
      ],
      { safe: false, value: -1 },
    );
    const result = await executor.execute(ctx, {});
    // Guardrail fails first
    expect(result.metadata?.failedAt).toBe('guardrail');
    expect(result.metadata?.failedGuardrail).toBe('safety');
  });

  test('multiple guardrails - first failure stops', async () => {
    const ctx = makeContext(
      [],
      [
        {
          name: 'no_pii',
          description: 'No PII',
          check: 'has_pii == true',
          action: block('PII detected'),
        },
        {
          name: 'rate_limit',
          description: 'Rate limiting',
          check: 'requests >= 100',
          action: respond('Rate limited'),
        },
      ],
      { has_pii: true, requests: 200 },
    );
    const result = await executor.execute(ctx, {});
    expect(result.metadata?.failedGuardrail).toBe('no_pii');
  });

  test('guardrail passes, constraint fails', async () => {
    const ctx = makeContext(
      makeConstraints([{ condition: 'amount <= 1000', on_fail: respond('Over limit') }]),
      [
        {
          name: 'auth',
          description: 'Auth check',
          check: 'authenticated == false',
          action: block('Not authenticated'),
        },
      ],
      { authenticated: true, amount: 5000 },
    );
    const result = await executor.execute(ctx, {});
    expect(result.metadata?.failedGuardrail).toBeUndefined();
    expect(result.metadata?.failedConstraint).toBe('amount <= 1000');
  });
});

// =============================================================================
// EVALUATOR DETAILED WITH NULL VALUES
// =============================================================================

describe('evaluateConditionDetailed with null values', () => {
  test('detail for null == null comparison', () => {
    const detail = evaluateConditionDetailed('val == null', '', { val: null });
    expect(detail.matched).toBe(true);
    expect(detail.conditionType).toBe('variable_comparison');
    expect(detail.operator).toBe('==');
  });

  test('detail for defined != null', () => {
    const detail = evaluateConditionDetailed('name != null', '', { name: 'John' });
    expect(detail.matched).toBe(true);
    expect(detail.operator).toBe('!=');
  });

  test('detail for IS SET with null value', () => {
    const detail = evaluateConditionDetailed('val IS SET', '', { val: null });
    expect(detail.matched).toBe(false);
    expect(detail.conditionType).toBe('is_set');
  });

  test('detail for IS NOT SET with undefined', () => {
    const detail = evaluateConditionDetailed('missing IS NOT SET', '', {});
    expect(detail.matched).toBe(true);
    expect(detail.conditionType).toBe('is_not_set');
  });

  test('detail for AND with null branch', () => {
    const detail = evaluateConditionDetailed('a IS SET AND b == 1', '', { b: 1 });
    expect(detail.matched).toBe(false);
    expect(detail.conditionType).toBe('compound_and');
  });

  test('detail for OR with null and valid branch', () => {
    const detail = evaluateConditionDetailed('missing IS SET OR name == "John"', '', {
      name: 'John',
    });
    expect(detail.matched).toBe(true);
    expect(detail.conditionType).toBe('compound_or');
  });
});

// =============================================================================
// CONDITION LIST AND MULTI-CONDITION WITH NULL
// =============================================================================

describe('Condition list and multi-condition with null', () => {
  test('evaluateConditions with null values in context', () => {
    const ctx = { a: null, b: 'hello', c: undefined };
    const results = evaluateConditions(
      ['a IS SET', 'b IS SET', 'c IS SET', 'a == null', 'b != null'],
      ctx as Record<string, unknown>,
    );

    expect(results['a IS SET']).toBe(false);
    expect(results['b IS SET']).toBe(true);
    expect(results['c IS SET']).toBe(false);
    expect(results['a == null']).toBe(true);
    expect(results['b != null']).toBe(true);
  });

  test('evaluateConditionList with null values choosing correct branch', () => {
    const ctx = { status: null, fallback: 'active' };
    const conditions = [
      { when: 'status == "active"', result: 'status-active' },
      { when: 'status == null', result: 'status-null' },
      { when: 'fallback == "active"', result: 'fallback-active' },
    ];
    expect(evaluateConditionList(conditions, ctx as Record<string, unknown>)).toBe('status-null');
  });

  test('evaluateConditionList falls to default when all involve null', () => {
    const ctx = {};
    const conditions = [
      { when: 'a == "yes"', result: 'a' },
      { when: 'b == "yes"', result: 'b' },
    ];
    expect(evaluateConditionList(conditions, ctx, 'default')).toBe('default');
  });

  test('evaluateConditionWithInput with null context and valid input', () => {
    expect(evaluateConditionWithInput('input IS SET AND input != ""', 'hello', {})).toBe(true);
  });

  test('evaluateConditionWithInput with empty input', () => {
    expect(evaluateConditionWithInput('input IS SET AND input != ""', '', {})).toBe(false);
  });

  test('evaluateConditionWithInput null context field with input check', () => {
    expect(
      evaluateConditionWithInput('input contains "book" AND destination IS SET', 'I want to book', {
        destination: null,
      }),
    ).toBe(false);
  });
});

// =============================================================================
// RECORD-ONLY MODE WITH MIXED VALUES
// =============================================================================

describe('Record-only mode with mixed values', () => {
  const executor = new ConstraintExecutor();

  test('recordOnly collects all failures without stopping', async () => {
    const ctx = makeContext(
      makeConstraints([
        { condition: 'name IS SET', on_fail: respond('Need name') },
        { condition: 'age > 0', on_fail: respond('Need age') },
        { condition: 'email IS SET', on_fail: respond('Need email') },
      ]),
      [],
      { name: null, age: 0, email: null },
    );
    const result = await executor.execute(ctx, {
      recordOnly: true,
    });
    // All three should fail, and all should be recorded
    expect(result.metadata?.failures).toBe(3);
    const details = result.metadata?.failureDetails as Array<{ constraint: string }>;
    expect(details).toHaveLength(3);
    expect(details[0].constraint).toBe('name IS SET');
    expect(details[1].constraint).toBe('age > 0');
    expect(details[2].constraint).toBe('email IS SET');
  });

  test('recordOnly with mixed pass/fail', async () => {
    const ctx = makeContext(
      makeConstraints([
        { condition: 'name IS SET', on_fail: respond('Need name') },
        { condition: 'age > 0', on_fail: respond('Need age') },
        { condition: 'email IS SET', on_fail: respond('Need email') },
      ]),
      [],
      { name: 'John', age: 0, email: 'john@test.com' },
    );
    const result = await executor.execute(ctx, {
      recordOnly: true,
    });
    expect(result.metadata?.failures).toBe(1);
    const details = result.metadata?.failureDetails as Array<{ constraint: string }>;
    expect(details).toHaveLength(1);
    expect(details[0].constraint).toBe('age > 0');
  });

  test('recordOnly with all passing', async () => {
    const ctx = makeContext(
      makeConstraints([
        { condition: 'name IS SET', on_fail: respond('Need name') },
        { condition: 'age > 0', on_fail: respond('Need age') },
      ]),
      [],
      { name: 'John', age: 25 },
    );
    const result = await executor.execute(ctx, {
      recordOnly: true,
    });
    expect(result.metadata?.failures).toBe(0);
  });
});
