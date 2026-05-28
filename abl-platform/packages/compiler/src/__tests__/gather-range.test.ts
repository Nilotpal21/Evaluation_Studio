/**
 * Gather Field Range Tests
 *
 * Verifies the range flag and RangeValue type on GatherField.
 * When range=true, the collected value is expected to be a { low, high }
 * object instead of a scalar.
 */

import { describe, test, expect } from 'vitest';
import type { GatherField, RangeValue } from '../platform/ir/schema.js';

// ---------------------------------------------------------------------------
// GatherField with range flag
// ---------------------------------------------------------------------------

describe('GatherField with range=true', () => {
  test('number type GatherField with range=true creates valid object', () => {
    const field: GatherField = {
      name: 'budget',
      prompt: 'What is your budget range?',
      type: 'number',
      required: true,
      range: true,
    };

    expect(field.range).toBe(true);
    expect(field.type).toBe('number');
    expect(field.name).toBe('budget');
  });

  test('date type GatherField with range=true creates valid object', () => {
    const field: GatherField = {
      name: 'travel_dates',
      prompt: 'When do you want to travel?',
      type: 'date',
      required: true,
      range: true,
    };

    expect(field.range).toBe(true);
    expect(field.type).toBe('date');
    expect(field.name).toBe('travel_dates');
  });

  test('GatherField without range defaults to undefined', () => {
    const field: GatherField = {
      name: 'city',
      prompt: 'Which city?',
      type: 'string',
      required: true,
    };

    expect(field.range).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RangeValue shape
// ---------------------------------------------------------------------------

describe('RangeValue type', () => {
  test('RangeValue with both low and high bounds is valid', () => {
    const range: RangeValue<number> = { low: 100, high: 300 };

    expect(range.low).toBe(100);
    expect(range.high).toBe(300);
  });

  test('RangeValue with only high bound is valid', () => {
    const range: RangeValue<number> = { high: 250 };

    expect(range.low).toBeUndefined();
    expect(range.high).toBe(250);
  });

  test('RangeValue with only low bound is valid', () => {
    const range: RangeValue<number> = { low: 200 };

    expect(range.low).toBe(200);
    expect(range.high).toBeUndefined();
  });

  test('RangeValue with string type for date ranges', () => {
    const range: RangeValue<string> = { low: '2026-03-01', high: '2026-03-15' };

    expect(range.low).toBe('2026-03-01');
    expect(range.high).toBe('2026-03-15');
  });

  test('empty RangeValue is valid (both bounds optional)', () => {
    const range: RangeValue<number> = {};

    expect(range.low).toBeUndefined();
    expect(range.high).toBeUndefined();
  });
});
