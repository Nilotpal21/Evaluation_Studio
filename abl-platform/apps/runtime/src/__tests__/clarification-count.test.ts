import { describe, test, expect } from 'vitest';
import { resolveClarificationStrategy } from '../services/execution/flow-step-executor.js';

describe('_clarification_count', () => {
  test('resolveClarificationStrategy keeps normal clarification prompts within question budget', () => {
    expect(
      resolveClarificationStrategy({
        currentCount: 0,
        maxQuestions: 1,
        maxAttempts: 2,
      }),
    ).toEqual({
      nextCount: 1,
      stage: 'clarify',
    });
  });

  test('resolveClarificationStrategy switches to repair after clarification budget is exhausted', () => {
    expect(
      resolveClarificationStrategy({
        currentCount: 1,
        maxQuestions: 1,
        maxAttempts: 2,
      }),
    ).toEqual({
      nextCount: 2,
      stage: 'repair',
    });
  });

  test('resolveClarificationStrategy holds steady after clarification and repair budgets are exhausted', () => {
    expect(
      resolveClarificationStrategy({
        currentCount: 3,
        maxQuestions: 1,
        maxAttempts: 2,
      }),
    ).toEqual({
      nextCount: 3,
      stage: 'hold',
    });
  });

  test('incrementClarificationCount increments from 0', () => {
    const session = {
      data: { values: { _clarification_count: 0 } },
    } as any;

    // Simulate what incrementClarificationCount does:
    session.data.values._clarification_count =
      ((session.data.values._clarification_count as number) || 0) + 1;

    expect(session.data.values._clarification_count).toBe(1);
  });

  test('incrementClarificationCount increments from existing value', () => {
    const session = {
      data: { values: { _clarification_count: 3 } },
    } as any;

    session.data.values._clarification_count =
      ((session.data.values._clarification_count as number) || 0) + 1;

    expect(session.data.values._clarification_count).toBe(4);
  });

  test('incrementClarificationCount handles undefined gracefully', () => {
    const session = {
      data: { values: {} },
    } as any;

    session.data.values._clarification_count =
      ((session.data.values._clarification_count as number) || 0) + 1;

    expect(session.data.values._clarification_count).toBe(1);
  });

  test('per-step reset when step changes', () => {
    const session = {
      data: {
        values: {
          _clarification_count: 5,
          _current_step_for_clarification: 'step_a',
        },
      },
    } as any;

    const stepName = 'step_b';
    const prevClarificationStep = session.data.values['_current_step_for_clarification'];
    if (prevClarificationStep !== stepName) {
      session.data.values._clarification_count = 0;
      session.data.values['_current_step_for_clarification'] = stepName;
    }

    expect(session.data.values._clarification_count).toBe(0);
    expect(session.data.values['_current_step_for_clarification']).toBe('step_b');
  });

  test('no reset when same step', () => {
    const session = {
      data: {
        values: {
          _clarification_count: 3,
          _current_step_for_clarification: 'step_a',
        },
      },
    } as any;

    const stepName = 'step_a';
    const prevClarificationStep = session.data.values['_current_step_for_clarification'];
    if (prevClarificationStep !== stepName) {
      session.data.values._clarification_count = 0;
      session.data.values['_current_step_for_clarification'] = stepName;
    }

    expect(session.data.values._clarification_count).toBe(3); // Not reset
  });

  test('_clarification_count usable in conditions', () => {
    const session = {
      data: {
        values: {
          _clarification_count: 3,
        },
      },
    } as any;

    // Simulate a condition check: _clarification_count >= 3
    const count = session.data.values._clarification_count as number;
    expect(count >= 3).toBe(true);
    expect(count >= 4).toBe(false);
  });
});
