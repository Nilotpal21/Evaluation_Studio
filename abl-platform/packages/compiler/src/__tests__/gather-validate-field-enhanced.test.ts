/**
 * validateField() — Enhanced Validation Tests
 *
 * Tests the validateField() function from constructs/utils.ts with both
 * existing validation types (pattern, range, enum) and the new 'llm' type.
 *
 * Tests 1-3 exercise existing behavior and should PASS.
 * Test 4 exercises the 'llm' validation type which is declared in the
 * ValidationRule schema but not handled in the validateField() switch
 * statement — it is expected to FAIL (or at least expose the gap).
 */

import { describe, test, expect } from 'vitest';
import { validateField } from '../platform/constructs/utils.js';
import type { ValidationRule } from '../platform/ir/schema.js';

// ---------------------------------------------------------------------------
// Existing behavior — these should PASS
// ---------------------------------------------------------------------------

describe('validateField — existing types', () => {
  test('pattern validation: valid value returns null', () => {
    const rule: ValidationRule = {
      type: 'pattern',
      rule: '^[A-Z]{3}$',
      error_message: 'Must be a 3-letter airport code.',
    };

    expect(validateField('LAX', rule)).toBeNull();
  });

  test('pattern validation: invalid value returns error message', () => {
    const rule: ValidationRule = {
      type: 'pattern',
      rule: '^[A-Z]{3}$',
      error_message: 'Must be a 3-letter airport code.',
    };

    expect(validateField('los angeles', rule)).toBe('Must be a 3-letter airport code.');
  });

  test('range validation: value within range returns null', () => {
    const rule: ValidationRule = {
      type: 'range',
      rule: '1-10',
      error_message: 'Must be between 1 and 10.',
    };

    expect(validateField(5, rule)).toBeNull();
  });

  test('range validation: value outside range returns error message', () => {
    const rule: ValidationRule = {
      type: 'range',
      rule: '1-10',
      error_message: 'Must be between 1 and 10.',
    };

    expect(validateField(15, rule)).toBe('Must be between 1 and 10.');
  });

  test('enum validation: allowed value returns null', () => {
    const rule: ValidationRule = {
      type: 'enum',
      rule: 'economy|business|first',
      error_message: 'Must be economy, business, or first.',
    };

    expect(validateField('business', rule)).toBeNull();
  });

  test('enum validation: disallowed value returns error message', () => {
    const rule: ValidationRule = {
      type: 'enum',
      rule: 'economy|business|first',
      error_message: 'Must be economy, business, or first.',
    };

    expect(validateField('premium', rule)).toBe('Must be economy, business, or first.');
  });
});

// ---------------------------------------------------------------------------
// LLM validation type — EXPECTED TO FAIL
// ---------------------------------------------------------------------------

describe('validateField — llm type', () => {
  test('llm validation type returns null (no-op without LLM runtime)', () => {
    // The 'llm' type is declared in the ValidationRule schema but the
    // validateField() switch statement does not have a case for it.
    // Without an LLM provider at the pure-function level, the expected
    // behavior is to return null (pass-through) — actual LLM validation
    // happens at a higher layer in the runtime.
    //
    // Currently, validateField() falls through the switch without matching
    // 'llm', hits the default return null at the end, which means this
    // test MIGHT pass by accident. However, the intent is to have an
    // explicit 'llm' case that returns null (documenting the no-op).
    // We verify the function does not throw and returns null.
    const rule: ValidationRule = {
      type: 'llm',
      rule: 'The date must be a valid future date within the next 12 months.',
      error_message: 'Please provide a valid future date.',
    };

    // Should not throw
    const result = validateField('2026-08-15', rule);

    // Should return null (no validation at this layer)
    expect(result).toBeNull();
  });

  test('llm validation with retry_prompt and max_retries does not throw', () => {
    // Verifies that additional fields on the ValidationRule do not cause
    // issues when the type is 'llm'.
    const rule: ValidationRule = {
      type: 'llm',
      rule: 'Validate the email is a corporate address, not a free provider.',
      error_message: 'Please use a corporate email address.',
      retry_prompt: 'We need your work email (e.g. you@company.com).',
      max_retries: 2,
    };

    const result = validateField('user@example.com', rule);

    // Pure function layer should not attempt LLM validation —
    // it should return null to indicate "no synchronous rejection".
    expect(result).toBeNull();
  });
});
