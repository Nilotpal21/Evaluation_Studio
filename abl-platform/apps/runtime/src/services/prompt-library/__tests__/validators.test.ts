/**
 * UT-7: Boundary Validator Tests
 *
 * Pure function tests for template size and variable count validators.
 */

import { describe, test, expect } from 'vitest';
import {
  validateTemplateSize,
  validateVariableCount,
  validatePaneCount,
} from '../prompt-library-service.js';

describe('validateTemplateSize', () => {
  test('accepts template at exactly 32768 bytes', () => {
    const template = 'x'.repeat(32768);
    expect(validateTemplateSize(template)).toBe(true);
  });

  test('rejects template at 32769 bytes', () => {
    const template = 'x'.repeat(32769);
    expect(validateTemplateSize(template)).toBe(false);
  });

  test('accepts empty template', () => {
    expect(validateTemplateSize('')).toBe(true);
  });

  test('handles multi-byte characters correctly', () => {
    // Each emoji is 4 bytes in UTF-8
    const emoji = '\u{1F600}'; // 😀
    const bytesPerEmoji = Buffer.byteLength(emoji, 'utf8');
    expect(bytesPerEmoji).toBe(4);

    // Create a string that is exactly 32768 bytes
    const count = Math.floor(32768 / bytesPerEmoji);
    const template = emoji.repeat(count);
    expect(validateTemplateSize(template)).toBe(true);

    // One more emoji pushes it over
    const tooLong = emoji.repeat(count + 1);
    expect(validateTemplateSize(tooLong)).toBe(false);
  });
});

describe('validateVariableCount', () => {
  test('accepts 20 variables', () => {
    const vars = Array.from({ length: 20 }, (_, i) => `var_${i}`);
    expect(validateVariableCount(vars)).toBe(true);
  });

  test('rejects 21 variables', () => {
    const vars = Array.from({ length: 21 }, (_, i) => `var_${i}`);
    expect(validateVariableCount(vars)).toBe(false);
  });

  test('accepts empty array', () => {
    expect(validateVariableCount([])).toBe(true);
  });
});

describe('validatePaneCount', () => {
  test('accepts 5 panes', () => {
    expect(validatePaneCount(5)).toBe(true);
  });

  test('rejects 6 panes', () => {
    expect(validatePaneCount(6)).toBe(false);
  });

  test('accepts 1 pane', () => {
    expect(validatePaneCount(1)).toBe(true);
  });
});
