/**
 * E2E-8/9/10: Lookup table merger + enum coexistence — full pipeline tests
 *
 * Full pipeline: DSL text -> parseAgentBasedABL -> compileABLtoIR -> IR
 *   -> mergeLookupTables -> merged result assertions
 *
 * Real components (ALL pure, no mocks):
 * - parseAgentBasedABL (@abl/core)
 * - compileABLtoIR (@abl/compiler)
 * - mergeLookupTables (apps/runtime — pure function, no side effects)
 *
 * No LLM, no server, no database required.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';
import type {
  CompilationOutput,
  GatherField,
  LookupTableIR,
} from '@abl/compiler/platform/ir/schema.js';
import type { ProjectRuntimeConfigIR } from '@abl/compiler/platform/ir/schema.js';
import {
  mergeLookupTables,
  LookupTableConflictError,
} from '../../services/execution/lookup-table-merger.js';

// ---------------------------------------------------------------------------
// Helpers (same pattern as packages/compiler e2e tests)
// ---------------------------------------------------------------------------

function compileDSL(dsl: string): CompilationOutput {
  const parseResult = parseAgentBasedABL(dsl);
  if (parseResult.errors.length > 0) {
    throw new Error(`Parse errors: ${parseResult.errors.map((e) => e.message).join('; ')}`);
  }
  expect(parseResult.document).not.toBeNull();
  const output = compileABLtoIR([parseResult.document!]);
  expect(output.compilation_errors ?? []).toHaveLength(0);
  return output;
}

function getGatherField(
  output: CompilationOutput,
  agentName: string,
  fieldName: string,
): GatherField {
  const agent = output.agents[agentName];
  expect(agent).toBeDefined();
  const field = agent.gather.fields.find((f: GatherField) => f.name === fieldName);
  expect(field).toBeDefined();
  return field!;
}

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

// ---------------------------------------------------------------------------
// Shared DSL fixture
// ---------------------------------------------------------------------------

const VEHICLE_DSL = `
AGENT: VehicleBot
GOAL: "Help users find vehicles"
LOOKUP_TABLES:
  car_makes:
    source: inline
    values: Toyota, Honda, Ford, BMW
    fuzzy_match: true
    fuzzy_threshold: 0.8
GATHER:
  make:
    PROMPT: "What car make?"
    TYPE: string
    REQUIRED: true
    SEMANTICS:
      LOOKUP: car_makes
  service_type:
    PROMPT: "What service do you need?"
    TYPE: enum
    OPTIONS: [oil_change, tire_rotation, brake_inspection]
    REQUIRED: true
  customer_name:
    PROMPT: "Your name?"
    TYPE: string
    REQUIRED: true
`;

// ---------------------------------------------------------------------------
// E2E-8: Lookup table values flow from DSL through merger to extraction tool
// ---------------------------------------------------------------------------

describe('E2E-8: Lookup table values flow from DSL through merger', () => {
  test('compiled agent IR contains lookup_tables with values array', () => {
    const output = compileDSL(VEHICLE_DSL);
    const agent = output.agents['VehicleBot'];

    expect(agent.lookup_tables).toBeDefined();
    expect(agent.lookup_tables!['car_makes']).toBeDefined();

    const table = agent.lookup_tables!['car_makes'];
    expect(table.source).toBe('inline');
    expect(table.values).toEqual(['Toyota', 'Honda', 'Ford', 'BMW']);
    expect(table.fuzzy_match).toBe(true);
    expect(table.fuzzy_threshold).toBe(0.8);
  });

  test('gather field semantics.lookup references the lookup table', () => {
    const output = compileDSL(VEHICLE_DSL);
    const makeField = getGatherField(output, 'VehicleBot', 'make');

    expect(makeField.semantics).toBeDefined();
    expect(makeField.semantics!.lookup).toBe('car_makes');
  });

  test('mergeLookupTables with agent tables and empty project config preserves values', () => {
    const output = compileDSL(VEHICLE_DSL);
    const agentTables = output.agents['VehicleBot'].lookup_tables;

    // Merge with empty project config (no project-level tables)
    const merged = mergeLookupTables(agentTables, makeProjectConfig([]));

    expect(Object.keys(merged)).toHaveLength(1);
    expect(merged['car_makes']).toBeDefined();
    expect(merged['car_makes'].values).toEqual(['Toyota', 'Honda', 'Ford', 'BMW']);
    expect(merged['car_makes'].source).toBe('inline');
    expect(merged['car_makes'].fuzzy_match).toBe(true);
    expect(merged['car_makes'].fuzzy_threshold).toBe(0.8);
  });

  test('mergeLookupTables with agent tables and undefined project config works', () => {
    const output = compileDSL(VEHICLE_DSL);
    const agentTables = output.agents['VehicleBot'].lookup_tables;

    const merged = mergeLookupTables(agentTables, undefined);

    expect(Object.keys(merged)).toHaveLength(1);
    expect(merged['car_makes'].values).toEqual(['Toyota', 'Honda', 'Ford', 'BMW']);
  });

  test('merged result includes both agent-level and project-level tables', () => {
    const output = compileDSL(VEHICLE_DSL);
    const agentTables = output.agents['VehicleBot'].lookup_tables;

    // Create a project config with a different table
    const projectTable: LookupTableIR = {
      name: 'service_locations',
      source: 'inline',
      values: ['Downtown', 'Airport', 'Suburbs'],
      case_sensitive: false,
      fuzzy_match: false,
      fuzzy_threshold: 0.85,
    };
    const projectConfig = makeProjectConfig([projectTable]);

    const merged = mergeLookupTables(agentTables, projectConfig);

    expect(Object.keys(merged)).toHaveLength(2);
    expect(merged['car_makes'].values).toEqual(['Toyota', 'Honda', 'Ford', 'BMW']);
    expect(merged['service_locations'].values).toEqual(['Downtown', 'Airport', 'Suburbs']);
  });
});

// ---------------------------------------------------------------------------
// E2E-9: Enum + lookup coexistence in same agent
// ---------------------------------------------------------------------------

describe('E2E-9: Enum + lookup coexistence in same agent', () => {
  test('enum field has validation and enum_values, lookup field has semantics.lookup', () => {
    const output = compileDSL(VEHICLE_DSL);

    // Enum field: service_type
    const serviceField = getGatherField(output, 'VehicleBot', 'service_type');
    expect(serviceField.validation).toBeDefined();
    expect(serviceField.validation!.type).toBe('enum');
    expect(serviceField.validation!.rule).toBe('oil_change|tire_rotation|brake_inspection');
    expect(serviceField.enum_values).toEqual(['oil_change', 'tire_rotation', 'brake_inspection']);

    // Lookup field: make
    const makeField = getGatherField(output, 'VehicleBot', 'make');
    expect(makeField.semantics).toBeDefined();
    expect(makeField.semantics!.lookup).toBe('car_makes');
    // Lookup field should NOT have enum validation — it uses lookup, not enum
    expect(makeField.validation).toBeUndefined();
    expect(makeField.enum_values).toBeUndefined();
  });

  test('plain string field is unaffected by both mechanisms', () => {
    const output = compileDSL(VEHICLE_DSL);
    const nameField = getGatherField(output, 'VehicleBot', 'customer_name');

    expect(nameField.validation).toBeUndefined();
    expect(nameField.enum_values).toBeUndefined();
    expect(nameField.semantics?.lookup).toBeUndefined();
  });

  test('lookup_tables record and enum_values coexist at agent IR level', () => {
    const output = compileDSL(VEHICLE_DSL);
    const agent = output.agents['VehicleBot'];

    // Agent-level lookup tables exist
    expect(agent.lookup_tables).toBeDefined();
    expect(agent.lookup_tables!['car_makes']).toBeDefined();
    expect(agent.lookup_tables!['car_makes'].values).toEqual(['Toyota', 'Honda', 'Ford', 'BMW']);

    // Enum values exist on the enum field
    const serviceField = agent.gather.fields.find((f: GatherField) => f.name === 'service_type');
    expect(serviceField).toBeDefined();
    expect(serviceField!.enum_values).toEqual(['oil_change', 'tire_rotation', 'brake_inspection']);
  });

  test('enum field with BOTH options and semantics.lookup compiles independently', () => {
    const dsl = `
AGENT: DualBot
GOAL: "Dual validation"
LOOKUP_TABLES:
  cabin_classes:
    source: inline
    values: economy, business, first
    case_sensitive: false
    fuzzy_match: true
    fuzzy_threshold: 0.85
GATHER:
  cabin_class:
    PROMPT: "Class?"
    TYPE: enum
    OPTIONS: [economy, business, first]
    SEMANTICS:
      LOOKUP: cabin_classes
`;
    const output = compileDSL(dsl);
    const field = getGatherField(output, 'DualBot', 'cabin_class');

    // Enum validation from OPTIONS
    expect(field.validation!.type).toBe('enum');
    expect(field.enum_values).toEqual(['economy', 'business', 'first']);

    // Lookup reference also present
    expect(field.semantics?.lookup).toBe('cabin_classes');

    // Lookup table in agent IR
    const table = output.agents['DualBot'].lookup_tables?.['cabin_classes'];
    expect(table).toBeDefined();
    expect(table!.values).toEqual(['economy', 'business', 'first']);
  });
});

// ---------------------------------------------------------------------------
// E2E-10: Merger conflict detection in pipeline context
// ---------------------------------------------------------------------------

describe('E2E-10: Merger conflict detection in pipeline context', () => {
  test('throws LookupTableConflictError when agent and project define same table name', () => {
    const output = compileDSL(VEHICLE_DSL);
    const agentTables = output.agents['VehicleBot'].lookup_tables;

    // Create a project config with a conflicting "car_makes" table
    const conflictingTable: LookupTableIR = {
      name: 'car_makes',
      source: 'inline',
      values: ['Tesla', 'Rivian', 'Lucid'],
      case_sensitive: false,
      fuzzy_match: false,
      fuzzy_threshold: 0.85,
    };
    const projectConfig = makeProjectConfig([conflictingTable]);

    expect(() => mergeLookupTables(agentTables, projectConfig)).toThrow(LookupTableConflictError);
    expect(() => mergeLookupTables(agentTables, projectConfig)).toThrow(/car_makes/);
  });

  test('conflict error message includes the table name', () => {
    const output = compileDSL(VEHICLE_DSL);
    const agentTables = output.agents['VehicleBot'].lookup_tables;

    const conflictingTable: LookupTableIR = {
      name: 'car_makes',
      source: 'api',
      endpoint: 'https://api.example.com/makes',
      case_sensitive: false,
      fuzzy_match: false,
      fuzzy_threshold: 0.85,
    };
    const projectConfig = makeProjectConfig([conflictingTable]);

    try {
      mergeLookupTables(agentTables, projectConfig);
      // Should not reach here
      expect.unreachable('Expected LookupTableConflictError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LookupTableConflictError);
      if (err instanceof LookupTableConflictError) {
        expect(err.tableName).toBe('car_makes');
        expect(err.message).toContain('car_makes');
        expect(err.message).toContain('defined in both');
      }
    }
  });

  test('non-conflicting tables merge successfully even with conflict-prone names', () => {
    const output = compileDSL(VEHICLE_DSL);
    const agentTables = output.agents['VehicleBot'].lookup_tables;

    // Project has a different table — no conflict
    const nonConflictingTable: LookupTableIR = {
      name: 'car_models',
      source: 'inline',
      values: ['Camry', 'Civic', 'Mustang', 'X3'],
      case_sensitive: false,
      fuzzy_match: true,
      fuzzy_threshold: 0.8,
    };
    const projectConfig = makeProjectConfig([nonConflictingTable]);

    const merged = mergeLookupTables(agentTables, projectConfig);

    expect(Object.keys(merged)).toHaveLength(2);
    expect(merged['car_makes'].values).toEqual(['Toyota', 'Honda', 'Ford', 'BMW']);
    expect(merged['car_models'].values).toEqual(['Camry', 'Civic', 'Mustang', 'X3']);
  });
});
