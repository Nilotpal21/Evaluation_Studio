import { describe, test, expect } from 'vitest';
import { buildSemanticHint } from '../platform/constructs/semantic-hints.js';

describe('buildSemanticHint', () => {
  test('returns empty string when no semantic metadata', () => {
    expect(buildSemanticHint({})).toBe('');
  });

  test('address with components', () => {
    const hint = buildSemanticHint({
      semantics: { format: 'address', components: ['street', 'city', 'state', 'zip'] },
    });
    expect(hint).toContain('structured address');
    expect(hint).toContain('street, city, state, zip');
  });

  test('address without components', () => {
    const hint = buildSemanticHint({
      semantics: { format: 'address' },
    });
    expect(hint).toContain('structured address');
    expect(hint).not.toContain('components');
  });

  test('airport code format', () => {
    const hint = buildSemanticHint({
      semantics: { format: 'airport_code' },
    });
    expect(hint).toContain('IATA');
    expect(hint).toContain('LAX');
  });

  test('phone format', () => {
    const hint = buildSemanticHint({
      semantics: { format: 'phone' },
    });
    expect(hint).toContain('phone number');
    expect(hint).toContain('E.164');
  });

  test('email format', () => {
    const hint = buildSemanticHint({
      semantics: { format: 'email' },
    });
    expect(hint).toContain('valid email address');
  });

  test('date format', () => {
    const hint = buildSemanticHint({
      semantics: { format: 'date' },
    });
    expect(hint).toContain('ISO 8601 date');
    expect(hint).toContain('2024-03-15');
  });

  test('time format', () => {
    const hint = buildSemanticHint({
      semantics: { format: 'time' },
    });
    expect(hint).toContain('24h time');
    expect(hint).toContain('14:30');
  });

  test('datetime format', () => {
    const hint = buildSemanticHint({
      semantics: { format: 'datetime' },
    });
    expect(hint).toContain('ISO 8601 datetime');
  });

  test('custom format falls back to generic', () => {
    const hint = buildSemanticHint({
      semantics: { format: 'credit_card' },
    });
    expect(hint).toBe('(extract as credit_card)');
  });

  test('unit without format', () => {
    const hint = buildSemanticHint({
      semantics: { unit: 'kg' },
    });
    expect(hint).toContain('unit: kg');
    expect(hint).not.toContain('format:');
  });

  test('unit with format', () => {
    const hint = buildSemanticHint({
      semantics: { unit: 'currency', format: 'USD' },
    });
    expect(hint).toContain('currency');
    expect(hint).toContain('USD');
  });

  test('range flag', () => {
    const hint = buildSemanticHint({ range: true });
    expect(hint).toContain('range');
    expect(hint).toContain('low');
    expect(hint).toContain('high');
  });

  test('list flag', () => {
    const hint = buildSemanticHint({ list: true });
    expect(hint).toContain('array');
  });

  test('preferences flag', () => {
    const hint = buildSemanticHint({ preferences: true });
    expect(hint).toContain('accept');
    expect(hint).toContain('desire');
    expect(hint).toContain('avoid');
    expect(hint).toContain('refuse');
  });

  test('multiple flags combined', () => {
    const hint = buildSemanticHint({
      semantics: { format: 'airport_code' },
      list: true,
    });
    expect(hint).toContain('IATA');
    expect(hint).toContain('array');
  });

  test('all flags combined', () => {
    const hint = buildSemanticHint({
      semantics: { format: 'address', components: ['city', 'zip'] },
      range: true,
      list: true,
      preferences: true,
    });
    expect(hint).toContain('structured address');
    expect(hint).toContain('city, zip');
    expect(hint).toContain('range');
    expect(hint).toContain('array');
    expect(hint).toContain('accept');
  });

  test('range false does not add hint', () => {
    const hint = buildSemanticHint({ range: false });
    expect(hint).toBe('');
  });

  test('list false does not add hint', () => {
    const hint = buildSemanticHint({ list: false });
    expect(hint).toBe('');
  });

  test('preferences false does not add hint', () => {
    const hint = buildSemanticHint({ preferences: false });
    expect(hint).toBe('');
  });

  test('semantics with lookup produces validation hint', () => {
    const hint = buildSemanticHint({
      semantics: { lookup: 'airports_table', locale: 'en-US', kore_entity_type: 'LOC_AIRPORT' },
    });
    expect(hint).toBe('(valid values from: airports_table)');
  });
});
