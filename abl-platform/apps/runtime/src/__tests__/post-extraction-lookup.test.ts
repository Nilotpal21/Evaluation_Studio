import { describe, it, expect } from 'vitest';
import { resolveInlineLookup } from '../services/execution/lookup-resolver.js';
import { validateWithLookupTables } from '../services/execution/flow-step-executor.js';
import type { LookupTableIR } from '@abl/compiler/platform/ir/schema.js';

describe('validateWithLookupTables', () => {
  const airportTable: LookupTableIR = {
    name: 'iata_codes',
    source: 'inline' as const,
    values: ['LAX', 'JFK', 'CDG', 'LHR', 'NRT', 'SFO', 'ORD'],
    case_sensitive: false,
    fuzzy_match: false,
    fuzzy_threshold: 0.85,
  };

  it('accepts valid lookup value', async () => {
    const values: Record<string, unknown> = { airport: 'LAX' };
    const fields = [{ name: 'airport', semantics: { lookup: 'iata_codes' } }];
    const tables = { iata_codes: airportTable };
    const { errors } = await validateWithLookupTables(values, fields, tables, {
      tenantId: 'test-tenant',
      projectId: 'test-project',
    });
    expect(Object.keys(errors)).toHaveLength(0);
    expect(values.airport).toBe('LAX');
  });

  it('rejects invalid lookup value', async () => {
    const values: Record<string, unknown> = { airport: 'XYZ' };
    const fields = [{ name: 'airport', semantics: { lookup: 'iata_codes' } }];
    const tables = { iata_codes: airportTable };
    const { errors } = await validateWithLookupTables(values, fields, tables, {
      tenantId: 'test-tenant',
      projectId: 'test-project',
    });
    expect(errors.airport).toBeDefined();
    expect(errors.airport).toContain('XYZ');
    expect(errors.airport).toContain('airport');
  });

  it('normalizes case on match', async () => {
    const values: Record<string, unknown> = { airport: 'lax' };
    const fields = [{ name: 'airport', semantics: { lookup: 'iata_codes' } }];
    const tables = { iata_codes: airportTable };
    const { errors } = await validateWithLookupTables(values, fields, tables, {
      tenantId: 'test-tenant',
      projectId: 'test-project',
    });
    expect(Object.keys(errors)).toHaveLength(0);
    expect(values.airport).toBe('LAX');
  });

  it('skips fields without lookup semantics', async () => {
    const values: Record<string, unknown> = { city: 'Paris' };
    const fields = [{ name: 'city' }];
    const tables = { iata_codes: airportTable };
    const { errors } = await validateWithLookupTables(values, fields, tables, {
      tenantId: 'test-tenant',
      projectId: 'test-project',
    });
    expect(Object.keys(errors)).toHaveLength(0);
    expect(values.city).toBe('Paris');
  });

  it('skips null values', async () => {
    const values: Record<string, unknown> = { airport: null };
    const fields = [{ name: 'airport', semantics: { lookup: 'iata_codes' } }];
    const tables = { iata_codes: airportTable };
    const { errors } = await validateWithLookupTables(values, fields, tables, {
      tenantId: 'test-tenant',
      projectId: 'test-project',
    });
    expect(Object.keys(errors)).toHaveLength(0);
  });

  it('skips undefined values', async () => {
    const values: Record<string, unknown> = {};
    const fields = [{ name: 'airport', semantics: { lookup: 'iata_codes' } }];
    const tables = { iata_codes: airportTable };
    const { errors } = await validateWithLookupTables(values, fields, tables, {
      tenantId: 'test-tenant',
      projectId: 'test-project',
    });
    expect(Object.keys(errors)).toHaveLength(0);
  });

  it('handles missing lookup table gracefully', async () => {
    const values: Record<string, unknown> = { airport: 'LAX' };
    const fields = [{ name: 'airport', semantics: { lookup: 'nonexistent' } }];
    const tables = { iata_codes: airportTable };
    const { errors } = await validateWithLookupTables(values, fields, tables, {
      tenantId: 'test-tenant',
      projectId: 'test-project',
    });
    expect(Object.keys(errors)).toHaveLength(0);
  });

  it('handles undefined lookupTables gracefully', async () => {
    const values: Record<string, unknown> = { airport: 'LAX' };
    const fields = [{ name: 'airport', semantics: { lookup: 'iata_codes' } }];
    const { errors } = await validateWithLookupTables(values, fields, undefined, {
      tenantId: 'test-tenant',
      projectId: 'test-project',
    });
    expect(Object.keys(errors)).toHaveLength(0);
  });

  it('validates multiple fields at once', async () => {
    const values: Record<string, unknown> = { origin: 'LAX', destination: 'INVALID' };
    const fields = [
      { name: 'origin', semantics: { lookup: 'iata_codes' } },
      { name: 'destination', semantics: { lookup: 'iata_codes' } },
    ];
    const tables = { iata_codes: airportTable };
    const { errors } = await validateWithLookupTables(values, fields, tables, {
      tenantId: 'test-tenant',
      projectId: 'test-project',
    });
    expect(errors.origin).toBeUndefined();
    expect(errors.destination).toBeDefined();
    expect(values.origin).toBe('LAX');
  });
});

