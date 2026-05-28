/**
 * Tests for Constraint Executor (Flat Constraint System)
 *
 * Tests flat constraint evaluation, guardrail-before-constraint ordering,
 * IS SET guard semantics, skip options, recordOnly mode, and action conversion.
 */

import { describe, test, expect, vi } from 'vitest';
import {
  ConstraintExecutor,
  checkConstraintsCore,
} from '../../platform/constructs/executors/constraint-executor.js';
import type {
  ConstraintCheckInfo,
  CheckConstraintsCoreOptions,
  ConstraintOptions,
} from '../../platform/constructs/executors/constraint-executor.js';
import type { ExecutionContext } from '../../platform/constructs/types.js';
import type {
  Constraint,
  Guardrail,
  ConstraintAction,
  ConstraintConfig,
} from '../../platform/ir/schema.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeConfig(
  constraints: Constraint[] = [],
  guardrails: Guardrail[] = [],
): ConstraintConfig {
  return { constraints, guardrails };
}

function makeContext(
  constraints: Constraint[] = [],
  guardrails: Guardrail[] = [],
  stateContext: Record<string, unknown> = {},
): ExecutionContext {
  return {
    agentIR: {
      constraints: makeConfig(constraints, guardrails),
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

function respondAction(message: string): ConstraintAction {
  return { type: 'respond', message };
}

function blockAction(message: string): ConstraintAction {
  return { type: 'block', message };
}

function escalateAction(reason: string): ConstraintAction {
  return { type: 'escalate', reason };
}

// =============================================================================
// checkConstraintsCore — standalone function
// =============================================================================

describe('checkConstraintsCore', () => {
  test('should return null when no constraints or guardrails defined', () => {
    const result = checkConstraintsCore(makeConfig(), {});
    expect(result).toBeNull();
  });

  test('should return null when constraints and guardrails are empty arrays', () => {
    const result = checkConstraintsCore(makeConfig([], []), { foo: 'bar' });
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Flat constraints fire every turn
  // ---------------------------------------------------------------------------

  test('should check all flat constraints every turn', () => {
    const config = makeConfig([
      { condition: 'num_guests <= 10', on_fail: respondAction('Too many guests') },
      { condition: 'destination != ""', on_fail: respondAction('Need destination') },
    ]);
    // Both constraints pass
    const result = checkConstraintsCore(config, {
      num_guests: 5,
      destination: 'Paris',
    });
    expect(result).toBeNull();
  });

  test('should return first failing constraint', () => {
    const config = makeConfig([
      { condition: 'num_guests <= 10', on_fail: respondAction('Too many guests') },
      { condition: 'destination != ""', on_fail: respondAction('Need destination') },
    ]);
    const result = checkConstraintsCore(config, {
      num_guests: 15,
      destination: '',
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe('constraint');
    expect(result!.condition).toBe('num_guests <= 10');
    expect(result!.passed).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Short-circuit on first failure
  // ---------------------------------------------------------------------------

  test('should short-circuit after first failure (no more checks)', () => {
    const config = makeConfig(
      [
        { condition: 'a == true', on_fail: respondAction('a failed') },
        { condition: 'b == true', on_fail: respondAction('b failed') },
      ],
      [
        {
          name: 'g1',
          description: 'Guard 1',
          check: 'x == true',
          action: blockAction('g1 fail'),
        },
        {
          name: 'g2',
          description: 'Guard 2',
          check: 'y == true',
          action: blockAction('g2 fail'),
        },
      ],
    );
    const checks: ConstraintCheckInfo[] = [];
    const result = checkConstraintsCore(
      config,
      { x: true, y: true, a: false, b: false },
      {
        onCheck: (info) => checks.push(info),
      },
    );
    expect(result).not.toBeNull();
    expect(result!.name).toBe('g1');
    // Only one check should have fired (short-circuit on first guardrail failure)
    expect(checks).toHaveLength(1);
  });

  test('should short-circuit on first constraint failure after guardrails pass', () => {
    const config = makeConfig(
      [
        { condition: 'a > 0', on_fail: respondAction('a must be positive') },
        { condition: 'b > 0', on_fail: respondAction('b must be positive') },
      ],
      [
        {
          name: 'g1',
          description: 'Guard 1',
          check: 'safe == false',
          action: blockAction('not safe'),
        },
      ],
    );
    const checks: ConstraintCheckInfo[] = [];
    checkConstraintsCore(
      config,
      { safe: true, a: -1, b: -1 },
      {
        onCheck: (info) => checks.push(info),
      },
    );
    // guardrail g1 passes, then constraint 'a > 0' fails -> short-circuit
    expect(checks).toHaveLength(2);
    expect(checks[0].type).toBe('guardrail');
    expect(checks[0].passed).toBe(true);
    expect(checks[1].type).toBe('constraint');
    expect(checks[1].passed).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // IS SET guard semantics
  // ---------------------------------------------------------------------------

  test('should pass when IS SET guard field is not yet collected', () => {
    const config = makeConfig([
      {
        condition: 'destination IS SET AND origin IS SET AND destination != origin',
        on_fail: respondAction('Same dest'),
      },
    ]);
    // origin not set -> guard not met -> not applicable -> null
    const result = checkConstraintsCore(config, { destination: 'Paris' });
    expect(result).toBeNull();
  });

  test('should fail when IS SET guards pass but value assertion fails', () => {
    const config = makeConfig([
      {
        condition: 'destination IS SET AND origin IS SET AND destination != origin',
        on_fail: respondAction('Same dest'),
      },
    ]);
    const result = checkConstraintsCore(config, { destination: 'Paris', origin: 'Paris' });
    expect(result).not.toBeNull();
    expect(result!.type).toBe('constraint');
    expect(result!.passed).toBe(false);
  });

  test('should pass when IS SET guards and value assertions both pass', () => {
    const config = makeConfig([
      {
        condition: 'destination IS SET AND origin IS SET AND destination != origin',
        on_fail: respondAction('Same dest'),
      },
    ]);
    const result = checkConstraintsCore(config, { destination: 'Paris', origin: 'London' });
    expect(result).toBeNull();
  });

  test('should pass when no fields are set for IS SET guards', () => {
    const config = makeConfig([
      {
        condition: 'destination IS SET AND origin IS SET AND destination != origin',
        on_fail: respondAction('Same dest'),
      },
    ]);
    const result = checkConstraintsCore(config, {});
    expect(result).toBeNull();
  });

  test('should evaluate normally when all parts are IS SET (no mixed guards)', () => {
    const config = makeConfig([
      {
        condition: 'destination IS SET AND origin IS SET',
        on_fail: respondAction('Both fields required'),
      },
    ]);
    // Pure IS SET chain (no value assertions) -> evaluates normally
    // origin not set -> should fail
    const result = checkConstraintsCore(config, { destination: 'Paris' });
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Guardrails before constraints
  // ---------------------------------------------------------------------------

  test('should check guardrails before constraints', () => {
    const config = makeConfig(
      [{ condition: 'num_guests <= 10', on_fail: respondAction('Too many guests') }],
      [
        {
          name: 'no_pii',
          description: 'Block PII',
          check: 'has_pii == true',
          action: blockAction('PII detected'),
        },
      ],
    );
    const result = checkConstraintsCore(config, {
      has_pii: true,
      num_guests: 15,
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe('guardrail');
    expect(result!.name).toBe('no_pii');
  });

  test('should return null when all guardrails pass and no constraints', () => {
    const config = makeConfig(
      [],
      [
        {
          name: 'no_pii',
          description: 'Block PII',
          check: 'has_pii == true',
          action: blockAction('PII detected'),
        },
      ],
    );
    const result = checkConstraintsCore(config, { has_pii: false });
    expect(result).toBeNull();
  });

  test('should return first failing guardrail when multiple fail', () => {
    const config = makeConfig(
      [],
      [
        {
          name: 'no_pii',
          description: 'Block PII',
          check: 'has_pii == true',
          action: blockAction('PII detected'),
        },
        {
          name: 'rate_limit',
          description: 'Rate limit',
          check: 'request_count >= 100',
          action: blockAction('Rate limited'),
        },
      ],
    );
    const result = checkConstraintsCore(config, { has_pii: true, request_count: 200 });
    expect(result).not.toBeNull();
    expect(result!.type).toBe('guardrail');
    expect(result!.name).toBe('no_pii');
    expect(result!.passed).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // onCheck callback
  // ---------------------------------------------------------------------------

  test('should fire onCheck callback for every check', () => {
    const config = makeConfig(
      [{ condition: 'x > 0', on_fail: respondAction('x must be positive') }],
      [
        {
          name: 'limit',
          description: 'Limit check',
          check: 'y >= 100',
          action: { type: 'respond', message: 'Over limit' },
        },
      ],
    );
    const checks: ConstraintCheckInfo[] = [];
    const result = checkConstraintsCore(
      config,
      { x: 5, y: 50 },
      {
        onCheck: (info) => checks.push(info),
      },
    );
    expect(result).toBeNull();
    expect(checks).toHaveLength(2);
    expect(checks[0].type).toBe('guardrail');
    expect(checks[0].passed).toBe(true);
    expect(checks[1].type).toBe('constraint');
    expect(checks[1].passed).toBe(true);
  });

  test('should fire onCheck even on failure', () => {
    const config = makeConfig([{ condition: 'x > 10', on_fail: respondAction('x too small') }]);
    const checks: ConstraintCheckInfo[] = [];
    checkConstraintsCore(
      config,
      { x: 5 },
      {
        onCheck: (info) => checks.push(info),
      },
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].passed).toBe(false);
    expect(checks[0].condition).toBe('x > 10');
  });
});

// =============================================================================
// ConstraintExecutor
// =============================================================================

describe('ConstraintExecutor', () => {
  const executor = new ConstraintExecutor();

  // ---------------------------------------------------------------------------
  // Basic execution with flat constraints
  // ---------------------------------------------------------------------------

  describe('execute with flat constraints', () => {
    test('should pass when all constraints are satisfied', async () => {
      const ctx = makeContext(
        [
          { condition: 'num_guests <= 10', on_fail: respondAction('Too many guests') },
          { condition: 'destination != ""', on_fail: respondAction('Need destination') },
        ],
        [],
        { num_guests: 5, destination: 'Paris' },
      );

      const result = await executor.execute(ctx);

      expect(result.metadata?.failedConstraint).toBeUndefined();
      expect(result.action.type).toBe('continue');
    });

    test('should fail on first violated constraint', async () => {
      const ctx = makeContext(
        [
          { condition: 'destination != ""', on_fail: respondAction('Need destination') },
          { condition: 'num_guests <= 10', on_fail: respondAction('Too many guests') },
        ],
        [],
        { destination: '', num_guests: 15 },
      );

      const result = await executor.execute(ctx);

      expect(result.metadata?.failedConstraint).toBe('destination != ""');
    });

    test('should check second constraint if first passes', async () => {
      const ctx = makeContext(
        [
          { condition: 'destination != ""', on_fail: respondAction('Need destination') },
          { condition: 'num_guests <= 10', on_fail: respondAction('Too many guests') },
        ],
        [],
        { destination: 'Paris', num_guests: 15 },
      );

      const result = await executor.execute(ctx);

      expect(result.metadata?.failedConstraint).toBe('num_guests <= 10');
    });
  });

  // ---------------------------------------------------------------------------
  // IS SET guard semantics
  // ---------------------------------------------------------------------------

  describe('IS SET guard semantics', () => {
    test('should pass when IS SET guard field is not yet collected', async () => {
      const ctx = makeContext(
        [
          {
            condition: 'destination IS SET AND origin IS SET AND destination != origin',
            on_fail: respondAction('Destination cannot be same as origin'),
          },
        ],
        [],
        { destination: 'Paris' }, // origin not set yet
      );

      const result = await executor.execute(ctx);

      // Guard not met -> constraint is not applicable -> pass
      expect(result.metadata?.failedConstraint).toBeUndefined();
      expect(result.action.type).toBe('continue');
    });

    test('should fail when IS SET guards pass but value assertion fails', async () => {
      const ctx = makeContext(
        [
          {
            condition: 'destination IS SET AND origin IS SET AND destination != origin',
            on_fail: respondAction('Destination cannot be same as origin'),
          },
        ],
        [],
        { destination: 'Paris', origin: 'Paris' },
      );

      const result = await executor.execute(ctx);

      expect(result.metadata?.failedConstraint).toBe(
        'destination IS SET AND origin IS SET AND destination != origin',
      );
    });

    test('should pass when IS SET guards and value assertions both pass', async () => {
      const ctx = makeContext(
        [
          {
            condition: 'destination IS SET AND origin IS SET AND destination != origin',
            on_fail: respondAction('Destination cannot be same as origin'),
          },
        ],
        [],
        { destination: 'Paris', origin: 'London' },
      );

      const result = await executor.execute(ctx);

      expect(result.metadata?.failedConstraint).toBeUndefined();
      expect(result.action.type).toBe('continue');
    });

    test('should pass when no fields are set for IS SET guards', async () => {
      const ctx = makeContext(
        [
          {
            condition: 'destination IS SET AND origin IS SET AND destination != origin',
            on_fail: respondAction('Destination cannot be same as origin'),
          },
        ],
        [],
        {}, // nothing set
      );

      const result = await executor.execute(ctx);

      expect(result.metadata?.failedConstraint).toBeUndefined();
      expect(result.action.type).toBe('continue');
    });

    test('should evaluate normally when all parts are IS SET (no mixed guards)', async () => {
      const ctx = makeContext(
        [
          {
            condition: 'destination IS SET AND origin IS SET',
            on_fail: respondAction('Both fields required'),
          },
        ],
        [],
        { destination: 'Paris' }, // origin not set
      );

      const result = await executor.execute(ctx);

      // Pure IS SET chain (no value assertions) -> evaluates normally, should fail
      expect(result.metadata?.failedConstraint).toBe('destination IS SET AND origin IS SET');
    });
  });

  // ---------------------------------------------------------------------------
  // Guardrails
  // ---------------------------------------------------------------------------

  describe('Guardrails', () => {
    test('should check guardrails before constraints', async () => {
      const ctx = makeContext(
        [{ condition: 'num_guests <= 10', on_fail: respondAction('Too many guests') }],
        [
          {
            name: 'no_pii',
            description: 'Block PII',
            check: 'has_pii == true',
            action: blockAction('PII detected'),
          },
        ],
        { has_pii: true, num_guests: 15 },
      );

      const result = await executor.execute(ctx);

      expect(result.metadata?.failedAt).toBe('guardrail');
      expect(result.metadata?.failedGuardrail).toBe('no_pii');
    });

    test('should proceed to constraints when guardrails pass', async () => {
      const ctx = makeContext(
        [{ condition: 'num_guests <= 10', on_fail: respondAction('Too many guests') }],
        [
          {
            name: 'no_pii',
            description: 'Block PII',
            check: 'has_pii == true',
            action: blockAction('PII detected'),
          },
        ],
        { has_pii: false, num_guests: 15 },
      );

      const result = await executor.execute(ctx);

      // Guardrail passes, constraint fails
      expect(result.metadata?.failedGuardrail).toBeUndefined();
      expect(result.metadata?.failedConstraint).toBe('num_guests <= 10');
    });
  });

  // ---------------------------------------------------------------------------
  // checkGuardrails() method
  // ---------------------------------------------------------------------------

  describe('checkGuardrails()', () => {
    test('should return passed=true when all guardrails pass', async () => {
      const ctx = makeContext(
        [{ condition: 'x > 0', on_fail: respondAction('x must be positive') }],
        [
          {
            name: 'safe',
            description: 'Safety check',
            check: 'is_safe == false',
            action: blockAction('Unsafe'),
          },
        ],
        { is_safe: true, x: -1 },
      );

      const result = await executor.checkGuardrails(ctx);

      // checkGuardrails only checks guardrails (skips constraints)
      expect(result.passed).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    test('should return passed=false with failures when guardrails fail', async () => {
      const ctx = makeContext(
        [],
        [
          {
            name: 'no_pii',
            description: 'Block PII',
            check: 'has_pii == true',
            action: blockAction('PII detected'),
          },
          {
            name: 'rate_limit',
            description: 'Rate limit',
            check: 'request_count >= 100',
            action: blockAction('Rate limited'),
          },
        ],
        { has_pii: true, request_count: 200 },
      );

      const result = await executor.checkGuardrails(ctx);

      // recordOnly collects all failures
      expect(result.passed).toBe(false);
      expect(result.failures.length).toBeGreaterThanOrEqual(1);
      expect(result.failures[0].constraint).toBe('no_pii');
    });

    test('should not include constraint failures in checkGuardrails result', async () => {
      const ctx = makeContext(
        [{ condition: 'x > 0', on_fail: respondAction('x must be positive') }],
        [
          {
            name: 'safe',
            description: 'Safety check',
            check: 'is_safe == false',
            action: blockAction('Unsafe'),
          },
        ],
        { is_safe: true, x: -1 },
      );

      const result = await executor.checkGuardrails(ctx);

      // Guardrail passes, constraint would fail but is skipped
      expect(result.passed).toBe(true);
      expect(result.results).not.toHaveProperty('constraint:x > 0');
    });
  });

  // ---------------------------------------------------------------------------
  // Skip options
  // ---------------------------------------------------------------------------

  describe('skip options', () => {
    test('should skip guardrails when skipGuardrails is true', async () => {
      const ctx = makeContext(
        [{ condition: 'x > 0', on_fail: respondAction('x must be positive') }],
        [
          {
            name: 'blocker',
            description: 'Always blocks',
            check: 'false_val == false',
            action: blockAction('blocked'),
          },
        ],
        { false_val: false, x: 5 },
      );

      const result = await executor.execute(ctx, { skipGuardrails: true });

      // Guardrail would fail, but it was skipped
      expect(result.metadata?.failedGuardrail).toBeUndefined();
      expect(result.action.type).toBe('continue');
    });

    test('should skip constraints when skipConstraints is true', async () => {
      const ctx = makeContext(
        [{ condition: 'x > 100', on_fail: respondAction('x too small') }],
        [
          {
            name: 'safe',
            description: 'Safety',
            check: 'is_safe == false',
            action: blockAction('unsafe'),
          },
        ],
        { is_safe: true, x: 5 },
      );

      const result = await executor.execute(ctx, { skipConstraints: true });

      // Constraint would fail, but it was skipped
      expect(result.metadata?.failedConstraint).toBeUndefined();
      expect(result.action.type).toBe('continue');
    });
  });

  // ---------------------------------------------------------------------------
  // recordOnly mode
  // ---------------------------------------------------------------------------

  describe('recordOnly mode', () => {
    test('should collect all failures without short-circuiting in recordOnly mode', async () => {
      const ctx = makeContext(
        [
          { condition: 'a > 0', on_fail: respondAction('a failed') },
          { condition: 'b > 0', on_fail: respondAction('b failed') },
        ],
        [
          {
            name: 'g1',
            description: 'Guard 1',
            check: 'x == false',
            action: blockAction('g1 fail'),
          },
        ],
        { x: false, a: -1, b: -1 },
      );

      const result = await executor.execute(ctx, { recordOnly: true });

      // All three checks should have been performed despite failures
      expect(result.metadata?.checksPerformed).toBe(3);
      expect(result.metadata?.failures).toBe(3);
      expect(result.metadata?.failureDetails).toBeDefined();
      const details = result.metadata!.failureDetails as Array<{ constraint: string }>;
      expect(details).toHaveLength(3);
    });

    test('should return continue action even with failures in recordOnly mode when first failure action is used', async () => {
      const ctx = makeContext([{ condition: 'a > 0', on_fail: respondAction('a failed') }], [], {
        a: -1,
      });

      const result = await executor.execute(ctx, { recordOnly: true });

      // recordOnly uses the first failure action (not continue)
      expect(result.metadata?.failures).toBe(1);
    });

    test('should return continue action in recordOnly mode when all pass', async () => {
      const ctx = makeContext([{ condition: 'a > 0', on_fail: respondAction('a failed') }], [], {
        a: 5,
      });

      const result = await executor.execute(ctx, { recordOnly: true });

      expect(result.action.type).toBe('continue');
      expect(result.metadata?.failures).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Action type conversion
  // ---------------------------------------------------------------------------

  describe('action type conversion', () => {
    test('should convert respond action to respond construct action', async () => {
      const ctx = makeContext(
        [{ condition: 'x > 0', on_fail: { type: 'respond', message: 'x must be positive' } }],
        [],
        { x: -1 },
      );

      const result = await executor.execute(ctx);

      expect(result.action.type).toBe('respond');
      expect((result.action as { message: string }).message).toBe('x must be positive');
    });

    test('should convert block action to block construct action', async () => {
      const ctx = makeContext(
        [],
        [
          {
            name: 'blocker',
            description: 'Blocker',
            check: 'allowed == false',
            action: { type: 'block', reason: 'Not allowed', message: 'Blocked' },
          },
        ],
        { allowed: false },
      );

      const result = await executor.execute(ctx);

      expect(result.action.type).toBe('block');
    });

    test('should convert escalate action to escalate construct action', async () => {
      const ctx = makeContext(
        [
          {
            condition: 'severity < 5',
            on_fail: { type: 'escalate', reason: 'High severity detected' },
          },
        ],
        [],
        { severity: 10 },
      );

      const result = await executor.execute(ctx);

      expect(result.action.type).toBe('escalate');
      expect((result.action as { reason: string }).reason).toBe('High severity detected');
    });
  });

  // ---------------------------------------------------------------------------
  // Message interpolation
  // ---------------------------------------------------------------------------

  describe('message interpolation', () => {
    test('should interpolate context values into failure messages', async () => {
      const ctx = makeContext(
        [
          {
            condition: 'num_guests <= 10',
            on_fail: { type: 'respond', message: 'You have ${num_guests} guests, max is 10' },
          },
        ],
        [],
        { num_guests: 15 },
      );

      const result = await executor.execute(ctx);

      expect(result.action.type).toBe('respond');
      expect((result.action as { message: string }).message).toBe('You have 15 guests, max is 10');
    });
  });

  // ---------------------------------------------------------------------------
  // Constraint results in state updates
  // ---------------------------------------------------------------------------

  describe('state updates', () => {
    test('should include constraint results in state updates', async () => {
      const ctx = makeContext(
        [{ condition: 'x > 0', on_fail: respondAction('x failed') }],
        [
          {
            name: 'g1',
            description: 'Guard',
            check: 'safe == false',
            action: blockAction('unsafe'),
          },
        ],
        { safe: true, x: 5 },
      );

      const result = await executor.execute(ctx);

      expect(result.stateUpdates?.constraintResults).toBeDefined();
      const results = result.stateUpdates!.constraintResults!;
      expect(results['guardrail:g1']).toBe(true);
      expect(results['constraint:x > 0']).toBe(true);
    });

    test('should track check count in metadata on success', async () => {
      const ctx = makeContext(
        [
          { condition: 'a == true', on_fail: respondAction('a failed') },
          { condition: 'b == true', on_fail: respondAction('b failed') },
        ],
        [],
        { a: true, b: true },
      );

      const result = await executor.execute(ctx);

      expect(result.metadata?.checksPerformed).toBe(2);
      expect(result.metadata?.failures).toBe(0);
    });
  });
});
