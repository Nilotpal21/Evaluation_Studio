/**
 * Regex Capture Group Tests
 *
 * Verifies that the MATCHES operator in the condition evaluator
 * stores capture groups on context.match (named, numbered, and full match).
 */

import { describe, test, expect } from 'vitest';
import { evaluateCondition } from '../platform/constructs/evaluator.js';
import { evaluateOnInput } from '../platform/constructs/utils.js';
import type { EvaluationContext } from '../platform/constructs/evaluator.js';

describe('Regex capture groups via MATCHES operator', () => {
  test('named capture groups are stored on context.match', () => {
    const context: EvaluationContext = { input: 'room 42' };
    const result = evaluateCondition('input matches /room\\s*(?<room_id>\\d+)/', context);

    expect(result).toBe(true);
    expect(context['match']).toBeDefined();
    const match = context['match'] as Record<string, string>;
    expect(match['0']).toBe('room 42');
    expect(match['room_id']).toBe('42');
    expect(match['1']).toBe('42');
  });

  test('numbered capture groups are stored as match.1, match.2', () => {
    const context: EvaluationContext = { input: 'hello 123' };
    const result = evaluateCondition('input matches /(\\w+)\\s+(\\d+)/', context);

    expect(result).toBe(true);
    const match = context['match'] as Record<string, string>;
    expect(match['0']).toBe('hello 123');
    expect(match['1']).toBe('hello');
    expect(match['2']).toBe('123');
  });

  test('full match only (no capture groups)', () => {
    const context: EvaluationContext = { input: 'hello world' };
    const result = evaluateCondition('input matches /hello/', context);

    expect(result).toBe(true);
    const match = context['match'] as Record<string, string>;
    expect(match['0']).toBe('hello');
    expect(match['1']).toBeUndefined();
  });

  test('no match does not set context.match', () => {
    const context: EvaluationContext = { input: 'goodbye' };
    const result = evaluateCondition('input matches /hello/', context);

    expect(result).toBe(false);
    expect(context['match']).toBeUndefined();
  });

  test('multiple named captures', () => {
    const context: EvaluationContext = { input: 'check-in 2026-03-15' };
    const result = evaluateCondition(
      'input matches /check-in\\s+(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})/',
      context,
    );

    expect(result).toBe(true);
    const match = context['match'] as Record<string, string>;
    expect(match['year']).toBe('2026');
    expect(match['month']).toBe('03');
    expect(match['day']).toBe('15');
    expect(match['1']).toBe('2026');
    expect(match['2']).toBe('03');
    expect(match['3']).toBe('15');
  });
});

describe('evaluateOnInput with regex captures and SET', () => {
  test('SET can reference match.group_name from regex capture', () => {
    const context: Record<string, unknown> = {};
    const branches = [
      {
        condition: 'input matches /room\\s*(?<room_id>\\d+)/',
        set: { selected_room: 'match.room_id' },
        then: 'confirm_room',
      },
      {
        then: 'ask_room',
      },
    ];

    const result = evaluateOnInput(branches, 'room 42', context);

    expect(result).not.toBeNull();
    expect(result!.then).toBe('confirm_room');
    // The match data should be on context after evaluation
    expect(context['match']).toBeDefined();
    const match = context['match'] as Record<string, string>;
    expect(match['room_id']).toBe('42');
  });

  test('SET can reference numbered capture groups', () => {
    const context: Record<string, unknown> = {};
    const branches = [
      {
        condition: 'input matches /(\\w+)\\s+(\\d+)/',
        set: { item_name: 'match.1', item_count: 'match.2' },
        then: 'process_item',
      },
      {
        then: 'ask_input',
      },
    ];

    const result = evaluateOnInput(branches, 'widget 5', context);

    expect(result).not.toBeNull();
    expect(result!.then).toBe('process_item');
    const match = context['match'] as Record<string, string>;
    expect(match['1']).toBe('widget');
    expect(match['2']).toBe('5');
  });

  test('non-matching regex falls through to ELSE branch', () => {
    const context: Record<string, unknown> = {};
    const branches = [
      {
        condition: 'input matches /room\\s*(?<room_id>\\d+)/',
        set: { selected_room: 'match.room_id' },
        then: 'confirm_room',
      },
      {
        then: 'ask_room',
      },
    ];

    const result = evaluateOnInput(branches, 'something else', context);

    expect(result).not.toBeNull();
    expect(result!.then).toBe('ask_room');
    // match should not be set
    expect(context['match']).toBeUndefined();
  });
});
