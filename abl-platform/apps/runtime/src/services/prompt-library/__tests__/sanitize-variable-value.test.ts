/**
 * UT-8: sanitizeVariableValue() Pure Function Tests
 *
 * Tests injection prevention by stripping {{ and }} from values.
 */

import { describe, test, expect } from 'vitest';
import { sanitizeVariableValue } from '../prompt-library-test-service.js';

describe('sanitizeVariableValue', () => {
  test('strips {{ and }} from value', () => {
    expect(sanitizeVariableValue('hello {{world}}')).toBe('hello world');
  });

  test('strips multiple occurrences', () => {
    expect(sanitizeVariableValue('{{a}} and {{b}}')).toBe('a and b');
  });

  test('returns unchanged string with no braces', () => {
    expect(sanitizeVariableValue('plain text')).toBe('plain text');
  });

  test('handles empty string', () => {
    expect(sanitizeVariableValue('')).toBe('');
  });

  test('strips only {{ and }}, not single braces', () => {
    expect(sanitizeVariableValue('{ hello } { world }')).toBe('{ hello } { world }');
  });

  test('strips nested double braces', () => {
    expect(sanitizeVariableValue('{{{{nested}}}}')).toBe('nested');
  });
});
