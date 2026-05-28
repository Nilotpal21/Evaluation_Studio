/**
 * Lock test — canary design tokens MUST be defined in BOTH the dark
 * (`:root`) and light (`[data-theme='light']`) blocks of globals.css.
 *
 * The Track 1 polish slices touch tokens — `--warning` hue, light-theme
 * borders, `--foreground-meta`, status tints. Without this lock, a
 * change that adds a token to one theme block (or removes it from one)
 * silently ships an asymmetric theme: dark works, light doesn't, or
 * vice versa. This test catches that drift before it lands.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const GLOBALS_CSS_PATH = path.resolve(__dirname, '../../app/globals.css');
const GLOBALS_CSS = fs.readFileSync(GLOBALS_CSS_PATH, 'utf-8');

/**
 * Tokens that are read by the eight canary surfaces and that the Track 1
 * polish slices are about to touch. If a slice intends to introduce a
 * NEW canary token, add it here at the same time — the test then
 * enforces that the new token is defined in BOTH themes.
 */
const CANARY_TOKENS = [
  // Background family
  '--background',
  '--background-subtle',
  '--background-muted',
  '--background-elevated',
  // Foreground family
  '--foreground',
  '--foreground-muted',
  '--foreground-meta',
  '--foreground-subtle',
  // Border family
  '--border',
  '--border-muted',
  '--border-focus',
  // Accent family (brand)
  '--accent',
  '--accent-foreground',
  '--accent-muted',
  '--accent-subtle',
  // Status families
  '--success',
  '--success-foreground',
  '--success-muted',
  '--success-subtle',
  '--warning',
  '--warning-foreground',
  '--warning-muted',
  '--warning-subtle',
  '--error',
  '--error-foreground',
  '--error-muted',
  '--error-subtle',
  '--info',
  '--info-foreground',
  '--info-muted',
  '--info-subtle',
  '--purple',
  '--purple-foreground',
  '--purple-muted',
  '--purple-subtle',
] as const;

/**
 * Extract the body of a CSS rule starting at the first match of
 * `selectorRegex`, by counting balanced braces from the opening `{`.
 * Returns the inner text of the block.
 *
 * Brace counting is required because `globals.css` puts the theme
 * blocks inside `@layer base { ... }`; a naive "closing brace" search
 * would terminate at the first `}` of a nested rule, not at the end of
 * the block.
 */
function extractBlockBody(css: string, selectorRegex: RegExp): string {
  const match = selectorRegex.exec(css);
  if (!match) {
    throw new Error(`Could not locate block matching ${selectorRegex} in globals.css`);
  }
  const openIndex = css.indexOf('{', match.index);
  if (openIndex === -1) {
    throw new Error(`Could not locate opening brace after ${selectorRegex.source}`);
  }
  let depth = 1;
  for (let i = openIndex + 1; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return css.slice(openIndex + 1, i);
      }
    }
  }
  throw new Error(`Unbalanced braces after ${selectorRegex.source}`);
}

const ROOT_BLOCK = extractBlockBody(GLOBALS_CSS, /(^|\s):root\s*{/m);
const LIGHT_BLOCK = extractBlockBody(GLOBALS_CSS, /\[data-theme=['"]light['"]\]\s*{/);

function tokenIsDeclared(blockBody: string, tokenName: string): boolean {
  // Must match a real declaration `--token: ...;`, not a `var(--token)` reference.
  const declarationPattern = new RegExp(`(^|[\\s;{])${tokenName.replace(/-/g, '\\-')}\\s*:`, 'm');
  return declarationPattern.test(blockBody);
}

describe('design tokens — canary lock', () => {
  test(':root (dark) block defines every canary token', () => {
    const missing = CANARY_TOKENS.filter((token) => !tokenIsDeclared(ROOT_BLOCK, token));
    expect(missing).toEqual([]);
  });

  test('[data-theme="light"] block defines every canary token', () => {
    const missing = CANARY_TOKENS.filter((token) => !tokenIsDeclared(LIGHT_BLOCK, token));
    expect(missing).toEqual([]);
  });

  test('every canary token is declared in BOTH themes (no asymmetric tokens)', () => {
    const asymmetric = CANARY_TOKENS.filter((token) => {
      const inRoot = tokenIsDeclared(ROOT_BLOCK, token);
      const inLight = tokenIsDeclared(LIGHT_BLOCK, token);
      return inRoot !== inLight;
    });
    expect(asymmetric).toEqual([]);
  });
});
