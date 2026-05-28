/**
 * UT-4: extractVariables() Pure Function Tests
 *
 * No mocks, no DB — tests regex-based variable extraction.
 */

import { describe, test, expect } from 'vitest';
import { extractVariables } from '../prompt-library-test-service.js';

describe('extractVariables', () => {
  test('extracts multiple unique variables', () => {
    const result = extractVariables('Hello {{name}}, your {{role}} access');
    expect(result).toEqual(['name', 'role']);
  });

  test('deduplicates repeated variables', () => {
    const result = extractVariables('{{a}} {{a}} {{b}}');
    expect(result).toEqual(['a', 'b']);
  });

  test('returns empty array when no variables present', () => {
    const result = extractVariables('Hello world');
    expect(result).toEqual([]);
  });

  test('handles whitespace inside braces', () => {
    const result = extractVariables('{{ name }}');
    expect(result).toEqual(['name']);
  });

  test('handles variables with underscores', () => {
    const result = extractVariables('{{first_name}} {{last_name}}');
    expect(result).toEqual(['first_name', 'last_name']);
  });

  test('handles template with only variables', () => {
    const result = extractVariables('{{x}}{{y}}{{z}}');
    expect(result).toEqual(['x', 'y', 'z']);
  });

  test('handles empty string', () => {
    const result = extractVariables('');
    expect(result).toEqual([]);
  });

  test('ignores incomplete variable syntax', () => {
    const result = extractVariables('{{incomplete and {also} this');
    expect(result).toEqual([]);
  });
});
