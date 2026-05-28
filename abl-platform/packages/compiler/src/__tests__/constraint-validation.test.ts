/**
 * Constraint Operator Validation Tests
 *
 * Ensures the compiler catches invalid comparison operators in constraint conditions
 * and passes valid ones through without errors.
 */

import { describe, test, expect } from 'vitest';
import { validateConstraintOperators } from '../platform/ir/compiler.js';

const AGENT = 'test_agent';

describe('validateConstraintOperators', () => {
  // -------------------------------------------------------------------------
  // Valid operators — should produce zero errors
  // -------------------------------------------------------------------------

  test.each([
    ['==', 'destination == origin'],
    ['!=', 'destination != origin'],
    ['>', 'score > 100'],
    ['<', 'price < 50'],
    ['>=', 'count >= 1'],
    ['<=', 'num_guests <= 10'],
  ])('accepts valid operator %s', (_op, condition) => {
    expect(validateConstraintOperators(condition, AGENT)).toEqual([]);
  });

  test('accepts condition with no symbol operators (truthy check)', () => {
    expect(validateConstraintOperators('is_active', AGENT)).toEqual([]);
  });

  test('accepts condition with word operators', () => {
    // Word operators like contains/startsWith/endsWith/matches don't use symbols
    // and therefore don't trigger symbol validation
    expect(validateConstraintOperators('name contains "foo"', AGENT)).toEqual([]);
  });

  test('accepts operator inside string literal without flagging', () => {
    expect(validateConstraintOperators('status == "<<="', AGENT)).toEqual([]);
  });

  test('accepts multiple valid operators in one condition', () => {
    expect(validateConstraintOperators('a > 1 AND b <= 10', AGENT)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Invalid operators — should produce errors
  // -------------------------------------------------------------------------

  test('rejects <<= operator', () => {
    const errors = validateConstraintOperators('destination <<= origin', AGENT);
    expect(errors).toHaveLength(1);
    expect(errors[0].agent).toBe(AGENT);
    expect(errors[0].message).toContain('<<=');
    expect(errors[0].type).toBe('validation');
  });

  test('rejects === operator', () => {
    const errors = validateConstraintOperators('a === b', AGENT);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('===');
  });

  test('rejects !== operator', () => {
    const errors = validateConstraintOperators('a !== b', AGENT);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('!==');
  });

  test('rejects <> operator', () => {
    const errors = validateConstraintOperators('a <> b', AGENT);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('<>');
  });

  test('rejects => operator', () => {
    const errors = validateConstraintOperators('a => b', AGENT);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('=>');
  });

  test('rejects =< operator', () => {
    const errors = validateConstraintOperators('a =< b', AGENT);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('=<');
  });

  test('error message includes valid operators hint', () => {
    const errors = validateConstraintOperators('a <<= b', AGENT);
    expect(errors[0].message).toContain('Valid operators:');
    expect(errors[0].message).toContain('==');
  });
});
