/**
 * Integration: LookupTableMerger boundary tests (INT-3)
 *
 * Tests the merger module's output shape as consumed by FlowStepExecutor's
 * buildExtractionTool (Record<string, LookupTableIR> with values arrays)
 * and validateWithLookupTables (keyed by table name from mixed sources).
 *
 * This is an integration test because it validates the contract between the
 * merger module and its downstream consumers in the executor — not the merger
 * in isolation.
 */

import { describe, it, expect } from 'vitest';
import {
  mergeLookupTables,
  LookupTableConflictError,
} from '../../services/execution/lookup-table-merger.js';
import type { LookupTableIR, ProjectRuntimeConfigIR } from '@abl/compiler/platform/ir/schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal ProjectRuntimeConfigIR with only lookup_tables populated */
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
    inference: {
      confidence: 0.8,
      confirm: true,
      model_tier: 'fast',
      max_fields_per_pass: 3,
    },
    conversion: { currency_mode: 'static' },
    lookup_tables: tables,
  } as ProjectRuntimeConfigIR;
}

function makeInlineTable(
  name: string,
  values: string[],
  overrides?: Partial<LookupTableIR>,
): LookupTableIR {
  return {
    name,
    source: 'inline',
    values,
    case_sensitive: false,
    fuzzy_match: false,
    fuzzy_threshold: 0.85,
    ...overrides,
  };
}

function makeCollectionTable(
  name: string,
  tableName: string,
  overrides?: Partial<LookupTableIR>,
): LookupTableIR {
  return {
    name,
    source: 'collection',
    table_name: tableName,
    case_sensitive: false,
    fuzzy_match: false,
    fuzzy_threshold: 0.85,
    ...overrides,
  };
}

