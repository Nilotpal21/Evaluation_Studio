/**
 * Context-word boost for regex-based PII recognizers (Presidio-inspired).
 *
 * Pure helper. Scans a small token window before AND after the match for
 * any of the recognizer's context words; if any are present, attenuates
 * the base confidence toward 1.0 by `contextBoost`. Otherwise returns
 * `baseConfidence` unchanged.
 *
 * Notes (LLD §1.3 task 1a.6):
 *  - Single tokens only — multi-word phrases like "date of birth" must be
 *    pre-split by the pack author (Presidio constraint).
 *  - Inflected forms (passport / passports) must be enumerated explicitly;
 *    we intentionally avoid pulling in a JS NLP runtime for stemming.
 */

import type { RegexPIIRecognizerConfig } from './pii-recognizer-registry.js';

const DEFAULT_CONTEXT_BOOST = 0.35;
const DEFAULT_BASE_CONFIDENCE = 1.0;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 12;

const TOKEN_RE = /[A-Za-z][A-Za-z0-9_-]*/g;

export function applyContextBoost(
  text: string,
  matchStart: number,
  matchEnd: number,
  config?: RegexPIIRecognizerConfig,
): number {
  const baseConfidence = config?.baseConfidence ?? DEFAULT_BASE_CONFIDENCE;
  const contextWords = config?.contextWords;
  if (!contextWords || contextWords.length === 0) return baseConfidence;

  const boost = config?.contextBoost ?? DEFAULT_CONTEXT_BOOST;
  const windowTokens = config?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;

  const lowercaseNeedles = contextWords.map((w) => w.toLowerCase());

  const before = text.slice(0, matchStart);
  const after = text.slice(matchEnd);

  if (windowContainsAny(before, lowercaseNeedles, windowTokens, /* fromEnd */ true)) {
    return clamp01(baseConfidence + boost);
  }
  if (windowContainsAny(after, lowercaseNeedles, windowTokens, /* fromEnd */ false)) {
    return clamp01(baseConfidence + boost);
  }
  return baseConfidence;
}

function windowContainsAny(
  segment: string,
  lowercaseNeedles: readonly string[],
  windowTokens: number,
  fromEnd: boolean,
): boolean {
  const re = new RegExp(TOKEN_RE.source, TOKEN_RE.flags);
  const tokens: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    tokens.push(m[0].toLowerCase());
    if (m[0].length === 0) re.lastIndex++;
  }
  const slice = fromEnd ? tokens.slice(-windowTokens) : tokens.slice(0, windowTokens);
  for (const tok of slice) {
    for (const needle of lowercaseNeedles) {
      if (tok === needle) return true;
    }
  }
  return false;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
