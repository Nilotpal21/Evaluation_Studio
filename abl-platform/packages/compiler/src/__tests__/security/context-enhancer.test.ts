/**
 * UT-5: context-word boost helper.
 */

import { describe, test, expect } from 'vitest';
import { applyContextBoost } from '../../platform/security/context-enhancer.js';

describe('applyContextBoost', () => {
  test('returns baseConfidence with no contextWords', () => {
    expect(applyContextBoost('foo bar', 4, 7, { baseConfidence: 0.6 })).toBe(0.6);
  });

  test('returns 1.0 default when no config', () => {
    expect(applyContextBoost('foo bar', 4, 7)).toBe(1.0);
  });

  test('boosts when context word appears before match', () => {
    const out = applyContextBoost('My passport is X1234567', 15, 23, {
      contextWords: ['passport'],
      baseConfidence: 0.5,
      contextBoost: 0.3,
    });
    expect(out).toBeCloseTo(0.8);
  });

  test('boosts when context word appears after match', () => {
    const out = applyContextBoost('X1234567 is my passport number', 0, 8, {
      contextWords: ['passport'],
      baseConfidence: 0.5,
      contextBoost: 0.3,
    });
    expect(out).toBeCloseTo(0.8);
  });

  test('does not boost when context word is outside window', () => {
    const filler = ' word'.repeat(40);
    const out = applyContextBoost(`passport${filler} X1234567`, `passport${filler} `.length, 100, {
      contextWords: ['passport'],
      baseConfidence: 0.5,
      contextBoost: 0.3,
      contextWindowTokens: 5,
    });
    expect(out).toBe(0.5);
  });

  test('case-insensitive matching', () => {
    const out = applyContextBoost('PASSPORT: X1234567', 10, 18, {
      contextWords: ['passport'],
      baseConfidence: 0.5,
      contextBoost: 0.3,
    });
    expect(out).toBeCloseTo(0.8);
  });

  test('caps confidence at 1.0', () => {
    const out = applyContextBoost('passport X1234567', 9, 17, {
      contextWords: ['passport'],
      baseConfidence: 0.9,
      contextBoost: 0.5,
    });
    expect(out).toBe(1.0);
  });

  test('matches single tokens only — does not match inflected forms', () => {
    // Documented limitation per LLD task 1a.6 — pack authors must
    // enumerate inflections explicitly.
    const out = applyContextBoost('My passports list X1234567', 18, 26, {
      contextWords: ['passport'], // singular only
      baseConfidence: 0.5,
      contextBoost: 0.3,
    });
    expect(out).toBe(0.5);
  });
});
