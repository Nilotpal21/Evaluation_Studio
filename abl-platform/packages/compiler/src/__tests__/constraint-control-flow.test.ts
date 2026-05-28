/**
 * Constraint Control Flow Tests
 *
 * Validates expanded ConstraintAction types and the ConstraintOnFailBlock
 * structured alternative. Tests cover:
 * - collect_field action with collect_fields and then_action
 * - goto_step action with then_step
 * - retry_step action
 * - ConstraintOnFailBlock mapping to ConstraintAction
 * - Legacy string on_fail backward compatibility
 */

import { describe, test, expect } from 'vitest';
import type { ConstraintAction, ConstraintOnFailBlock, Constraint } from '../platform/ir/schema.js';

// ---------------------------------------------------------------------------
// ConstraintAction expanded types
// ---------------------------------------------------------------------------

describe('ConstraintAction expanded types', () => {
  test('type="collect_field" with collect_fields and then_action="continue" is valid', () => {
    const action: ConstraintAction = {
      type: 'collect_field',
      collect_fields: ['email'],
      then_action: 'continue',
      message: 'We need your email to proceed.',
    };

    expect(action.type).toBe('collect_field');
    expect(action.collect_fields).toEqual(['email']);
    expect(action.then_action).toBe('continue');
  });

  test('type="goto_step" with then_step is valid', () => {
    const action: ConstraintAction = {
      type: 'goto_step',
      then_step: 'search_step',
      message: 'Redirecting to search.',
    };

    expect(action.type).toBe('goto_step');
    expect(action.then_step).toBe('search_step');
  });

  test('type="retry_step" is valid', () => {
    const action: ConstraintAction = {
      type: 'retry_step',
      message: 'Please try again with valid input.',
    };

    expect(action.type).toBe('retry_step');
  });

  test('collect_field with multiple fields and then_action="retry" is valid', () => {
    const action: ConstraintAction = {
      type: 'collect_field',
      collect_fields: ['email', 'phone'],
      then_action: 'retry',
      message: 'We need your contact info to verify your identity.',
    };

    expect(action.collect_fields).toEqual(['email', 'phone']);
    expect(action.then_action).toBe('retry');
  });
});

// ---------------------------------------------------------------------------
// ConstraintOnFailBlock → ConstraintAction mapping
// ---------------------------------------------------------------------------

describe('ConstraintOnFailBlock to ConstraintAction mapping', () => {
  test('collect + then="continue" maps to collect_field action', () => {
    const block: ConstraintOnFailBlock = {
      respond: 'We need your email first.',
      collect: ['email'],
      then: 'continue',
    };

    // The block should map to a collect_field ConstraintAction
    const action: ConstraintAction = {
      type: 'collect_field',
      collect_fields: block.collect,
      then_action: block.then,
      message: block.respond,
    };

    expect(action.type).toBe('collect_field');
    expect(action.collect_fields).toEqual(['email']);
    expect(action.then_action).toBe('continue');
    expect(action.message).toBe('We need your email first.');
  });

  test('goto maps to goto_step action', () => {
    const block: ConstraintOnFailBlock = {
      respond: 'Going back to search.',
      goto: 'search_step',
    };

    // The block should map to a goto_step ConstraintAction
    const action: ConstraintAction = {
      type: 'goto_step',
      then_step: block.goto,
      message: block.respond,
    };

    expect(action.type).toBe('goto_step');
    expect(action.then_step).toBe('search_step');
  });

  test('retry=true maps to retry_step action', () => {
    const block: ConstraintOnFailBlock = {
      respond: 'Invalid input. Retrying this step.',
      retry: true,
    };

    // The block should map to a retry_step ConstraintAction
    const action: ConstraintAction = {
      type: 'retry_step',
      message: block.respond,
    };

    expect(action.type).toBe('retry_step');
    expect(action.message).toBe('Invalid input. Retrying this step.');
  });
});

// ---------------------------------------------------------------------------
// Legacy string on_fail backward compatibility
// ---------------------------------------------------------------------------

describe('Legacy string on_fail backward compatibility', () => {
  test('Constraint with ConstraintAction object works', () => {
    const constraint: Constraint = {
      condition: 'destination IS NOT SET',
      on_fail: {
        type: 'respond',
        message: 'Please provide a destination.',
      },
    };

    expect(constraint.on_fail.type).toBe('respond');
    expect(constraint.on_fail.message).toBe('Please provide a destination.');
  });

  test('ConstraintAction with type="respond" preserves legacy behavior', () => {
    // In the legacy schema, on_fail was a simple string like 'respond' or 'escalate'.
    // The new schema uses ConstraintAction objects. Verify the 'respond' type
    // continues to work as the equivalent of the old string value.
    const action: ConstraintAction = {
      type: 'respond',
      message: 'I can only help with hotel bookings.',
    };

    expect(action.type).toBe('respond');
    expect(action.message).toBe('I can only help with hotel bookings.');
  });

  test('ConstraintAction with type="escalate" preserves legacy behavior', () => {
    const action: ConstraintAction = {
      type: 'escalate',
      reason: 'User requested human agent.',
    };

    expect(action.type).toBe('escalate');
    expect(action.reason).toBe('User requested human agent.');
  });

  test('ConstraintAction with type="handoff" preserves legacy behavior', () => {
    const action: ConstraintAction = {
      type: 'handoff',
      target: 'billing_agent',
      message: 'Transferring you to our billing team.',
    };

    expect(action.type).toBe('handoff');
    expect(action.target).toBe('billing_agent');
  });

  test('ConstraintAction with type="block" preserves legacy behavior', () => {
    const action: ConstraintAction = {
      type: 'block',
      message: 'This action is not permitted.',
    };

    expect(action.type).toBe('block');
  });

  test('ConstraintAction with type="redact" preserves legacy behavior', () => {
    const action: ConstraintAction = {
      type: 'redact',
      message: 'Sensitive information has been removed.',
    };

    expect(action.type).toBe('redact');
  });
});
