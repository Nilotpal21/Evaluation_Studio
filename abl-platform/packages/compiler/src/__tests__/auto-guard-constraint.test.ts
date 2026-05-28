/**
 * autoGuardConstraint Tests
 *
 * Ensures the auto-guard logic correctly handles OR-based vs AND-based
 * constraints, preventing tautological conditions for OR-only constraints.
 */

import { describe, it, expect } from 'vitest';
import { autoGuardConstraint } from '../platform/ir/compiler.js';

describe('autoGuardConstraint', () => {
  it('guards a single variable comparison', () => {
    expect(autoGuardConstraint('num_guests <= 10')).toBe(
      'num_guests IS NOT SET OR num_guests <= 10',
    );
  });

  it('returns unchanged when author already wrote IS NOT SET guard', () => {
    expect(autoGuardConstraint('destination IS NOT SET OR destination != origin')).toBe(
      'destination IS NOT SET OR destination != origin',
    );
  });

  it('returns unchanged when author already wrote IS SET guard', () => {
    expect(autoGuardConstraint('budget IS SET AND budget > 0')).toBe(
      'budget IS SET AND budget > 0',
    );
  });

  it('returns unchanged when no variable references found', () => {
    expect(autoGuardConstraint('true')).toBe('true');
  });

  it('does not auto-guard purely OR-based conditions (prevents tautology)', () => {
    expect(
      autoGuardConstraint(
        'product_category != null OR brand_preference != null OR budget_range != null',
      ),
    ).toBe('product_category != null OR brand_preference != null OR budget_range != null');
  });

  it('still auto-guards AND-based conditions', () => {
    expect(autoGuardConstraint('product_category != null AND budget_range > 0')).toBe(
      '(product_category IS NOT SET AND budget_range IS NOT SET) OR (product_category != null AND budget_range > 0)',
    );
  });

  it('still auto-guards mixed AND/OR conditions', () => {
    const result = autoGuardConstraint('A != null AND B != null OR C != null');
    expect(result).toContain('IS NOT SET');
  });

  it('does not auto-guard single variable OR condition', () => {
    // "A != null OR B != null" — guarding would create tautology
    expect(autoGuardConstraint('A != null OR B != null')).toBe('A != null OR B != null');
  });

  it('does not treat legacy operators like contains as variable references', () => {
    expect(autoGuardConstraint('input contains "booking"')).toBe(
      'input IS NOT SET OR input contains "booking"',
    );
  });

  it('does not treat startsWith as a variable reference', () => {
    expect(autoGuardConstraint('name startsWith "Dr"')).toBe(
      'name IS NOT SET OR name startsWith "Dr"',
    );
  });

  it('does not treat NOT IN as variable references', () => {
    expect(autoGuardConstraint('status NOT IN ["draft", "archived"]')).toBe(
      'status IS NOT SET OR status NOT IN ["draft", "archived"]',
    );
  });

  it('does not treat uppercase function calls as variable references', () => {
    expect(autoGuardConstraint('departure_date > NOW()')).toBe(
      'departure_date IS NOT SET OR departure_date > NOW()',
    );
  });

  it('guards method-call receivers without inventing synthetic variables', () => {
    expect(autoGuardConstraint('input.contains("booking")')).toBe(
      'input IS NOT SET OR input.contains("booking")',
    );
  });

  it('respects lowercase is set / is not set guards without double-guarding', () => {
    expect(autoGuardConstraint('budget is set AND budget > 0')).toBe(
      'budget is set AND budget > 0',
    );
    expect(autoGuardConstraint('destination is not set OR destination != origin')).toBe(
      'destination is not set OR destination != origin',
    );
  });
});
