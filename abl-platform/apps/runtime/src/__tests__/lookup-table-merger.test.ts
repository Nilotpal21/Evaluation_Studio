// apps/runtime/src/__tests__/lookup-table-merger.test.ts
import { describe, test, expect } from 'vitest';
import {
  mergeLookupTables,
  LookupTableConflictError,
} from '../services/execution/lookup-table-merger.js';
import type { LookupTableIR, ProjectRuntimeConfigIR } from '@abl/compiler/platform/ir/schema.js';

function makeTable(
  name: string,
  source: 'inline' | 'collection' | 'api' = 'inline',
): LookupTableIR {
  return { name, source, case_sensitive: false, fuzzy_match: false, fuzzy_threshold: 0.85 };
}

function makeProjectConfig(tables: LookupTableIR[]): ProjectRuntimeConfigIR {
  return {
    extraction_strategy: 'auto',
    nlu_provider: 'built_in',
    multi_intent: {
      enabled: false,
      strategy: 'primary_queue',
      max_intents: 3,
      confidence_threshold: 0.6,
      queue_max_age_ms: 600_000,
    },
    inference: { confidence: 0.8, confirm: true, model_tier: 'fast', max_fields_per_pass: 3 },
    conversion: { currency_mode: 'static' },
    lookup_tables: tables,
  } as ProjectRuntimeConfigIR;
}

describe('mergeLookupTables', () => {
  test('returns empty record when both inputs are undefined', () => {
    expect(mergeLookupTables(undefined, undefined)).toEqual({});
  });

  test('returns agent tables when project config is undefined', () => {
    const agent = { cities: makeTable('cities') };
    const result = mergeLookupTables(agent, undefined);
    expect(Object.keys(result)).toEqual(['cities']);
    expect(result.cities.name).toBe('cities');
  });

  test('returns project tables when agent tables are undefined', () => {
    const project = makeProjectConfig([makeTable('countries')]);
    const result = mergeLookupTables(undefined, project);
    expect(Object.keys(result)).toEqual(['countries']);
  });

  test('merges agent and project tables with no conflict', () => {
    const agent = { cities: makeTable('cities') };
    const project = makeProjectConfig([makeTable('countries')]);
    const result = mergeLookupTables(agent, project);
    expect(Object.keys(result).sort()).toEqual(['cities', 'countries']);
  });

  test('throws LookupTableConflictError on name collision', () => {
    const agent = { cities: makeTable('cities') };
    const project = makeProjectConfig([makeTable('cities', 'collection')]);
    expect(() => mergeLookupTables(agent, project)).toThrow(LookupTableConflictError);
    expect(() => mergeLookupTables(agent, project)).toThrow(/cities/);
  });

  test('handles empty project lookup_tables array', () => {
    const agent = { cities: makeTable('cities') };
    const project = makeProjectConfig([]);
    const result = mergeLookupTables(agent, project);
    expect(Object.keys(result)).toEqual(['cities']);
  });
});
