/**
 * Sensitive Display Renderer Tests
 *
 * Tests renderSensitiveValue() which formats GatherField values
 * according to their sensitive_display mode (redact/mask/replace)
 * and mask_config settings.
 */
import { describe, test, expect } from 'vitest';
import { renderSensitiveValue } from '../../platform/security/sensitive-display.js';
import type { GatherField } from '../../platform/ir/schema.js';

function makeField(overrides: Partial<GatherField>): GatherField {
  return {
    name: 'test_field',
    prompt: 'Enter value',
    type: 'string',
    required: true,
    ...overrides,
  };
}

// =============================================================================
// 1. NON-SENSITIVE PASSTHROUGH
// =============================================================================

describe('Sensitive Display Renderer', () => {
  describe('non-sensitive passthrough', () => {
    test('returns original value when field is not sensitive', () => {
      const field = makeField({ sensitive: false });
      expect(renderSensitiveValue('secret123', field)).toBe('secret123');
    });

    test('returns original value when sensitive is undefined', () => {
      const field = makeField({});
      expect(renderSensitiveValue('secret123', field)).toBe('secret123');
    });

    test('returns original value when sensitive but no display mode', () => {
      const field = makeField({ sensitive: true });
      expect(renderSensitiveValue('secret123', field)).toBe('secret123');
    });

    test('sensitive=false always returns original regardless of display mode', () => {
      const field = makeField({
        sensitive: false,
        sensitive_display: 'redact',
      });
      expect(renderSensitiveValue('secret123', field)).toBe('secret123');
    });
  });

  // =============================================================================
  // 2. REDACT MODE
  // =============================================================================

  describe('redact mode', () => {
    test('redacts value when sensitive_display is redact', () => {
      const field = makeField({ sensitive: true, sensitive_display: 'redact' });
      expect(renderSensitiveValue('my-secret', field)).toBe('[REDACTED]');
    });

    test('redacts regardless of value content', () => {
      const field = makeField({ sensitive: true, sensitive_display: 'redact' });
      expect(renderSensitiveValue('', field)).toBe('[REDACTED]');
      expect(renderSensitiveValue('a', field)).toBe('[REDACTED]');
      expect(renderSensitiveValue('very long value with spaces', field)).toBe('[REDACTED]');
    });
  });

  // =============================================================================
  // 3. REPLACE MODE
  // =============================================================================

  describe('replace mode', () => {
    test('replaces value when sensitive_display is replace', () => {
      const field = makeField({
        name: 'ssn',
        sensitive: true,
        sensitive_display: 'replace',
      });
      expect(renderSensitiveValue('123-45-6789', field)).toBe('[SSN]');
    });

    test('uses field name uppercased', () => {
      const field = makeField({
        name: 'credit_card',
        sensitive: true,
        sensitive_display: 'replace',
      });
      expect(renderSensitiveValue('4111111111111111', field)).toBe('[CREDIT_CARD]');
    });

    test('handles single-word field name', () => {
      const field = makeField({
        name: 'password',
        sensitive: true,
        sensitive_display: 'replace',
      });
      expect(renderSensitiveValue('hunter2', field)).toBe('[PASSWORD]');
    });
  });

  // =============================================================================
  // 4. MASK MODE
  // =============================================================================

  describe('mask mode', () => {
    test('masks value with default config when no mask_config provided', () => {
      const field = makeField({ sensitive: true, sensitive_display: 'mask' });
      // default: show_first=0, show_last=3, char='*'
      expect(renderSensitiveValue('1234567890', field)).toBe('*******890');
    });

    test('default mask char is *', () => {
      const field = makeField({ sensitive: true, sensitive_display: 'mask' });
      const result = renderSensitiveValue('abcdef', field);
      expect(result).toContain('*');
      expect(result).toBe('***def');
    });

    test('masks value with custom mask_config', () => {
      const field = makeField({
        sensitive: true,
        sensitive_display: 'mask',
        mask_config: { show_first: 2, show_last: 2, char: '#' },
      });
      expect(renderSensitiveValue('1234567890', field)).toBe('12######90');
    });

    test('masks with show_first only (show_last=0)', () => {
      const field = makeField({
        sensitive: true,
        sensitive_display: 'mask',
        mask_config: { show_first: 4, show_last: 0, char: '*' },
      });
      expect(renderSensitiveValue('4111222233334444', field)).toBe('4111************');
    });

    test('masks with show_last only (show_first=0)', () => {
      const field = makeField({
        sensitive: true,
        sensitive_display: 'mask',
        mask_config: { show_first: 0, show_last: 4, char: '*' },
      });
      expect(renderSensitiveValue('4111222233334444', field)).toBe('************4444');
    });

    test('handles short values gracefully - returns minimum 3 mask chars', () => {
      const field = makeField({
        sensitive: true,
        sensitive_display: 'mask',
        mask_config: { show_first: 2, show_last: 2, char: '*' },
      });
      // value length (2) <= show_first + show_last (4), so fall back to repeated char
      expect(renderSensitiveValue('ab', field)).toBe('***');
    });

    test('handles value exactly equal to showFirst + showLast length', () => {
      const field = makeField({
        sensitive: true,
        sensitive_display: 'mask',
        mask_config: { show_first: 2, show_last: 2, char: '*' },
      });
      // value length (4) == show_first + show_last (4), falls back
      expect(renderSensitiveValue('abcd', field)).toBe('****');
    });

    test('handles single char value', () => {
      const field = makeField({ sensitive: true, sensitive_display: 'mask' });
      // length 1 <= 0+3, fallback to max(1,3) = 3
      expect(renderSensitiveValue('x', field)).toBe('***');
    });

    test('handles empty string value', () => {
      const field = makeField({ sensitive: true, sensitive_display: 'mask' });
      // length 0 <= 0+3, fallback to max(0,3) = 3
      expect(renderSensitiveValue('', field)).toBe('***');
    });
  });

  // =============================================================================
  // 5. NULL/UNDEFINED HANDLING
  // =============================================================================

  describe('null and undefined handling', () => {
    test('handles null values', () => {
      const field = makeField({ sensitive: true, sensitive_display: 'redact' });
      expect(renderSensitiveValue(null, field)).toBe('');
    });

    test('handles undefined values', () => {
      const field = makeField({ sensitive: true, sensitive_display: 'redact' });
      expect(renderSensitiveValue(undefined, field)).toBe('');
    });
  });

  // =============================================================================
  // 6. TYPE COERCION
  // =============================================================================

  describe('type coercion', () => {
    test('handles numeric values coerced to string', () => {
      const field = makeField({ sensitive: true, sensitive_display: 'mask' });
      // 12345 -> '12345', default mask: show_first=0, show_last=3
      expect(renderSensitiveValue(12345, field)).toBe('**345');
    });

    test('handles boolean values coerced to string', () => {
      const field = makeField({ sensitive: true, sensitive_display: 'redact' });
      expect(renderSensitiveValue(true, field)).toBe('[REDACTED]');
    });

    test('handles boolean with mask mode', () => {
      const field = makeField({ sensitive: true, sensitive_display: 'mask' });
      // 'true' length 4 > 0+3, so mask first char
      expect(renderSensitiveValue(true, field)).toBe('*rue');
    });

    test('handles object coerced to string', () => {
      const field = makeField({ sensitive: true, sensitive_display: 'redact' });
      expect(renderSensitiveValue({ key: 'val' }, field)).toBe('[REDACTED]');
    });
  });
});
