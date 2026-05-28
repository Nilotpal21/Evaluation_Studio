import { describe, test, expect } from 'vitest';
import { validateWithLookupTables } from '../services/execution/flow-step-executor.js';
import type { LookupTableIR } from '@abl/compiler/platform/ir/schema.js';

describe('Lookup fuzzy match confirmation', () => {
  const airportTable: LookupTableIR = {
    name: 'airports',
    source: 'inline',
    values: ['LAX', 'JFK', 'SFO', 'ORD'],
    case_sensitive: false,
    fuzzy_match: true,
    fuzzy_threshold: 0.6,
  };

  test('exact match does not produce fuzzy suggestion', async () => {
    const values: Record<string, unknown> = { airport: 'LAX' };
    const fields = [{ name: 'airport', semantics: { lookup: 'airports' } }];
    const { errors, fuzzyMatches } = await validateWithLookupTables(
      values,
      fields,
      { airports: airportTable },
      { tenantId: 'test-tenant', projectId: 'test-project' },
    );
    expect(Object.keys(errors)).toHaveLength(0);
    expect(Object.keys(fuzzyMatches)).toHaveLength(0);
    expect(values.airport).toBe('LAX');
  });

  test('case normalization does not produce fuzzy suggestion', async () => {
    const values: Record<string, unknown> = { airport: 'lax' };
    const fields = [{ name: 'airport', semantics: { lookup: 'airports' } }];
    const { errors, fuzzyMatches } = await validateWithLookupTables(
      values,
      fields,
      { airports: airportTable },
      { tenantId: 'test-tenant', projectId: 'test-project' },
    );
    expect(Object.keys(errors)).toHaveLength(0);
    expect(Object.keys(fuzzyMatches)).toHaveLength(0);
    // Case normalization auto-applied
    expect(values.airport).toBe('LAX');
  });

  test('fuzzy match returns suggestion instead of auto-normalizing', async () => {
    const values: Record<string, unknown> = { airport: 'LX' };
    const fields = [{ name: 'airport', semantics: { lookup: 'airports' } }];
    const { errors, fuzzyMatches } = await validateWithLookupTables(
      values,
      fields,
      { airports: airportTable },
      { tenantId: 'test-tenant', projectId: 'test-project' },
    );
    expect(Object.keys(errors)).toHaveLength(0);
    // Fuzzy match should be reported, not silently applied
    expect(fuzzyMatches).toHaveProperty('airport');
    expect(fuzzyMatches.airport.suggested).toBe('LAX');
    expect(fuzzyMatches.airport.similarity).toBeGreaterThan(0.6);
    // Original value should be preserved until confirmation
    expect(values.airport).toBe('LX');
  });

  test('no match returns error and no fuzzy suggestion', async () => {
    const values: Record<string, unknown> = { airport: 'ZZZZZ' };
    const fields = [{ name: 'airport', semantics: { lookup: 'airports' } }];
    const { errors, fuzzyMatches } = await validateWithLookupTables(
      values,
      fields,
      { airports: airportTable },
      { tenantId: 'test-tenant', projectId: 'test-project' },
    );
    expect(errors).toHaveProperty('airport');
    expect(Object.keys(fuzzyMatches)).toHaveLength(0);
  });

  test('non-fuzzy table does not produce fuzzy suggestions', async () => {
    const nonFuzzyTable: LookupTableIR = {
      ...airportTable,
      fuzzy_match: false,
    };
    const values: Record<string, unknown> = { airport: 'LX' };
    const fields = [{ name: 'airport', semantics: { lookup: 'airports' } }];
    const { errors, fuzzyMatches } = await validateWithLookupTables(
      values,
      fields,
      { airports: nonFuzzyTable },
      { tenantId: 'test-tenant', projectId: 'test-project' },
    );
    // Without fuzzy matching, 'LX' simply doesn't match
    expect(errors).toHaveProperty('airport');
    expect(Object.keys(fuzzyMatches)).toHaveLength(0);
  });
});
