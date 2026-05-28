/**
 * UT-3: Lifecycle Transition Validation
 *
 * Pure function tests for validateLifecycleTransition().
 * No mocks, no DB — tests a deterministic state machine.
 */

import { describe, test, expect } from 'vitest';
import { validateLifecycleTransition } from '../prompt-library-service.js';

describe('validateLifecycleTransition', () => {
  test('draft → active is valid (promote)', () => {
    expect(validateLifecycleTransition('draft', 'active')).toBe(true);
  });

  test('draft → archived is valid', () => {
    expect(validateLifecycleTransition('draft', 'archived')).toBe(true);
  });

  test('active → archived is valid', () => {
    expect(validateLifecycleTransition('active', 'archived')).toBe(true);
  });

  test('archived → draft is invalid', () => {
    expect(validateLifecycleTransition('archived', 'draft')).toBe(false);
  });

  test('archived → active is invalid', () => {
    expect(validateLifecycleTransition('archived', 'active')).toBe(false);
  });

  test('active → draft is invalid (no demotion)', () => {
    expect(validateLifecycleTransition('active', 'draft')).toBe(false);
  });

  test('same-state transition is invalid', () => {
    expect(validateLifecycleTransition('draft', 'draft')).toBe(false);
    expect(validateLifecycleTransition('active', 'active')).toBe(false);
    expect(validateLifecycleTransition('archived', 'archived')).toBe(false);
  });
});
