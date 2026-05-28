/**
 * Gradient Design Token Integration Tests (I-1 through I-7)
 *
 * Verifies the CSS token layer and package export surface by parsing
 * the globals.css source file and checking the design-tokens barrel export.
 *
 * Pattern: fs.readFileSync + regex (same approach as wiring.test.ts)
 */

import { describe, test, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// HELPERS
// =============================================================================

const GLOBALS_CSS_PATH = path.resolve(import.meta.dirname, '../app/globals.css');
const GLOBALS_CSS = fs.readFileSync(GLOBALS_CSS_PATH, 'utf-8');

const EXPECTED_GRADIENT_TOKENS = [
  '--gradient-brand',
  '--gradient-brand-subtle',
  '--gradient-brand-text',
  '--gradient-brand-fade',
  '--gradient-surface-panel',
  '--gradient-surface-sidebar',
  '--gradient-surface-page',
  '--gradient-surface-accent',
  '--gradient-status-success',
  '--gradient-status-warning',
  '--gradient-status-error',
  '--gradient-glow-accent',
  '--gradient-glow-ambient',
  '--gradient-shimmer',
];

/**
 * Extract all `--gradient-*` property declarations from a CSS block.
 * Returns an array of property names (e.g. `--gradient-brand`).
 */
function extractGradientVars(cssBlock: string): string[] {
  const matches = cssBlock.match(/--gradient-[\w-]+(?=\s*:)/g);
  return matches ? [...new Set(matches)] : [];
}

/**
 * Extract the first `:root { ... }` block from CSS content.
 * Uses brace counting to handle nested blocks.
 */
function extractRootBlock(css: string): string {
  const rootStart = css.indexOf(':root');
  if (rootStart === -1) return '';
  const braceStart = css.indexOf('{', rootStart);
  if (braceStart === -1) return '';

  let depth = 1;
  let i = braceStart + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(braceStart, i);
}

/**
 * Extract the `[data-theme='light'] { ... }` block from CSS content.
 */
function extractLightThemeBlock(css: string): string {
  const lightStart = css.indexOf("[data-theme='light']");
  if (lightStart === -1) return '';
  const braceStart = css.indexOf('{', lightStart);
  if (braceStart === -1) return '';

  let depth = 1;
  let i = braceStart + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(braceStart, i);
}

/**
 * Extract the `@layer utilities { ... }` section from CSS content.
 */
function extractUtilitiesLayer(css: string): string {
  const layerStart = css.indexOf('@layer utilities');
  if (layerStart === -1) return '';
  const braceStart = css.indexOf('{', layerStart);
  if (braceStart === -1) return '';

  let depth = 1;
  let i = braceStart + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(braceStart, i);
}

// =============================================================================
// TESTS
// =============================================================================

describe('Gradient Design Token Integration', () => {
  // I-1: All --gradient-* CSS custom properties defined in :root
  describe('I-1: CSS custom properties in :root', () => {
    const rootBlock = extractRootBlock(GLOBALS_CSS);
    const rootVars = extractGradientVars(rootBlock);

    test('defines at least 14 gradient CSS custom properties', () => {
      expect(rootVars.length).toBeGreaterThanOrEqual(14);
    });

    test.each(EXPECTED_GRADIENT_TOKENS)('%s is defined in :root', (tokenName) => {
      expect(rootVars).toContain(tokenName);
    });
  });

  // I-2: All --gradient-* have [data-theme='light'] overrides
  describe("I-2: light theme parity ([data-theme='light'])", () => {
    const rootBlock = extractRootBlock(GLOBALS_CSS);
    const lightBlock = extractLightThemeBlock(GLOBALS_CSS);
    const rootVars = extractGradientVars(rootBlock);
    const lightVars = extractGradientVars(lightBlock);

    test('light theme defines the same count of gradient tokens as :root', () => {
      expect(lightVars.length).toBe(rootVars.length);
    });

    test('every :root gradient token has a light theme override', () => {
      for (const tokenName of rootVars) {
        expect(lightVars).toContain(tokenName);
      }
    });

    test('no extra gradient tokens in light theme without :root definition', () => {
      for (const tokenName of lightVars) {
        expect(rootVars).toContain(tokenName);
      }
    });
  });

  // I-3: CSS utility classes reference correct --gradient-* vars
  describe('I-3: utility classes reference correct vars', () => {
    const utilitiesBlock = extractUtilitiesLayer(GLOBALS_CSS);

    test('.bg-gradient-brand contains var(--gradient-brand)', () => {
      expect(utilitiesBlock).toMatch(/\.bg-gradient-brand\s*\{[^}]*var\(--gradient-brand\)/);
    });

    test('.text-gradient-brand contains var(--gradient-brand-text) and background-clip', () => {
      const textGradientMatch = utilitiesBlock.match(/\.text-gradient-brand\s*\{([^}]*)\}/);
      expect(textGradientMatch).not.toBeNull();
      const ruleBody = textGradientMatch![1];
      expect(ruleBody).toContain('var(--gradient-brand-text)');
      expect(ruleBody).toMatch(/background-clip:\s*text/);
    });

    test('.border-gradient-brand references var(--gradient-brand)', () => {
      // The border gradient uses a ::before pseudo-element
      expect(utilitiesBlock).toMatch(/\.border-gradient-brand/);
      expect(utilitiesBlock).toMatch(
        /\.border-gradient-brand[^{]*::before\s*\{[^}]*var\(--gradient-brand\)/s,
      );
    });

    test('.bg-gradient-surface-panel contains var(--gradient-surface-panel)', () => {
      expect(utilitiesBlock).toMatch(
        /\.bg-gradient-surface-panel\s*\{[^}]*var\(--gradient-surface-panel\)/,
      );
    });

    test('.bg-gradient-status-success contains var(--gradient-status-success)', () => {
      expect(utilitiesBlock).toMatch(
        /\.bg-gradient-status-success\s*\{[^}]*var\(--gradient-status-success\)/,
      );
    });

    test('.gradient-glow-accent references var(--gradient-glow-accent)', () => {
      expect(utilitiesBlock).toMatch(/\.gradient-glow-accent/);
      expect(utilitiesBlock).toContain('var(--gradient-glow-accent)');
    });
  });

  // I-4: No remaining hardcoded gradients in utility classes
  describe('I-4: zero hardcoded gradients in utility layer', () => {
    const utilitiesBlock = extractUtilitiesLayer(GLOBALS_CSS);

    test('no hardcoded linear-gradient() in utility class bodies', () => {
      // Find all property declarations that contain literal gradient values
      // (not inside a var() call or a comment)
      // Match lines with linear-gradient( or radial-gradient( that are NOT
      // inside the :root or [data-theme] blocks (which are token definitions)
      const lines = utilitiesBlock.split('\n');
      const hardcodedLines = lines.filter((line) => {
        const trimmed = line.trim();
        // Skip comments
        if (trimmed.startsWith('/*') || trimmed.startsWith('*')) return false;
        // Skip empty/selector lines
        if (!trimmed.includes('gradient(')) return false;
        // Allow var(--gradient-*) references
        if (trimmed.match(/var\(--gradient-/)) return false;
        // Allow mask-composite technique: linear-gradient(#fff 0 0) is structural, not decorative
        if (trimmed.match(/linear-gradient\(#fff\s/)) return false;
        // This line has a hardcoded gradient
        return true;
      });

      expect(hardcodedLines).toEqual([]);
    });
  });

  // I-5: No remaining inline bg-gradient-to-* in Studio components
  describe('I-5: zero inline Tailwind gradients in components', () => {
    test('no bg-gradient-to-* with from-* in component or app files', () => {
      const dirsToCheck = [
        path.resolve(import.meta.dirname, '../components'),
        path.resolve(import.meta.dirname, '../app'),
      ];

      const violations: string[] = [];

      function scanDir(dir: string) {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (
            entry.isFile() &&
            /\.(tsx?|jsx?)$/.test(entry.name) &&
            !entry.name.includes('.test.') &&
            !entry.name.includes('.spec.') &&
            !entry.name.includes('globals.css')
          ) {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              if (line.includes('bg-gradient-to-') && line.includes('from-')) {
                violations.push(`${path.relative(import.meta.dirname, fullPath)}:${i + 1}`);
              }
            }
          }
        }
      }

      for (const dir of dirsToCheck) {
        scanDir(dir);
      }

      expect(violations).toEqual([]);
    });
  });

  // I-6: Design-tokens package exports all gradient API functions
  describe('I-6: design-tokens barrel exports', () => {
    test('exports getGradientStyles function', async () => {
      const tokens = await import('@agent-platform/design-tokens');
      expect(typeof tokens.getGradientStyles).toBe('function');
    });

    test('exports getGradientValue function', async () => {
      const tokens = await import('@agent-platform/design-tokens');
      expect(typeof tokens.getGradientValue).toBe('function');
    });

    test('exports GRADIENT_TOKENS constant', async () => {
      const tokens = await import('@agent-platform/design-tokens');
      expect(tokens.GRADIENT_TOKENS).toBeDefined();
      expect(typeof tokens.GRADIENT_TOKENS).toBe('object');
      expect(Object.keys(tokens.GRADIENT_TOKENS).length).toBeGreaterThanOrEqual(14);
    });
  });

  // I-7: prefers-reduced-motion media query gates animated gradients
  describe('I-7: prefers-reduced-motion gates skeleton animation', () => {
    test('globals.css contains prefers-reduced-motion media query', () => {
      expect(GLOBALS_CSS).toContain('prefers-reduced-motion');
    });

    test('reduced-motion block disables .skeleton animation', () => {
      // Find the reduced-motion block near .skeleton
      const reducedMotionMatch = GLOBALS_CSS.match(
        /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([^}]*\.skeleton[^}]*)\}/s,
      );
      expect(reducedMotionMatch).not.toBeNull();
      const blockContent = reducedMotionMatch![1];
      expect(blockContent).toMatch(/animation:\s*none/);
    });
  });
});
