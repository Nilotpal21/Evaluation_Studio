/**
 * Tests for the hand-ported validators in recognizer-packs/_validators.ts.
 * Test-first per LLD D-4.
 */

import { describe, test, expect } from 'vitest';
import {
  isIbanMod97,
  verhoeffCheck,
  deaCheck,
  btcBase58Shape,
  luhnCheck,
} from '../../platform/security/recognizer-packs/_validators.js';

describe('isIbanMod97', () => {
  test.each([
    ['GB82WEST12345698765432', true],
    ['DE89370400440532013000', true],
    ['FR1420041010050500013M02606', true],
    ['NL91ABNA0417164300', true],
    ['ES9121000418450200051332', true],
    // Bad checksums
    ['GB82WEST12345698765431', false],
    ['DE89370400440532013001', false],
    // Bad shape
    ['NOTANIBAN', false],
    ['', false],
  ])('isIbanMod97(%s) = %s', (input, expected) => {
    expect(isIbanMod97(input)).toBe(expected);
  });

  test('accepts spaces (canonical pretty-printed form)', () => {
    expect(isIbanMod97('GB82 WEST 1234 5698 7654 32')).toBe(true);
  });
});

describe('verhoeffCheck', () => {
  // Public test vectors from Verhoeff (1969).
  test.each([
    ['2363', true],
    ['12345', false],
    ['', false],
    ['notdigits', false],
  ])('verhoeffCheck(%s) = %s', (input, expected) => {
    expect(verhoeffCheck(input)).toBe(expected);
  });

  test('valid 12-digit Aadhaar-shaped numbers (Verhoeff-valid)', () => {
    // 234123412346 — Verhoeff-valid sample (last digit 6 is correct check digit)
    expect(verhoeffCheck('234123412346')).toBe(true);
    // Mutate last digit
    expect(verhoeffCheck('234123412345')).toBe(false);
  });
});

describe('deaCheck', () => {
  // DEA "AB1234567" is a documented sample where the last digit is the check.
  // Construct: digits = 123456, sum = (1+3+5) + 2*(2+4+6) = 9 + 24 = 33, last = 3.
  test('AB1234563 is valid (computed check digit 3)', () => {
    expect(deaCheck('AB1234563')).toBe(true);
  });
  test('AB1234567 is invalid', () => {
    expect(deaCheck('AB1234567')).toBe(false);
  });
  test('rejects bad shape', () => {
    expect(deaCheck('NOPE12345')).toBe(false);
    expect(deaCheck('')).toBe(false);
  });
});

describe('btcBase58Shape', () => {
  test('accepts known address shape', () => {
    expect(btcBase58Shape('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe(true);
  });
  test('rejects invalid characters (0, O, I, l)', () => {
    expect(btcBase58Shape('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN0')).toBe(false);
  });
  test('rejects too short / too long', () => {
    expect(btcBase58Shape('1abc')).toBe(false);
    expect(btcBase58Shape('1' + 'a'.repeat(40))).toBe(false);
  });
});

describe('luhnCheck (re-exported)', () => {
  test('accepts valid Visa test card', () => {
    expect(luhnCheck('4111111111111111')).toBe(true);
  });
  test('rejects invalid card', () => {
    expect(luhnCheck('4111111111111112')).toBe(false);
  });
});
