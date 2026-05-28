/**
 * Enhanced ValidationRule Tests
 *
 * Validates the extended ValidationRule type which now supports:
 * - type='llm' for LLM-based validation
 * - retry_prompt for custom re-collection prompts
 * - max_retries for capping validation retry attempts
 * - Backward compatibility with existing types (pattern, custom)
 */

import { describe, test, expect } from 'vitest';
import type { ValidationRule } from '../platform/ir/schema.js';

describe('ValidationRule enhanced fields', () => {
  test('type="llm" creates a valid ValidationRule', () => {
    const rule: ValidationRule = {
      type: 'llm',
      rule: 'The date must be in the future and within the next 12 months.',
      error_message: 'Please provide a valid future date within the next year.',
    };

    expect(rule.type).toBe('llm');
    expect(rule.rule).toContain('future');
    expect(rule.error_message).toBeTruthy();
  });

  test('retry_prompt creates a valid ValidationRule', () => {
    const rule: ValidationRule = {
      type: 'pattern',
      rule: '^\\d{4}-\\d{2}-\\d{2}$',
      error_message: 'Invalid date format.',
      retry_prompt: 'Please enter the date in YYYY-MM-DD format (e.g. 2026-03-15).',
    };

    expect(rule.retry_prompt).toBe('Please enter the date in YYYY-MM-DD format (e.g. 2026-03-15).');
    expect(rule.type).toBe('pattern');
  });

  test('max_retries creates a valid ValidationRule', () => {
    const rule: ValidationRule = {
      type: 'enum',
      rule: 'economy,business,first',
      error_message: 'Please choose economy, business, or first class.',
      max_retries: 3,
    };

    expect(rule.max_retries).toBe(3);
    expect(rule.type).toBe('enum');
  });

  test('type="pattern" still works (backward compatibility)', () => {
    const rule: ValidationRule = {
      type: 'pattern',
      rule: '^[A-Z]{3}$',
      error_message: 'Please enter a valid 3-letter airport code (e.g. LAX).',
    };

    expect(rule.type).toBe('pattern');
    expect(rule.rule).toBe('^[A-Z]{3}$');
    expect(rule.error_message).toContain('airport code');
  });

  test('type="custom" still works (backward compatibility)', () => {
    const rule: ValidationRule = {
      type: 'custom',
      rule: 'value.length >= 2 && value.length <= 50',
      error_message: 'Name must be between 2 and 50 characters.',
    };

    expect(rule.type).toBe('custom');
    expect(rule.rule).toContain('value.length');
  });

  test('all new fields combined on a single ValidationRule', () => {
    const rule: ValidationRule = {
      type: 'llm',
      rule: 'Validate that the email address belongs to a corporate domain (not gmail, yahoo, etc.).',
      error_message: 'We require a corporate email address.',
      retry_prompt: 'Please provide your work email address (e.g. you@company.com).',
      max_retries: 2,
    };

    expect(rule.type).toBe('llm');
    expect(rule.retry_prompt).toContain('work email');
    expect(rule.max_retries).toBe(2);
    expect(rule.error_message).toContain('corporate email');
  });
});
