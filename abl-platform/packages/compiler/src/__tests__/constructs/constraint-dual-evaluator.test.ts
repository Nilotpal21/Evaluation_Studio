/**
 * Tests for Constraint Executor with Dual CEL Evaluator
 *
 * Validates:
 * 1. CEL syntax in constraint conditions (via evaluateConditionDual)
 * 2. IS SET guard semantics with dual evaluator
 * 3. shortCircuit option (true/false)
 * 4. onCheck trace callback includes guardSkipped info
 */

import { describe, test, expect } from 'vitest';
import { checkConstraintsCore } from '../../platform/constructs/executors/constraint-executor.js';
import type { ConstraintCheckInfo } from '../../platform/constructs/executors/constraint-executor.js';
import { evaluateConditionDual } from '../../platform/constructs/dual-evaluator.js';
import type { Constraint, Guardrail, ConstraintConfig } from '../../platform/ir/schema.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeConfig(
  constraints: Constraint[] = [],
  guardrails: Guardrail[] = [],
): ConstraintConfig {
  return { constraints, guardrails };
}

// =============================================================================
// 1. CEL SYNTAX IN CONSTRAINT CONDITIONS
// =============================================================================

describe('CEL syntax in constraint conditions', () => {
  test('should evaluate a CEL condition with && operator', () => {
    const config = makeConfig([
      {
        condition: 'age >= 18 && name != ""',
        on_fail: { type: 'respond', message: 'Must be 18+ with name' },
      },
    ]);

    // Pass case
    const passResult = checkConstraintsCore(
      config,
      { age: 25, name: 'Alice' },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(passResult).toBeNull();

    // Fail case
    const failResult = checkConstraintsCore(
      config,
      { age: 16, name: 'Bob' },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(failResult).not.toBeNull();
    expect(failResult!.passed).toBe(false);
  });

  test('should evaluate CEL with abl.* functions in constraints', () => {
    const config = makeConfig([
      {
        condition: 'abl.upper(status) == "ACTIVE"',
        on_fail: { type: 'block', message: 'Must be active' },
      },
    ]);

    const passResult = checkConstraintsCore(
      config,
      { status: 'active' },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(passResult).toBeNull();

    const failResult = checkConstraintsCore(
      config,
      { status: 'inactive' },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(failResult).not.toBeNull();
  });

  test('should evaluate CEL guardrail condition', () => {
    const config = makeConfig(
      [],
      [
        {
          name: 'cel_guard',
          description: 'CEL guardrail',
          check: 'risk_score >= 80 || verified == false',
          action: { type: 'block', message: 'Risk too high' },
        },
      ],
    );

    const passResult = checkConstraintsCore(
      config,
      { risk_score: 50, verified: true },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(passResult).toBeNull();

    const failResult = checkConstraintsCore(
      config,
      { risk_score: 90, verified: true },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(failResult).not.toBeNull();
    expect(failResult!.type).toBe('guardrail');
  });
});

// =============================================================================
// 2. IS SET GUARD SEMANTICS WITH DUAL EVALUATOR
// =============================================================================

describe('IS SET guard semantics with dual evaluator', () => {
  test('guard not met — constraint is not applicable (returns null)', () => {
    const config = makeConfig([
      {
        condition: 'destination IS SET AND origin IS SET AND destination != origin',
        on_fail: { type: 'respond', message: 'Same dest and origin' },
      },
    ]);

    // origin not set -> guard not met -> not applicable -> null
    const result = checkConstraintsCore(
      config,
      { destination: 'Paris' },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result).toBeNull();
  });

  test('guard met + value assertion passes — returns null', () => {
    const config = makeConfig([
      {
        condition: 'destination IS SET AND origin IS SET AND destination != origin',
        on_fail: { type: 'respond', message: 'Same dest and origin' },
      },
    ]);

    const result = checkConstraintsCore(
      config,
      { destination: 'Paris', origin: 'London' },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result).toBeNull();
  });

  test('guard met + value assertion fails — returns violation', () => {
    const config = makeConfig([
      {
        condition: 'destination IS SET AND origin IS SET AND destination != origin',
        on_fail: { type: 'respond', message: 'Same dest and origin' },
      },
    ]);

    const result = checkConstraintsCore(
      config,
      { destination: 'Paris', origin: 'Paris' },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false);
  });

  test('multiple guards — all must pass for assertions to be checked', () => {
    const config = makeConfig([
      {
        condition: 'a IS SET AND b IS SET AND c IS SET AND a + b == c',
        on_fail: { type: 'respond', message: 'a + b must equal c' },
      },
    ]);

    // Only a is set -> guards not all met -> not applicable
    const result1 = checkConstraintsCore(
      config,
      { a: 1 },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result1).toBeNull();

    // All set, assertion passes
    const result2 = checkConstraintsCore(
      config,
      { a: 1, b: 2, c: 3 },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result2).toBeNull();

    // All set, assertion fails
    const result3 = checkConstraintsCore(
      config,
      { a: 1, b: 2, c: 10 },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result3).not.toBeNull();
    expect(result3!.passed).toBe(false);
  });

  test('CEL function in assertion part evaluates correctly with guards', () => {
    const config = makeConfig([
      {
        condition: 'name IS SET AND abl.upper(name) != "ADMIN"',
        on_fail: { type: 'block', message: 'Admin not allowed' },
      },
    ]);

    // Guard not met
    const result1 = checkConstraintsCore(
      config,
      {},
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result1).toBeNull();

    // Guard met, assertion passes
    const result2 = checkConstraintsCore(
      config,
      { name: 'alice' },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result2).toBeNull();

    // Guard met, assertion fails
    const result3 = checkConstraintsCore(
      config,
      { name: 'admin' },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result3).not.toBeNull();
    expect(result3!.passed).toBe(false);
  });

  test('has() guard syntax works as a guard', () => {
    const config = makeConfig([
      {
        condition: 'has(email) && email != ""',
        on_fail: { type: 'respond', message: 'Email required' },
      },
    ]);

    // Guard not met (email not set) — via CEL && split
    const result1 = checkConstraintsCore(
      config,
      {},
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result1).toBeNull();

    // Guard met, assertion passes
    const result2 = checkConstraintsCore(
      config,
      { email: 'a@b.com' },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result2).toBeNull();

    // Guard met, assertion fails
    const result3 = checkConstraintsCore(
      config,
      { email: '' },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result3).not.toBeNull();
  });

  test('dotted-path != null guard is detected for cross-referenced identifiers', () => {
    // user.name != null should be treated as a guard when user.name appears
    // in a value assertion in the same AND chain
    const config = makeConfig([
      {
        condition: 'user.name != null && user.name != "admin"',
        on_fail: { type: 'block', message: 'Admin not allowed' },
      },
    ]);

    // Guard not met (user.name not set) — not applicable
    const result1 = checkConstraintsCore(
      config,
      {},
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result1).toBeNull();

    // Guard met, assertion passes
    const result2 = checkConstraintsCore(
      config,
      { user: { name: 'alice' } },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result2).toBeNull();

    // Guard met, assertion fails
    const result3 = checkConstraintsCore(
      config,
      { user: { name: 'admin' } },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result3).not.toBeNull();
    expect(result3!.passed).toBe(false);
  });

  test('parenthesized assertion is not split by inner AND/&&', () => {
    const config = makeConfig([
      {
        condition: 'x IS SET AND (x > 0 AND x < 100)',
        on_fail: { type: 'respond', message: 'Out of range' },
      },
    ]);

    // Guard not met
    const result1 = checkConstraintsCore(
      config,
      {},
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result1).toBeNull();

    // Guard met, assertion passes
    const result2 = checkConstraintsCore(
      config,
      { x: 50 },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result2).toBeNull();

    // Guard met, assertion fails
    const result3 = checkConstraintsCore(
      config,
      { x: 200 },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result3).not.toBeNull();
  });

  test('IS NOT SET is NOT a guard — it is a value assertion', () => {
    const config = makeConfig([
      {
        condition: 'banned IS NOT SET AND age >= 18',
        on_fail: { type: 'block', message: 'Blocked' },
      },
    ]);

    // Both parts are assertions (IS NOT SET is not a guard).
    // Neither IS SET nor has() pattern -> no guard -> evaluate entire expression.
    // "banned" is not set -> IS NOT SET is true, age >= 18 is true -> passes
    const result1 = checkConstraintsCore(
      config,
      { age: 20 },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result1).toBeNull();

    // banned is set -> IS NOT SET is false -> fails
    const result2 = checkConstraintsCore(
      config,
      { age: 20, banned: true },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result2).not.toBeNull();
    expect(result2!.passed).toBe(false);
  });

  test('pure IS SET chain evaluates normally (no guard skip)', () => {
    const config = makeConfig([
      {
        condition: 'name IS SET AND email IS SET',
        on_fail: { type: 'respond', message: 'Both fields required' },
      },
    ]);

    // Pure IS SET chain (no value assertions) -> evaluates normally, should fail
    const result1 = checkConstraintsCore(
      config,
      { name: 'Alice' },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result1).not.toBeNull();
    expect(result1!.passed).toBe(false);

    // Both set -> passes
    const result2 = checkConstraintsCore(
      config,
      { name: 'Alice', email: 'a@b.com' },
      {
        evaluateCondition: evaluateConditionDual,
      },
    );
    expect(result2).toBeNull();
  });
});

// =============================================================================
// 3. shortCircuit OPTION
// =============================================================================

describe('shortCircuit option', () => {
  test('shortCircuit: false collects all failures', () => {
    const config = makeConfig(
      [
        { condition: 'a > 0', on_fail: { type: 'respond', message: 'a failed' } },
        { condition: 'b > 0', on_fail: { type: 'respond', message: 'b failed' } },
      ],
      [
        {
          name: 'g1',
          description: 'Guard 1',
          check: 'x == false',
          action: { type: 'block', message: 'g1 fail' },
        },
      ],
    );

    const checks: ConstraintCheckInfo[] = [];
    const result = checkConstraintsCore(
      config,
      { x: false, a: -1, b: -1 },
      {
        shortCircuit: false,
        evaluateCondition: evaluateConditionDual,
        onCheck: (info) => checks.push(info),
      },
    );

    // All 3 checks should fire despite failures
    expect(checks).toHaveLength(3);
    expect(checks.filter((c) => !c.passed)).toHaveLength(3);

    // Returns first failure
    expect(result).not.toBeNull();
    expect(result!.type).toBe('guardrail');
    expect(result!.name).toBe('g1');
  });

  test('shortCircuit: true (default) stops at first failure', () => {
    const config = makeConfig(
      [
        { condition: 'a > 0', on_fail: { type: 'respond', message: 'a failed' } },
        { condition: 'b > 0', on_fail: { type: 'respond', message: 'b failed' } },
      ],
      [
        {
          name: 'g1',
          description: 'Guard 1',
          check: 'x == false',
          action: { type: 'block', message: 'g1 fail' },
        },
      ],
    );

    const checks: ConstraintCheckInfo[] = [];
    const result = checkConstraintsCore(
      config,
      { x: false, a: -1, b: -1 },
      {
        evaluateCondition: evaluateConditionDual,
        onCheck: (info) => checks.push(info),
      },
    );

    // Only 1 check fires (short-circuit on first guardrail failure)
    expect(checks).toHaveLength(1);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('guardrail');
    expect(result!.name).toBe('g1');
  });
});

// =============================================================================
// 4. onCheck TRACE CALLBACK INCLUDES GUARD INFO
// =============================================================================

describe('onCheck trace callback includes guard info', () => {
  test('guardSkipped is true when IS SET guard makes constraint not applicable', () => {
    const config = makeConfig([
      {
        condition: 'destination IS SET AND origin IS SET AND destination != origin',
        on_fail: { type: 'respond', message: 'Same dest' },
      },
    ]);

    const checks: ConstraintCheckInfo[] = [];
    checkConstraintsCore(
      config,
      { destination: 'Paris' }, // origin not set
      {
        evaluateCondition: evaluateConditionDual,
        onCheck: (info) => checks.push(info),
      },
    );

    expect(checks).toHaveLength(1);
    expect(checks[0].passed).toBe(true);
    expect(checks[0].guardSkipped).toBe(true);
  });

  test('guardSkipped is false for normal evaluation (no guards or guards pass)', () => {
    const config = makeConfig([
      {
        condition: 'destination IS SET AND origin IS SET AND destination != origin',
        on_fail: { type: 'respond', message: 'Same dest' },
      },
      {
        condition: 'age >= 18',
        on_fail: { type: 'block', message: 'Must be 18+' },
      },
    ]);

    const checks: ConstraintCheckInfo[] = [];
    checkConstraintsCore(
      config,
      { destination: 'Paris', origin: 'London', age: 25 },
      {
        evaluateCondition: evaluateConditionDual,
        shortCircuit: false,
        onCheck: (info) => checks.push(info),
      },
    );

    expect(checks).toHaveLength(2);
    // First constraint: guards pass, assertion passes
    expect(checks[0].passed).toBe(true);
    expect(checks[0].guardSkipped).toBe(false);
    // Second constraint: no guards at all
    expect(checks[1].passed).toBe(true);
    expect(checks[1].guardSkipped).toBe(false);
  });
});
