import { describe, it, expect } from 'vitest';
import {
  GRADIENT_TOKENS,
  getGradientStyles,
  getGradientValue,
  type GradientToken,
} from '../gradients';

describe('Gradient Design Tokens', () => {
  // U-1: GradientToken type includes all expected token names
  it('U-1: GRADIENT_TOKENS contains all 14 expected token names', () => {
    const expectedTokens: GradientToken[] = [
      'brand',
      'brand-subtle',
      'brand-text',
      'brand-fade',
      'surface-panel',
      'surface-sidebar',
      'surface-page',
      'surface-accent',
      'status-success',
      'status-warning',
      'status-error',
      'glow-accent',
      'glow-ambient',
      'shimmer',
    ];

    const actualTokens = Object.keys(GRADIENT_TOKENS);
    expect(actualTokens).toHaveLength(expectedTokens.length);
    for (const token of expectedTokens) {
      expect(GRADIENT_TOKENS).toHaveProperty(token);
    }
  });

  // U-2: getGradientStyles() returns valid GradientStyles
  it('U-2: getGradientStyles("brand") returns bg, text, border, cssVar', () => {
    const styles = getGradientStyles('brand');
    expect(styles).toBeDefined();
    expect(styles?.bg).toBe('bg-gradient-brand');
    expect(styles?.text).toBe('text-gradient-brand');
    expect(styles?.border).toBe('border-gradient-brand');
    expect(styles?.cssVar).toBe('var(--gradient-brand)');
  });

  // U-3: GRADIENT_TOKENS has cssVar and className for every token
  it('U-3: every token entry has cssVar and className', () => {
    for (const [, entry] of Object.entries(GRADIENT_TOKENS)) {
      expect(entry.cssVar).toBeDefined();
      expect(typeof entry.cssVar).toBe('string');
      expect(entry.cssVar.length).toBeGreaterThan(0);

      expect(entry.className).toBeDefined();
      expect(typeof entry.className).toBe('string');
      expect(entry.className.length).toBeGreaterThan(0);
    }
  });

  // U-4: getGradientValue() returns var(--gradient-<token>) format
  it.each([
    ['brand', 'var(--gradient-brand)'],
    ['surface-panel', 'var(--gradient-surface-panel)'],
    ['status-success', 'var(--gradient-status-success)'],
    ['glow-accent', 'var(--gradient-glow-accent)'],
    ['shimmer', 'var(--gradient-shimmer)'],
  ] as [GradientToken, string][])('U-4: getGradientValue("%s") returns "%s"', (token, expected) => {
    expect(getGradientValue(token)).toBe(expected);
  });

  // U-5: All tokens have cssVar starting with --gradient-
  it('U-5: all token cssVar values start with --gradient-', () => {
    for (const entry of Object.values(GRADIENT_TOKENS)) {
      expect(entry.cssVar).toMatch(/^--gradient-/);
    }
  });

  // U-6: getGradientStyles() handles invalid token names gracefully
  it('U-6: getGradientStyles with invalid token returns undefined', () => {
    const result = getGradientStyles('nonexistent-token' as GradientToken);
    expect(result).toBeUndefined();
  });

  it('U-6: getGradientValue with invalid token returns undefined', () => {
    const result = getGradientValue('nonexistent-token' as GradientToken);
    expect(result).toBeUndefined();
  });

  // U-7: Token categories each have expected members
  it('U-7: brand category has >= 2 tokens', () => {
    const brandTokens = Object.entries(GRADIENT_TOKENS).filter(
      ([, entry]) => entry.category === 'brand',
    );
    expect(brandTokens.length).toBeGreaterThanOrEqual(2);
  });

  it('U-7: surface category has >= 2 tokens', () => {
    const surfaceTokens = Object.entries(GRADIENT_TOKENS).filter(
      ([, entry]) => entry.category === 'surface',
    );
    expect(surfaceTokens.length).toBeGreaterThanOrEqual(2);
  });

  it('U-7: status category has >= 3 tokens', () => {
    const statusTokens = Object.entries(GRADIENT_TOKENS).filter(
      ([, entry]) => entry.category === 'status',
    );
    expect(statusTokens.length).toBeGreaterThanOrEqual(3);
  });

  it('U-7: glow category has >= 1 token', () => {
    const glowTokens = Object.entries(GRADIENT_TOKENS).filter(
      ([, entry]) => entry.category === 'glow',
    );
    expect(glowTokens.length).toBeGreaterThanOrEqual(1);
  });
});
