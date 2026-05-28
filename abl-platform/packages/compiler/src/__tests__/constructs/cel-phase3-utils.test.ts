/**
 * CEL Phase 3 — Tests for dual evaluator wiring in remaining legacy paths
 *
 * Validates that evaluateConditionDual is now used in:
 * 1. checkGatherComplete (complete_when)
 * 2. evaluateSimpleActivationCondition (fallback path)
 * 3. detectIntent (condition evaluation)
 * 4. evaluateOnInput (branch conditions)
 * 5. checkConstraintsCore (default evaluator)
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  checkGatherComplete,
  detectIntent,
  evaluateOnInput,
} from '../../platform/constructs/utils.js';
import { checkConstraintsCore } from '../../platform/constructs/executors/constraint-executor.js';
import { celMetrics } from '../../platform/constructs/dual-evaluator.js';
import type { ConstraintConfig, Constraint, Guardrail } from '../../platform/ir/schema.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeConstraintConfig(
  constraints: Constraint[] = [],
  guardrails: Guardrail[] = [],
): ConstraintConfig {
  return { constraints, guardrails };
}

// =============================================================================
// 4a. checkGatherComplete with CEL complete_when
// =============================================================================

describe('checkGatherComplete — CEL complete_when', () => {
  beforeEach(() => celMetrics.reset());

  test('CEL syntax: has(destination) && budget > 0 — pass when both set', () => {
    const gather = {
      fields: [
        { name: 'destination', required: true },
        { name: 'budget', required: true },
        { name: 'extras', required: true },
      ],
    };
    const collected = { destination: 'Hawaii', budget: 500 };

    const result = checkGatherComplete(gather, collected, 'has(destination) && budget > 0');

    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
    expect(celMetrics.celSuccess).toBeGreaterThan(0);
  });

  test('CEL syntax: has(destination) && budget > 0 — fail when budget missing', () => {
    const gather = {
      fields: [
        { name: 'destination', required: true },
        { name: 'budget', required: true },
      ],
    };
    const collected = { destination: 'Hawaii' };

    const result = checkGatherComplete(gather, collected, 'has(destination) && budget > 0');

    // complete_when fails, falls through to field checking
    expect(result.complete).toBe(false);
    expect(result.missing).toContain('budget');
  });

  test('legacy syntax: destination IS SET AND budget > 0 — still works via migration', () => {
    const gather = {
      fields: [
        { name: 'destination', required: true },
        { name: 'budget', required: true },
        { name: 'extras', required: true },
      ],
    };
    const collected = { destination: 'Hawaii', budget: 500 };

    const result = checkGatherComplete(gather, collected, 'destination IS SET AND budget > 0');

    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });
});

// =============================================================================
// 4b. evaluateSimpleActivationCondition CEL fallback
// =============================================================================

describe('checkGatherComplete — activation condition CEL fallback', () => {
  beforeEach(() => celMetrics.reset());

  test('data-driven activation with CEL expression', () => {
    const gather = {
      fields: [
        { name: 'budget', required: true },
        { name: 'tier', required: true },
        {
          name: 'premium_lounge',
          required: true,
          activation: { when: 'budget > 1000' },
        },
      ],
    };
    // budget > 1000 is true, but premium_lounge is not collected → missing
    const collected = { budget: 2000, tier: 'gold' };
    const result = checkGatherComplete(gather, collected);

    expect(result.complete).toBe(false);
    expect(result.missing).toContain('premium_lounge');
  });

  test('data-driven activation with condition false — field skipped', () => {
    const gather = {
      fields: [
        { name: 'budget', required: true },
        {
          name: 'premium_lounge',
          required: true,
          activation: { when: 'budget > 1000' },
        },
      ],
    };
    // budget is 500, condition false → premium_lounge is skipped
    const collected = { budget: 500 };
    const result = checkGatherComplete(gather, collected);

    expect(result.complete).toBe(true);
    expect(result.missing).not.toContain('premium_lounge');
  });
});

// =============================================================================
// 4c. detectIntent with CEL condition
// =============================================================================

describe('detectIntent — CEL condition', () => {
  beforeEach(() => celMetrics.reset());

  test('CEL condition: input.contains("help") — matches', () => {
    const intents = [
      {
        intent: 'help_request',
        keywords: ['help'],
        condition: 'input.contains("help")',
      } as any,
    ];

    const result = detectIntent('I need help please', intents, {});

    expect(result).not.toBeNull();
    expect(result!.matched).toBe('help');
  });

  test('CEL condition: input.contains("help") — does not match', () => {
    const intents = [
      {
        intent: 'help_request',
        keywords: ['help'],
        condition: 'input.contains("help")',
      } as any,
    ];

    const result = detectIntent('book a hotel room', intents, {});

    expect(result).toBeNull();
  });

  test('legacy condition: input contains "help" — still works', () => {
    const intents = [
      {
        intent: 'help_request',
        keywords: ['help'],
        condition: 'input contains "help"',
      } as any,
    ];

    const result = detectIntent('I need help please', intents, {});

    expect(result).not.toBeNull();
    expect(result!.matched).toBe('help');
  });

  test('intent without condition still uses explicit KEYWORDS matching', () => {
    const intents = [{ intent: 'cancel_request', keywords: ['cancel'] } as any];

    const result = detectIntent('I want to cancel my booking', intents, {});

    expect(result).not.toBeNull();
    expect(result!.matched).toBe('cancel');
  });
});

// =============================================================================
// 4d. evaluateOnInput with CEL branch conditions
// =============================================================================

describe('evaluateOnInput — CEL branch conditions', () => {
  beforeEach(() => celMetrics.reset());

  test('CEL branch: input == "yes" || input == "confirm" — matches "yes"', () => {
    const branches = [
      {
        condition: 'input == "yes" || input == "confirm"',
        then: 'proceed',
        respond: 'Great, proceeding!',
      },
      {
        condition: 'input == "no"',
        then: 'cancel',
        respond: 'Cancelled.',
      },
    ];

    const result = evaluateOnInput(branches, 'yes', {});

    expect(result).not.toBeNull();
    expect(result!.then).toBe('proceed');
    expect(result!.respond).toBe('Great, proceeding!');
  });

  test('CEL branch: input == "yes" — does not match "maybe"', () => {
    const branches = [
      {
        condition: 'input == "yes"',
        then: 'proceed',
      },
      {
        condition: 'input == "no"',
        then: 'cancel',
      },
    ];

    const result = evaluateOnInput(branches, 'maybe', {});

    expect(result).toBeNull();
  });

  test('ELSE branch (no condition) still works as fallback', () => {
    const branches = [
      {
        condition: 'input == "yes"',
        then: 'proceed',
      },
      {
        then: 'fallback',
        respond: 'I did not understand.',
      },
    ];

    const result = evaluateOnInput(branches, 'maybe', {});

    expect(result).not.toBeNull();
    expect(result!.then).toBe('fallback');
  });

  test('legacy regex branch still works', () => {
    const branches = [
      {
        condition: 'input matches "^\\d+$"',
        then: 'number_input',
      },
      {
        then: 'text_input',
      },
    ];

    const result = evaluateOnInput(branches, '42', {});

    expect(result).not.toBeNull();
    expect(result!.then).toBe('number_input');
  });

  test('matched boolean comes from dual evaluator', () => {
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const branches = [
      {
        condition: 'input == "yes"',
        then: 'proceed',
      },
    ];

    evaluateOnInput(branches, 'yes', {}, undefined, (event) => {
      traceEvents.push(event);
    });

    expect(traceEvents.length).toBe(1);
    expect(traceEvents[0].data.result).toBe('CONDITION_MATCHED');
    expect(celMetrics.celSuccess).toBeGreaterThan(0);
  });
});

// =============================================================================
// 4e. checkConstraintsCore with default evaluator (CEL)
// =============================================================================

describe('checkConstraintsCore — default evaluator is now CEL-aware', () => {
  beforeEach(() => celMetrics.reset());

  test('CEL constraint condition works without passing evaluateCondition option', () => {
    const config = makeConstraintConfig([
      {
        condition: 'age >= 18 && name != ""',
        on_fail: { type: 'respond', message: 'Must be 18+ with name' },
      },
    ]);

    // Pass case — no evaluateCondition option, uses default (dual)
    const passResult = checkConstraintsCore(config, { age: 25, name: 'Alice' });
    expect(passResult).toBeNull();

    // Fail case
    const failResult = checkConstraintsCore(config, { age: 15, name: 'Bob' });
    expect(failResult).not.toBeNull();
    expect(failResult!.passed).toBe(false);
  });

  test('legacy constraint condition still works with new default', () => {
    const config = makeConstraintConfig([
      {
        condition: 'age >= 18 AND name IS SET',
        on_fail: { type: 'block', reason: 'Age/name check failed' },
      },
    ]);

    const passResult = checkConstraintsCore(config, { age: 25, name: 'Alice' });
    expect(passResult).toBeNull();

    const failResult = checkConstraintsCore(config, { age: 15, name: 'Bob' });
    expect(failResult).not.toBeNull();
    expect(failResult!.passed).toBe(false);
  });

  test('CEL guardrail condition works with default evaluator', () => {
    const config = makeConstraintConfig(
      [],
      [
        {
          name: 'budget_limit',
          check: 'budget > 10000',
          description: 'Budget must not exceed 10000',
          action: { type: 'block', reason: 'Budget exceeded' },
        },
      ],
    );

    const passResult = checkConstraintsCore(config, { budget: 5000 });
    expect(passResult).toBeNull();

    const failResult = checkConstraintsCore(config, { budget: 15000 });
    expect(failResult).not.toBeNull();
    expect(failResult!.type).toBe('guardrail');
    expect(failResult!.name).toBe('budget_limit');
  });

  test('celMetrics increments when using default evaluator', () => {
    const config = makeConstraintConfig([
      {
        condition: 'status == "active"',
        on_fail: { type: 'respond', message: 'Must be active' },
      },
    ]);

    checkConstraintsCore(config, { status: 'active' });

    expect(celMetrics.celSuccess).toBeGreaterThan(0);
  });
});