describe('resolveInlineLookup standalone', () => {
  const airportTable: LookupTableIR = {
    name: 'iata_codes',
    source: 'inline' as const,
    values: ['LAX', 'JFK', 'CDG', 'LHR', 'NRT', 'SFO', 'ORD'],
    case_sensitive: false,
    fuzzy_match: false,
    fuzzy_threshold: 0.85,
  };

  it('validates against lookup table', () => {
    const result = resolveInlineLookup('LAX', airportTable);
    expect(result.found).toBe(true);
    expect(result.matched_value).toBe('LAX');
  });

  it('rejects invalid value', () => {
    const result = resolveInlineLookup('XYZ', airportTable);
    expect(result.found).toBe(false);
  });

  it('case-insensitive match returns canonical value', () => {
    const result = resolveInlineLookup('jfk', airportTable);
    expect(result.found).toBe(true);
    expect(result.matched_value).toBe('JFK');
  });

  it('case-sensitive mode rejects wrong case', () => {
    const caseSensitiveTable: LookupTableIR = {
      ...airportTable,
      case_sensitive: true,
    };
    const result = resolveInlineLookup('lax', caseSensitiveTable);
    expect(result.found).toBe(false);
  });

  it('returns not found for empty values array', () => {
    const emptyTable: LookupTableIR = {
      ...airportTable,
      values: [],
    };
    const result = resolveInlineLookup('LAX', emptyTable);
    expect(result.found).toBe(false);
  });
});

describe('fuzzy lookup', () => {
  const cityTable: LookupTableIR = {
    name: 'cities',
    source: 'inline' as const,
    values: ['New York', 'Los Angeles', 'Chicago', 'Houston'],
    case_sensitive: false,
    fuzzy_match: true,
    fuzzy_threshold: 0.75,
  };

  it('fuzzy matches and normalizes value', () => {
    const result = resolveInlineLookup('New Yrok', cityTable);
    expect(result.found).toBe(true);
    expect(result.matched_value).toBe('New York');
    expect(result.similarity).toBeGreaterThanOrEqual(0.75);
  });

  it('rejects value below fuzzy threshold', () => {
    const result = resolveInlineLookup('XXXXXX', cityTable);
    expect(result.found).toBe(false);
  });

  it('prefers exact match over fuzzy match', () => {
    const result = resolveInlineLookup('Chicago', cityTable);
    expect(result.found).toBe(true);
    expect(result.matched_value).toBe('Chicago');
    // Exact match should not have a similarity score (it returns from the exact path)
  });
});