function makeApiTable(
  name: string,
  endpoint: string,
  overrides?: Partial<LookupTableIR>,
): LookupTableIR {
  return {
    name,
    source: 'api',
    endpoint,
    case_sensitive: false,
    fuzzy_match: false,
    fuzzy_threshold: 0.85,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: Merged tables shape for buildExtractionTool
// ---------------------------------------------------------------------------

describe('INT-3a: Merged tables used by buildExtractionTool', () => {
  it('agent inline table has values array present for enum injection', () => {
    const agentTables: Record<string, LookupTableIR> = {
      priorities: makeInlineTable('priorities', ['low', 'medium', 'high', 'critical']),
    };

    const merged = mergeLookupTables(agentTables, undefined);

    // buildExtractionTool accesses merged[field.semantics.lookup].values
    // to inject as JSON Schema enum — values must be present
    expect(merged).toHaveProperty('priorities');
    expect(merged.priorities.values).toEqual(['low', 'medium', 'high', 'critical']);
    expect(merged.priorities.source).toBe('inline');
  });

  it('project-level table also available in merged record', () => {
    const agentTables: Record<string, LookupTableIR> = {
      priorities: makeInlineTable('priorities', ['low', 'medium', 'high']),
    };
    const projectConfig = makeProjectConfig([makeInlineTable('regions', ['US', 'EU', 'APAC'])]);

    const merged = mergeLookupTables(agentTables, projectConfig);

    // Both sources should be in the merged record, keyed by name
    expect(Object.keys(merged)).toHaveLength(2);
    expect(merged.priorities.values).toEqual(['low', 'medium', 'high']);
    expect(merged.regions.values).toEqual(['US', 'EU', 'APAC']);
  });

  it('throws LookupTableConflictError when agent and project define same table name', () => {
    const agentTables: Record<string, LookupTableIR> = {
      statuses: makeInlineTable('statuses', ['open', 'closed']),
    };
    const projectConfig = makeProjectConfig([makeInlineTable('statuses', ['active', 'inactive'])]);

    expect(() => mergeLookupTables(agentTables, projectConfig)).toThrow(LookupTableConflictError);
    expect(() => mergeLookupTables(agentTables, projectConfig)).toThrow(
      /statuses.*defined in both/,
    );
  });
});

// ---------------------------------------------------------------------------
// Test 2: Merged tables shape for validateWithLookupTables
// ---------------------------------------------------------------------------

describe('INT-3b: Merged tables shape matches validateWithLookupTables expectations', () => {
  it('project-level tables (LookupTableIR[]) get correctly keyed by name in merged record', () => {
    const projectConfig = makeProjectConfig([
      makeInlineTable('countries', ['US', 'UK', 'DE']),
      makeCollectionTable('airports', 'airport_codes'),
      makeApiTable('products', 'https://api.example.com/products'),
    ]);

    const merged = mergeLookupTables(undefined, projectConfig);

    // validateWithLookupTables does: lookupTables[field.semantics.lookup]
    // Each table must be keyed by its name property
    expect(merged.countries).toBeDefined();
    expect(merged.countries.name).toBe('countries');
    expect(merged.countries.source).toBe('inline');
    expect(merged.countries.values).toEqual(['US', 'UK', 'DE']);

    expect(merged.airports).toBeDefined();
    expect(merged.airports.name).toBe('airports');
    expect(merged.airports.source).toBe('collection');
    expect(merged.airports.table_name).toBe('airport_codes');

    expect(merged.products).toBeDefined();
    expect(merged.products.name).toBe('products');
    expect(merged.products.source).toBe('api');
    expect(merged.products.endpoint).toBe('https://api.example.com/products');
  });

  it('merged record preserves all LookupTableIR properties needed by resolveLookup', () => {
    const agentTables: Record<string, LookupTableIR> = {
      cities: makeInlineTable('cities', ['New York', 'London', 'Tokyo'], {
        case_sensitive: true,
        fuzzy_match: true,
        fuzzy_threshold: 0.9,
        normalized_values: ['new york', 'london', 'tokyo'],
      }),
    };

    const merged = mergeLookupTables(agentTables, undefined);

    // resolveLookup reads case_sensitive, fuzzy_match, fuzzy_threshold,
    // normalized_values — all must be preserved through merge
    const table = merged.cities;
    expect(table.case_sensitive).toBe(true);
    expect(table.fuzzy_match).toBe(true);
    expect(table.fuzzy_threshold).toBe(0.9);
    expect(table.normalized_values).toEqual(['new york', 'london', 'tokyo']);
    expect(table.values).toEqual(['New York', 'London', 'Tokyo']);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Multiple project + agent tables merge correctly
// ---------------------------------------------------------------------------

describe('INT-3c: Multiple project tables + agent tables merge correctly', () => {
  it('2 agent tables and 3 project tables yield 5 entries keyed by name', () => {
    const agentTables: Record<string, LookupTableIR> = {
      severity: makeInlineTable('severity', ['low', 'medium', 'high']),
      categories: makeCollectionTable('categories', 'ticket_categories'),
    };

    const projectConfig = makeProjectConfig([
      makeInlineTable('regions', ['NA', 'EMEA', 'APAC']),
      makeApiTable('products', 'https://api.example.com/products', {
        headers: { Authorization: 'Bearer xyz' },
        timeout_ms: 3000,
      }),
      makeInlineTable('languages', ['en', 'es', 'fr', 'de', 'ja']),
    ]);

    const merged = mergeLookupTables(agentTables, projectConfig);

    // All 5 tables should be present
    expect(Object.keys(merged)).toHaveLength(5);
    expect(Object.keys(merged).sort()).toEqual([
      'categories',
      'languages',
      'products',
      'regions',
      'severity',
    ]);

    // Verify agent tables retained their properties
    expect(merged.severity.source).toBe('inline');
    expect(merged.severity.values).toEqual(['low', 'medium', 'high']);
    expect(merged.categories.source).toBe('collection');
    expect(merged.categories.table_name).toBe('ticket_categories');

    // Verify project tables retained their properties
    expect(merged.regions.source).toBe('inline');
    expect(merged.regions.values).toEqual(['NA', 'EMEA', 'APAC']);
    expect(merged.products.source).toBe('api');
    expect(merged.products.headers).toEqual({ Authorization: 'Bearer xyz' });
    expect(merged.products.timeout_ms).toBe(3000);
    expect(merged.languages.values).toEqual(['en', 'es', 'fr', 'de', 'ja']);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Empty/undefined edge cases in integration context
// ---------------------------------------------------------------------------

describe('INT-3d: Empty/undefined edge cases in integration context', () => {
  it('agent has tables but project config is undefined (first session before config loaded)', () => {
    const agentTables: Record<string, LookupTableIR> = {
      statuses: makeInlineTable('statuses', ['pending', 'approved', 'rejected']),
    };

    const merged = mergeLookupTables(agentTables, undefined);

    expect(Object.keys(merged)).toHaveLength(1);
    expect(merged.statuses.values).toEqual(['pending', 'approved', 'rejected']);
  });

  it('agent has no tables, project has tables (pure project-level lookup)', () => {
    const projectConfig = makeProjectConfig([
      makeInlineTable('departments', ['engineering', 'sales', 'support']),
      makeCollectionTable('employees', 'employee_directory'),
    ]);

    const merged = mergeLookupTables(undefined, projectConfig);

    expect(Object.keys(merged)).toHaveLength(2);
    expect(merged.departments.values).toEqual(['engineering', 'sales', 'support']);
    expect(merged.employees.source).toBe('collection');
  });

  it('both agent and project are undefined — returns empty record', () => {
    const merged = mergeLookupTables(undefined, undefined);

    expect(merged).toEqual({});
    expect(Object.keys(merged)).toHaveLength(0);
  });

  it('agent has empty record and project has empty lookup_tables array', () => {
    const merged = mergeLookupTables({}, makeProjectConfig([]));

    expect(merged).toEqual({});
  });

  it('project config exists but has no lookup_tables property', () => {
    // Simulates a project config loaded from an older schema without lookup_tables
    const configWithoutLookup = {
      extraction_strategy: 'auto',
      nlu_provider: 'built_in',
      multi_intent: {
        enabled: false,
        strategy: 'primary_queue',
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 600_000,
      },
      inference: {
        confidence: 0.8,
        confirm: true,
        model_tier: 'fast',
        max_fields_per_pass: 3,
      },
      conversion: { currency_mode: 'static' },
    } as ProjectRuntimeConfigIR;

    const agentTables: Record<string, LookupTableIR> = {
      colors: makeInlineTable('colors', ['red', 'green', 'blue']),
    };

    const merged = mergeLookupTables(agentTables, configWithoutLookup);

    // Agent tables should still be present; missing project tables are ignored
    expect(Object.keys(merged)).toHaveLength(1);
    expect(merged.colors.values).toEqual(['red', 'green', 'blue']);
  });
});
