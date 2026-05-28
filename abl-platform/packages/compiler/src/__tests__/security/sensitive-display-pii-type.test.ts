/**
 * TDD lock tests for Slice 5 [ABLP-414] — PII_TYPE-aware sensitive rendering.
 *
 * When a GatherField has both `sensitive_display: 'mask'` and `pii_type: 'email'`,
 * the renderer must preserve the `@domain` suffix (email-shape) instead of
 * applying a generic character mask that produces `+14***@***` nonsense.
 *
 * Without the hint, non-canonical field names (contact_info, customer_number)
 * cannot be reliably formatted. The explicit hint is the only signal the
 * renderer can trust.
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
    sensitive: true,
    sensitive_display: 'mask',
    ...overrides,
  };
}

describe('renderSensitiveValue — pii_type hint', () => {
  test('masks email preserving @domain when pii_type=email', () => {
    const field = makeField({ pii_type: 'email', name: 'contact_info' });
    const result = renderSensitiveValue('alice.smith@example.com', field);
    // Local part should be masked, domain should be preserved
    expect(result).toContain('@example.com');
    expect(result).not.toContain('alice.smith');
  });

  test('masks non-email values with generic mask when pii_type=phone', () => {
    const field = makeField({ pii_type: 'phone', name: 'customer_number' });
    const result = renderSensitiveValue('+14155551234', field);
    // Phone must NOT be mistaken for an email — no @ in output
    expect(result).not.toContain('@');
    // Some masking must have occurred
    expect(result).not.toBe('+14155551234');
  });

  test('without pii_type hint, non-canonical fields get generic mask', () => {
    const field = makeField({ name: 'contact_info' });
    const result = renderSensitiveValue('alice@example.com', field);
    // Without hint, the renderer cannot know this is an email — generic mask applied
    expect(result).not.toBe('alice@example.com');
  });

  test('pii_type=email takes precedence over field-name inference', () => {
    // Field named `phone_number` but explicitly tagged as email
    const field = makeField({ name: 'phone_number', pii_type: 'email' });
    const result = renderSensitiveValue('test@example.com', field);
    // Explicit hint wins — email format preserved
    expect(result).toContain('@example.com');
  });

  test('pii_type is ignored when sensitive is false', () => {
    const field = makeField({ sensitive: false, pii_type: 'email' });
    // Not sensitive → passthrough, pii_type hint irrelevant
    expect(renderSensitiveValue('alice@example.com', field)).toBe('alice@example.com');
  });

  test('pii_type on redact mode still produces [REDACTED]', () => {
    const field = makeField({ sensitive_display: 'redact', pii_type: 'email' });
    // redact doesn't need email-awareness — it's a full replacement
    expect(renderSensitiveValue('alice@example.com', field)).toBe('[REDACTED]');
  });
});
