import { describe, it, expect } from 'vitest';
import { buildSemanticHint } from '../../platform/constructs/semantic-hints.js';

describe('buildSemanticHint', () => {
  it('generates conversion hint', () => {
    const hint = buildSemanticHint({
      semantics: { unit: 'fahrenheit', convert_to: 'celsius' },
    });
    expect(hint).toContain('convert to: celsius');
  });

  it('generates lookup hint', () => {
    const hint = buildSemanticHint({
      semantics: { lookup: 'iata_codes' },
    });
    expect(hint).toContain('valid values from: iata_codes');
  });

  it('generates combined hints', () => {
    const hint = buildSemanticHint({
      semantics: { format: 'airport_code', lookup: 'iata_codes' },
      list: true,
    });
    expect(hint).toContain('IATA airport code');
    expect(hint).toContain('valid values from: iata_codes');
    expect(hint).toContain('array of values');
  });

  it('handles empty semantics', () => {
    const hint = buildSemanticHint({});
    expect(hint).toBe('');
  });

  it('handles existing format hints', () => {
    const hint = buildSemanticHint({
      semantics: { format: 'date' },
    });
    expect(hint).toContain('ISO 8601 date');
  });

  it('handles unit without conversion', () => {
    const hint = buildSemanticHint({
      semantics: { unit: 'celsius' },
    });
    expect(hint).toContain('unit: celsius');
    expect(hint).not.toContain('convert to');
  });

  it('generates convert_to hint without unit', () => {
    const hint = buildSemanticHint({
      semantics: { convert_to: 'metric' },
    });
    expect(hint).toContain('convert to: metric');
  });

  it('generates unit + convert_to together', () => {
    const hint = buildSemanticHint({
      semantics: { unit: 'miles', convert_to: 'kilometers' },
    });
    expect(hint).toContain('unit: miles');
    expect(hint).toContain('convert to: kilometers');
  });

  it('generates lookup + format together', () => {
    const hint = buildSemanticHint({
      semantics: { format: 'currency', lookup: 'currency_codes' },
    });
    expect(hint).toContain('currency');
    expect(hint).toContain('valid values from: currency_codes');
  });

  it('handles range extraction', () => {
    const hint = buildSemanticHint({ range: true });
    expect(hint).toContain('range');
    expect(hint).toContain('low');
    expect(hint).toContain('high');
  });

  it('handles list extraction', () => {
    const hint = buildSemanticHint({ list: true });
    expect(hint).toContain('array of values');
  });

  it('handles preferences categorization', () => {
    const hint = buildSemanticHint({ preferences: true });
    expect(hint).toContain('accept');
    expect(hint).toContain('desire');
    expect(hint).toContain('avoid');
    expect(hint).toContain('refuse');
  });

  it('combines all hint types', () => {
    const hint = buildSemanticHint({
      semantics: { format: 'airport_code', lookup: 'iata_codes' },
      list: true,
      preferences: true,
    });
    expect(hint).toContain('IATA airport code');
    expect(hint).toContain('valid values from: iata_codes');
    expect(hint).toContain('array of values');
    expect(hint).toContain('accept');
  });
});
