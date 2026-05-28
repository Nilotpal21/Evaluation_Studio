/**
 * Gather Field List & Preferences Tests
 *
 * Verifies the list and preferences flags on GatherField,
 * plus the PreferenceValue type shape.
 *
 * Design constraint: preferences=true is intended to be used together
 * with list=true, since preference categorization (accept/desire/avoid/refuse)
 * operates on collections of values, not single scalars.
 */

import { describe, test, expect } from 'vitest';
import type { GatherField, PreferenceValue } from '../platform/ir/schema.js';

// ---------------------------------------------------------------------------
// GatherField with list flag
// ---------------------------------------------------------------------------

describe('GatherField with list=true', () => {
  test('GatherField with list=true creates valid object', () => {
    const field: GatherField = {
      name: 'interests',
      prompt: 'What are your interests?',
      type: 'string',
      required: true,
      list: true,
    };

    expect(field.list).toBe(true);
    expect(field.preferences).toBeUndefined();
  });

  test('GatherField without list defaults to undefined', () => {
    const field: GatherField = {
      name: 'name',
      prompt: 'What is your name?',
      type: 'string',
      required: true,
    };

    expect(field.list).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GatherField with list + preferences
// ---------------------------------------------------------------------------

describe('GatherField with list and preferences', () => {
  test('GatherField with list=true and preferences=true creates valid object', () => {
    const field: GatherField = {
      name: 'food_preferences',
      prompt: 'Tell me about your food preferences',
      type: 'string',
      required: true,
      list: true,
      preferences: true,
    };

    expect(field.list).toBe(true);
    expect(field.preferences).toBe(true);
  });

  test('preferences=true requires list=true (design constraint documentation)', () => {
    // This test documents the design constraint that preferences should be
    // combined with list=true. The TypeScript type allows preferences=true
    // without list=true (no type-level enforcement), but the intended usage
    // is always together since preference categorization (accept/desire/avoid/refuse)
    // operates on collections of values.
    //
    // A field with preferences=true but list=false/undefined is structurally valid
    // at the type level but represents a semantic misuse:
    const fieldWithoutList: GatherField = {
      name: 'cuisine',
      prompt: 'Any cuisine preference?',
      type: 'string',
      required: false,
      preferences: true,
      // list is intentionally omitted — this documents the gap
    };

    // The type system does not enforce this constraint, but runtime/compiler
    // validation should flag it as a warning.
    expect(fieldWithoutList.preferences).toBe(true);
    expect(fieldWithoutList.list).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PreferenceValue shape
// ---------------------------------------------------------------------------

describe('PreferenceValue type', () => {
  test('PreferenceValue with all categories populated', () => {
    const prefs: PreferenceValue<string> = {
      accept: ['Italian', 'Thai'],
      desire: ['Japanese', 'Mexican'],
      avoid: ['Fast food'],
      refuse: ['Shellfish'],
    };

    expect(prefs.accept).toEqual(['Italian', 'Thai']);
    expect(prefs.desire).toEqual(['Japanese', 'Mexican']);
    expect(prefs.avoid).toEqual(['Fast food']);
    expect(prefs.refuse).toEqual(['Shellfish']);
  });

  test('PreferenceValue with empty categories is valid', () => {
    const prefs: PreferenceValue<string> = {
      accept: [],
      desire: [],
      avoid: [],
      refuse: [],
    };

    expect(prefs.accept).toEqual([]);
    expect(prefs.desire).toEqual([]);
    expect(prefs.avoid).toEqual([]);
    expect(prefs.refuse).toEqual([]);
  });

  test('PreferenceValue with numeric type', () => {
    const prefs: PreferenceValue<number> = {
      accept: [72, 75],
      desire: [70],
      avoid: [80, 85],
      refuse: [90],
    };

    expect(prefs.accept).toContain(72);
    expect(prefs.refuse).toContain(90);
  });

  test('PreferenceValue has exactly four required categories', () => {
    const prefs: PreferenceValue<string> = {
      accept: ['a'],
      desire: ['b'],
      avoid: ['c'],
      refuse: ['d'],
    };

    const keys = Object.keys(prefs);
    expect(keys).toHaveLength(4);
    expect(keys).toContain('accept');
    expect(keys).toContain('desire');
    expect(keys).toContain('avoid');
    expect(keys).toContain('refuse');
  });
});
