import { describe, expect, test } from 'vitest';
import {
  NAMESPACE_COLOR_TOKENS,
  SEMANTIC_CHART_COLORS,
  isNamespaceColorToken,
  resolveNamespaceColor,
} from '../chart-colors';

/**
 * Canonical namespace color tokens. Must mirror VARIABLE_NAMESPACE_COLOR_TOKENS
 * exported from @agent-platform/database (variable-namespace.model.ts). A
 * sibling test in that package pins the same list — drift on either side
 * fails its own test.
 *
 * Regression coverage for ABLP-633.
 */
const CANONICAL_TOKENS = ['accent', 'success', 'warning', 'purple', 'info', 'error', 'orange'];

describe('NAMESPACE_COLOR_TOKENS contract', () => {
  test('exports the canonical token list in order', () => {
    expect([...NAMESPACE_COLOR_TOKENS]).toEqual(CANONICAL_TOKENS);
  });

  test('every token resolves to a SEMANTIC_CHART_COLORS entry', () => {
    for (const token of NAMESPACE_COLOR_TOKENS) {
      expect(SEMANTIC_CHART_COLORS[token]).toBeTruthy();
      expect(resolveNamespaceColor(token)).toBe(SEMANTIC_CHART_COLORS[token]);
    }
  });

  test('isNamespaceColorToken narrows correctly', () => {
    for (const token of CANONICAL_TOKENS) {
      expect(isNamespaceColorToken(token)).toBe(true);
    }
    expect(isNamespaceColorToken('hsl(var(--accent))')).toBe(false);
    expect(isNamespaceColorToken('magenta')).toBe(false);
    expect(isNamespaceColorToken('')).toBe(false);
    expect(isNamespaceColorToken(null)).toBe(false);
    expect(isNamespaceColorToken(undefined)).toBe(false);
  });

  test('resolveNamespaceColor passes through valid 6-digit hex', () => {
    expect(resolveNamespaceColor('#1a2b3c')).toBe('#1a2b3c');
  });

  test('resolveNamespaceColor returns null for unknown/invalid input', () => {
    expect(resolveNamespaceColor(null)).toBeNull();
    expect(resolveNamespaceColor(undefined)).toBeNull();
    expect(resolveNamespaceColor('')).toBeNull();
    expect(resolveNamespaceColor('hsl(var(--accent))')).toBeNull();
    expect(resolveNamespaceColor('rgba(0,0,0,1)')).toBeNull();
    expect(resolveNamespaceColor('#abc')).toBeNull();
  });
});
