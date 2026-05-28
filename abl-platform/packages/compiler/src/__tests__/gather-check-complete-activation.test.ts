/**
 * checkGatherComplete() — Activation Mode Tests
 *
 * Tests the enhanced checkGatherComplete() function with activation modes:
 * - 'optional': field is never required, even if required=true
 * - 'progressive': field only becomes required when depends_on fields are collected
 * - data-driven ({ when: "..." }): field only becomes required when condition is met
 *
 * Tests 1, 2, and 8 exercise existing behavior and should PASS.
 * Tests 3-7 exercise activation/depends_on logic that does not yet exist
 * in checkGatherComplete() and are expected to FAIL.
 */

import { describe, test, expect } from 'vitest';
import { checkGatherComplete } from '../platform/constructs/utils.js';

// ---------------------------------------------------------------------------
// Existing behavior — these should PASS
// ---------------------------------------------------------------------------

describe('checkGatherComplete — existing behavior', () => {
  test('required field missing → not complete', () => {
    const gather = {
      fields: [
        { name: 'destination', required: true },
        { name: 'check_in_date', required: true },
      ],
    };
    const collected = { destination: 'Hawaii' };

    const result = checkGatherComplete(gather, collected);

    expect(result.complete).toBe(false);
    expect(result.missing).toContain('check_in_date');
  });

  test('all required fields present → complete', () => {
    const gather = {
      fields: [
        { name: 'destination', required: true },
        { name: 'check_in_date', required: true },
      ],
    };
    const collected = { destination: 'Hawaii', check_in_date: '2026-06-01' };

    const result = checkGatherComplete(gather, collected);

    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test('field with default value is not in missing list', () => {
    const gather = {
      fields: [
        { name: 'destination', required: true },
        { name: 'guests', required: true, default: 1 },
      ],
    };
    const collected = { destination: 'Hawaii' };

    const result = checkGatherComplete(gather, collected);

    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Activation mode: optional — EXPECTED TO FAIL
// ---------------------------------------------------------------------------

describe('checkGatherComplete — activation: optional', () => {
  test('optional activation: field missing → still complete', () => {
    // A field with activation='optional' should never block completion,
    // regardless of the `required` flag.
    const gather = {
      fields: [
        { name: 'destination', required: true },
        { name: 'loyalty_number', required: true, activation: 'optional' as const },
      ],
    };
    const collected = { destination: 'Hawaii' };

    const result = checkGatherComplete(gather, collected);

    // The current implementation ignores the activation field and treats
    // loyalty_number as required, so it will be in the missing list.
    // This assertion expects the enhanced behavior where optional fields
    // are excluded from required checks.
    expect(result.complete).toBe(true);
    expect(result.missing).not.toContain('loyalty_number');
  });
});

// ---------------------------------------------------------------------------
// Activation mode: progressive — EXPECTED TO FAIL
// ---------------------------------------------------------------------------

describe('checkGatherComplete — activation: progressive', () => {
  test('progressive with unmet deps → field not in missing list', () => {
    // room_type depends on destination being collected first.
    // Since destination is NOT collected, room_type should not appear
    // in the missing list (its dependencies are not met).
    const gather = {
      fields: [
        { name: 'destination', required: true },
        {
          name: 'room_type',
          required: true,
          activation: 'progressive' as const,
          depends_on: ['destination'],
        },
      ],
    };
    const collected: Record<string, unknown> = {};

    const result = checkGatherComplete(gather, collected);

    // Current implementation ignores depends_on and reports room_type as
    // missing along with destination. The enhanced version should only
    // report destination.
    expect(result.missing).toContain('destination');
    expect(result.missing).not.toContain('room_type');
  });

  test('progressive with met deps + missing value → field in missing list', () => {
    // destination IS collected, so room_type's dependency is satisfied.
    // Since room_type itself is not collected, it should be in missing.
    const gather = {
      fields: [
        { name: 'destination', required: true },
        {
          name: 'room_type',
          required: true,
          activation: 'progressive' as const,
          depends_on: ['destination'],
        },
      ],
    };
    const collected = { destination: 'Hawaii' };

    const result = checkGatherComplete(gather, collected);

    // Current implementation already reports room_type as missing (by
    // accident — it ignores depends_on and just checks required). However,
    // the test validates the *intended* semantic: room_type is missing
    // because its dependency is met AND it has no value.
    expect(result.complete).toBe(false);
    expect(result.missing).toContain('room_type');
  });
});

// ---------------------------------------------------------------------------
// Activation mode: data-driven — EXPECTED TO FAIL
// ---------------------------------------------------------------------------

describe('checkGatherComplete — activation: data-driven', () => {
  test('data-driven with false condition → field not in missing list', () => {
    // premium_lounge is only required when budget > 1000.
    // Budget is 500, so the condition is false and the field should NOT
    // appear in the missing list.
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
    const collected = { budget: 500 };

    const result = checkGatherComplete(gather, collected);

    // Current implementation ignores the activation condition object and
    // treats premium_lounge as a plain required field.
    expect(result.complete).toBe(true);
    expect(result.missing).not.toContain('premium_lounge');
  });

  test('data-driven with true condition + field missing → field in missing list', () => {
    // premium_lounge is required when budget > 1000.
    // Budget is 2000, so the condition is true and the field IS missing.
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
    const collected = { budget: 2000 };

    const result = checkGatherComplete(gather, collected);

    // Current implementation reports it as missing anyway because it
    // ignores activation. But we want it missing for the RIGHT reason:
    // the condition evaluated to true AND the value is absent.
    expect(result.complete).toBe(false);
    expect(result.missing).toContain('premium_lounge');
  });
});
