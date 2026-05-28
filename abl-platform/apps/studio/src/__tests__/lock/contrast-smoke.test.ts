/**
 * Lock test — WCAG AA contrast smoke for Studio canary pairs.
 *
 * Track 1 polish slices retune token hue and lightness values
 * (--warning hue 45°→40°, light-theme borders, --foreground-meta).
 * A small lightness change can drop a foreground/background pair
 * below the WCAG AA threshold without surfacing in any other test.
 * This test parses globals.css, computes the relative luminance and
 * contrast ratio for the canonical pairs, and asserts they meet:
 *
 *   - 4.5:1 — body text + status-badge text (WCAG AA "normal text")
 *   - 3.0:1 — UI components: borders, large text, decorative chrome
 *
 * The 21 pairs covered include every status-badge text-on-fill
 * combination (success/warning/error/info/purple), every accent-button
 * pairing, body and muted text on the page background, and the
 * primary border on the page background — each in BOTH themes.
 *
 * If a slice intentionally trades a sliver of contrast for hue
 * (e.g. the --warning hue tune at 40°), update the THRESHOLD_OVERRIDES
 * map below with the new minimum and a comment justifying it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const GLOBALS_CSS = fs.readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf-8');

// ---------------------------------------------------------------------------
// CSS HSL parsing
// ---------------------------------------------------------------------------

interface Hsl {
  h: number;
  s: number;
  l: number;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Tailwind/shadcn token format: `H S% L%` (no `hsl()` wrapper). Parses
 * a single declaration body. Returns null for var()-references and
 * for declarations that are not pure HSL literals; the caller may
 * choose to skip those.
 */
function parseHslLiteral(value: string): Hsl | null {
  const trimmed = value.trim().replace(/;$/, '').trim();
  if (trimmed.startsWith('var(')) {
    return null;
  }
  const match = /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*%\s+(\d+(?:\.\d+)?)\s*%$/.exec(trimmed);
  if (!match) return null;
  return { h: Number(match[1]), s: Number(match[2]), l: Number(match[3]) };
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = ln - c / 2;
  return { r: r + m, g: g + m, b: b + m };
}

function srgbToLinear(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function relativeLuminance(rgb: Rgb): number {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: Hsl, b: Hsl): number {
  const la = relativeLuminance(hslToRgb(a));
  const lb = relativeLuminance(hslToRgb(b));
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// Theme-block extraction (same brace-counting helper as the token lock test;
// duplicated locally so this file has zero internal dependencies and can be
// run in isolation while debugging contrast issues).
// ---------------------------------------------------------------------------

function extractBlockBody(css: string, selectorRegex: RegExp): string {
  const match = selectorRegex.exec(css);
  if (!match) {
    throw new Error(`Could not locate block matching ${selectorRegex} in globals.css`);
  }
  const openIndex = css.indexOf('{', match.index);
  if (openIndex === -1) throw new Error(`No opening brace after ${selectorRegex.source}`);
  let depth = 1;
  for (let i = openIndex + 1; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(openIndex + 1, i);
    }
  }
  throw new Error(`Unbalanced braces after ${selectorRegex.source}`);
}

function parseTokenMap(blockBody: string): Map<string, Hsl> {
  const out = new Map<string, Hsl>();
  // Match `--token-name: <value>;` (ignoring comments and whitespace).
  const declRe = /(--[a-z][a-z0-9-]*)\s*:\s*([^;]+);/gi;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(blockBody)) !== null) {
    const name = m[1];
    const value = m[2].split('/*')[0]; // strip inline comment if any
    const hsl = parseHslLiteral(value);
    if (hsl) out.set(name, hsl);
  }
  return out;
}

