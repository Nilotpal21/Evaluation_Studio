/**
 * GatherField prompt_mode Tests
 *
 * Validates the prompt_mode field on GatherField, which controls whether
 * the prompt is used for user-facing questions ('ask') or LLM extraction
 * instructions only ('extract_only').
 */

import { describe, test, expect } from 'vitest';
import type { GatherField } from '../platform/ir/schema.js';

describe('GatherField prompt_mode', () => {
  test('prompt_mode="ask" creates a valid GatherField', () => {
    const field: GatherField = {
      name: 'destination',
      prompt: 'Where would you like to go?',
      type: 'string',
      required: true,
      extraction_hints: [],
      prompt_mode: 'ask',
    };

    expect(field.prompt_mode).toBe('ask');
    expect(field.prompt).toBe('Where would you like to go?');
  });

  test('prompt_mode="extract_only" creates a valid GatherField', () => {
    const field: GatherField = {
      name: 'sentiment',
      prompt: 'Detect the overall sentiment from the conversation.',
      type: 'string',
      required: false,
      extraction_hints: ['positive', 'negative', 'neutral'],
      prompt_mode: 'extract_only',
    };

    expect(field.prompt_mode).toBe('extract_only');
    expect(field.prompt).toBe('Detect the overall sentiment from the conversation.');
  });

  test('field with default set and no prompt_mode documents expected auto behavior (extract_only)', () => {
    // When a field has a default value and no explicit prompt_mode, the runtime
    // should auto-select 'extract_only' — the field already has a sensible value
    // so there is no need to actively prompt the user for it.
    const field: GatherField = {
      name: 'currency',
      prompt: 'Extract the currency from context if mentioned.',
      type: 'string',
      required: false,
      extraction_hints: ['USD', 'EUR', 'GBP'],
      default: 'USD',
      // prompt_mode intentionally omitted
    };

    expect(field.prompt_mode).toBeUndefined();
    expect(field.default).toBe('USD');

    // Document the expected runtime behavior:
    // When default is set and prompt_mode is undefined, runtime should treat as 'extract_only'.
    const expectedRuntimeMode = field.default !== undefined ? 'extract_only' : 'ask';
    expect(expectedRuntimeMode).toBe('extract_only');
  });

  test('field with no default and no prompt_mode documents expected auto behavior (ask)', () => {
    // When a field has no default and no explicit prompt_mode, the runtime
    // should auto-select 'ask' — the user must be prompted to provide the value.
    const field: GatherField = {
      name: 'check_in_date',
      prompt: 'When would you like to check in?',
      type: 'date',
      required: true,
      extraction_hints: [],
      // No default, no prompt_mode
    };

    expect(field.prompt_mode).toBeUndefined();
    expect(field.default).toBeUndefined();

    // Document the expected runtime behavior:
    // When no default and prompt_mode is undefined, runtime should treat as 'ask'.
    const expectedRuntimeMode = field.default !== undefined ? 'extract_only' : 'ask';
    expect(expectedRuntimeMode).toBe('ask');
  });
});
