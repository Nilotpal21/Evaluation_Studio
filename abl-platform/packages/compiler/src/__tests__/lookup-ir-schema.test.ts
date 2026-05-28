/**
 * Type-level tests for LookupTableIR schema.
 * Verifies the new type structure compiles correctly with all source variants.
 */
import { describe, it, expect } from 'vitest';
import type { LookupTableIR } from '../platform/ir/schema.js';

describe('LookupTableIR type structure', () => {
  it('accepts inline source with values and normalized_values', () => {
    const table: LookupTableIR = {
      name: 'iata_codes',
      source: 'inline',
      values: ['LAX', 'JFK', 'CDG'],
      normalized_values: ['lax', 'jfk', 'cdg'],
      case_sensitive: false,
      fuzzy_match: false,
      fuzzy_threshold: 0.85,
    };
    expect(table.source).toBe('inline');
    expect(table.values).toHaveLength(3);
    expect(table.normalized_values).toHaveLength(3);
  });

  it('accepts collection source with table_name', () => {
    const table: LookupTableIR = {
      name: 'hotels',
      source: 'collection',
      table_name: 'lookup_hotels',
      field: 'name',
      case_sensitive: false,
      fuzzy_match: true,
      fuzzy_threshold: 0.85,
    };
    expect(table.source).toBe('collection');
    expect(table.table_name).toBe('lookup_hotels');
  });

  it('accepts api source with endpoint and timeout_ms', () => {
    const table: LookupTableIR = {
      name: 'products',
      source: 'api',
      endpoint: 'https://api.example.com/lookup',
      field: 'sku',
      timeout_ms: 3000,
      case_sensitive: false,
      fuzzy_match: false,
      fuzzy_threshold: 0.85,
    };
    expect(table.source).toBe('api');
    expect(table.endpoint).toBe('https://api.example.com/lookup');
    expect(table.timeout_ms).toBe(3000);
  });

  it('does not require optional fields', () => {
    const table: LookupTableIR = {
      name: 'minimal',
      source: 'inline',
      case_sensitive: false,
      fuzzy_match: false,
      fuzzy_threshold: 0.85,
    };
    expect(table.values).toBeUndefined();
    expect(table.normalized_values).toBeUndefined();
    expect(table.table_name).toBeUndefined();
    expect(table.endpoint).toBeUndefined();
    expect(table.field).toBeUndefined();
    expect(table.timeout_ms).toBeUndefined();
  });
});