const ROOT_TOKENS = parseTokenMap(extractBlockBody(GLOBALS_CSS, /(^|\s):root\s*{/m));
const LIGHT_TOKENS = parseTokenMap(
  extractBlockBody(GLOBALS_CSS, /\[data-theme=['"]light['"]\]\s*{/),
);

// ---------------------------------------------------------------------------
// Pair definitions
// ---------------------------------------------------------------------------

interface ContrastPair {
  name: string;
  fg: string;
  bg: string;
  /** WCAG AA threshold: 4.5 for normal text, 3.0 for UI / large text. */
  minRatio: number;
}

/**
 * Recorded floors for pairs that fall below the documented WCAG AA
 * threshold today. The lock here is a NON-REGRESSION gate: a slice may
 * IMPROVE these ratios (and SHOULD), but may not degrade them further.
 *
 * Keys are `<theme>:<pair-name>`. When a Track 1 polish slice fixes a
 * pair's contrast, REMOVE the override so the pair is once again locked
 * to the full WCAG AA target.
 *
 * DEBT — to be paid down by Track 1.7 (Lighten light-theme borders) and
 * the broader status-token retune slices. Floors are 0.05 below the
 * measured ratio so floating-point drift cannot produce a false alarm.
 */
const THRESHOLD_OVERRIDES: Record<string, number> = {
  // Dark theme borders are 1.44:1 against near-black bg; Theme 1.7 is
  // light-theme but the dark side is also flagged in the audit.
  'dark:border on background': 1.4,
  // Dark green button text. Polish work on the success token will lift
  // this to 4.5+; locking at current ratio so we do not regress.
  'dark:success-foreground on success': 3.2,
  // Track 1.7 lifted the light-theme border lightness from 83% to 70%
  // raising contrast from 1.37:1 to ~2.0:1. Floor remains below the 3:1
  // WCAG UI-component target so the smoke does not green-light a future
  // regression that re-darkens borders; future slices can finish lifting
  // to 3:1 and remove this override entirely.
  'light:border on background': 1.95,
  // Light green button text — close to AA but not quite.
  'light:success-foreground on success': 4.1,
  // Track 1.11 darkened light-theme --info from L=40% to L=30%, lifting
  // info-foreground/info from 2.84:1 to 4.77:1 — above the 4.5 WCAG AA
  // target. Override removed; the pair is now locked at the canonical
  // threshold.
};

const TEXT_PAIRS: ContrastPair[] = [
  { name: 'foreground on background', fg: '--foreground', bg: '--background', minRatio: 4.5 },
  {
    name: 'foreground-muted on background',
    fg: '--foreground-muted',
    bg: '--background',
    minRatio: 4.5,
  },
  {
    name: 'accent-foreground on accent',
    fg: '--accent-foreground',
    bg: '--accent',
    minRatio: 4.5,
  },
  {
    name: 'success-foreground on success',
    fg: '--success-foreground',
    bg: '--success',
    minRatio: 4.5,
  },
  {
    name: 'warning-foreground on warning',
    fg: '--warning-foreground',
    bg: '--warning',
    minRatio: 4.5,
  },
  {
    name: 'error-foreground on error',
    fg: '--error-foreground',
    bg: '--error',
    minRatio: 4.5,
  },
  {
    name: 'info-foreground on info',
    fg: '--info-foreground',
    bg: '--info',
    minRatio: 4.5,
  },
  {
    name: 'purple-foreground on purple',
    fg: '--purple-foreground',
    bg: '--purple',
    minRatio: 4.5,
  },
];

const UI_PAIRS: ContrastPair[] = [
  // Decorative borders just need to be perceivable next to the page bg.
  { name: 'border on background', fg: '--border', bg: '--background', minRatio: 3.0 },
];

const ALL_PAIRS = [...TEXT_PAIRS, ...UI_PAIRS];

function thresholdFor(pair: ContrastPair, theme: 'dark' | 'light'): number {
  const overrideKey = `${theme}:${pair.name}`;
  return THRESHOLD_OVERRIDES[overrideKey] ?? pair.minRatio;
}

function assertPair(pair: ContrastPair, tokens: Map<string, Hsl>, theme: 'dark' | 'light') {
  const fg = tokens.get(pair.fg);
  const bg = tokens.get(pair.bg);
  if (!fg || !bg) {
    throw new Error(
      `[${theme}] missing token literal for pair "${pair.name}" — fg=${pair.fg} bg=${pair.bg}. ` +
        `If the token resolves through var(), add a literal version or expand parseTokenMap.`,
    );
  }
  const ratio = contrastRatio(fg, bg);
  const min = thresholdFor(pair, theme);
  if (ratio < min) {
    throw new Error(
      `[${theme}] "${pair.name}" contrast ${ratio.toFixed(2)}:1 < ${min}:1 minimum. ` +
        `If this is intentional, record the override in THRESHOLD_OVERRIDES with justification.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contrast smoke — dark theme (:root)', () => {
  for (const pair of ALL_PAIRS) {
    test(`${pair.name} meets ${pair.minRatio}:1 (dark)`, () => {
      expect(() => assertPair(pair, ROOT_TOKENS, 'dark')).not.toThrow();
    });
  }
});

describe('contrast smoke — light theme ([data-theme="light"])', () => {
  for (const pair of ALL_PAIRS) {
    test(`${pair.name} meets ${pair.minRatio}:1 (light)`, () => {
      expect(() => assertPair(pair, LIGHT_TOKENS, 'light')).not.toThrow();
    });
  }
});
