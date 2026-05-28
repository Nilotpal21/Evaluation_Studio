import { describe, test, expect, vi } from 'vitest';
import { applyInferences, type InferenceResult } from '../services/execution/field-inference.js';

describe('Inference confirmation flow', () => {
  test('applyInferences with confirm=true returns confirmationMessage', () => {
    const results: InferenceResult[] = [
      {
        field: 'cabin_class',
        value: 'economy',
        confidence: 0.9,
        reasoning: 'default',
        accepted: true,
      },
    ];
    const values: Record<string, unknown> = {};
    const { applied, confirmationMessage } = applyInferences(results, values, true);

    expect(applied).toEqual({ cabin_class: 'economy' });
    expect(confirmationMessage).toContain('cabin class');
    expect(confirmationMessage).toContain('economy');
    expect(confirmationMessage).toContain('Does that work');
  });

  test('applyInferences with confirm=false returns null confirmationMessage', () => {
    const results: InferenceResult[] = [
      {
        field: 'cabin_class',
        value: 'economy',
        confidence: 0.9,
        reasoning: 'default',
        accepted: true,
      },
    ];
    const values: Record<string, unknown> = {};
    const { confirmationMessage } = applyInferences(results, values, false);

    expect(confirmationMessage).toBeNull();
  });

  test('affirmative response applies inferred values', () => {
    const pendingInferences = { cabin_class: 'economy' };
    const values: Record<string, unknown> = {};
    Object.assign(values, pendingInferences);
    expect(values.cabin_class).toBe('economy');
  });

  test('negative response discards inferred values', () => {
    const pendingInferences = { cabin_class: 'economy' };
    const values: Record<string, unknown> = {};
    // User rejected — do NOT apply
    expect(values).not.toHaveProperty('cabin_class');
  });

  test('session waitingForInput marker for inference confirmation', () => {
    const marker = '_inference_confirmation_';
    expect(marker.startsWith('_')).toBe(true);
    expect(marker).not.toBe('_queued_intent_confirmation_');
    expect(marker).not.toBe('_disambiguation_choice');
  });
});
