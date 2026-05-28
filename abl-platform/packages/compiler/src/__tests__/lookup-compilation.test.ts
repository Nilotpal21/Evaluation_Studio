/**
 * Lookup Table Compilation Tests
 *
 * Verifies that the compiler correctly transforms parsed LookupTableDefinition
 * objects into LookupTableIR, including:
 * - Pre-computed normalized_values for case-insensitive inline tables
 * - No normalized_values for case-sensitive tables
 * - Collection source with table_name
 * - API source with timeout_ms
 * - Default fuzzy_threshold of 0.85
 */

import { describe, it, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import type { AgentIR } from '../platform/ir/schema.js';
import { validateIR } from '../platform/ir/validate-ir.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';

// =============================================================================
// HELPERS
// =============================================================================

function compileFromDSL(dsl: string): AgentIR {
  const parsed = parseAgentBasedABL(dsl);
  expect(parsed.errors).toHaveLength(0);
  expect(parsed.document).not.toBeNull();
  const output = compileABLtoIR([parsed.document!]);
  const agentName = parsed.document!.name;
  const ir = output.agents[agentName];
  expect(ir).toBeDefined();
  return ir;
}

const MINIMAL_AGENT = `AGENT: test_agent
GOAL: "Test agent for lookup table compilation"
PERSONA: "A test assistant"`;

const FLOW_SECTION = `
FLOW:
  start:
    REASONING: false
    SAY: "Hello"`;

// =============================================================================
// TESTS
// =============================================================================

describe('Lookup Table Compilation', () => {
  it('produces normalized_values for inline + case_insensitive table', () => {
    const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  airports:
    source: inline
    values: [LAX, JFK, CDG, LHR]
    case_sensitive: false
    fuzzy_match: true
    fuzzy_threshold: 0.85
${FLOW_SECTION}
`;
    const ir = compileFromDSL(dsl);
    expect(ir.lookup_tables).toBeDefined();
    const airports = ir.lookup_tables!['airports'];
    expect(airports).toBeDefined();
    expect(airports.source).toBe('inline');
    expect(airports.values).toEqual(['LAX', 'JFK', 'CDG', 'LHR']);
    expect(airports.normalized_values).toEqual(['lax', 'jfk', 'cdg', 'lhr']);
    expect(airports.case_sensitive).toBe(false);
  });

  it('does NOT produce normalized_values for inline + case_sensitive table', () => {
    const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  codes:
    source: inline
    values: [ABC, DEF, GHI]
    case_sensitive: true
    fuzzy_match: false
${FLOW_SECTION}
`;
    const ir = compileFromDSL(dsl);
    expect(ir.lookup_tables).toBeDefined();
    const codes = ir.lookup_tables!['codes'];
    expect(codes).toBeDefined();
    expect(codes.source).toBe('inline');
    expect(codes.values).toEqual(['ABC', 'DEF', 'GHI']);
    expect(codes.normalized_values).toBeUndefined();
    expect(codes.case_sensitive).toBe(true);
  });

  it('compiles collection source with table_name field', () => {
    const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  hotels:
    source: collection
    table_name: lookup_hotels
    field: name
    fuzzy_match: true
    fuzzy_threshold: 0.9
${FLOW_SECTION}
`;
    const ir = compileFromDSL(dsl);
    expect(ir.lookup_tables).toBeDefined();
    const hotels = ir.lookup_tables!['hotels'];
    expect(hotels).toBeDefined();
    expect(hotels.source).toBe('collection');
    expect(hotels.table_name).toBe('lookup_hotels');
    expect(hotels.field).toBe('name');
    expect(hotels.values).toBeUndefined();
    expect(hotels.normalized_values).toBeUndefined();
  });

  it('compiles api source with timeout_ms field', () => {
    const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  products:
    source: api
    endpoint: https://api.example.com/lookup/products
    field: sku
    timeout_ms: 3000
    fuzzy_match: false
${FLOW_SECTION}
`;
    const ir = compileFromDSL(dsl);
    expect(ir.lookup_tables).toBeDefined();
    const products = ir.lookup_tables!['products'];
    expect(products).toBeDefined();
    expect(products.source).toBe('api');
    expect(products.endpoint).toBe('https://api.example.com/lookup/products');
    expect(products.field).toBe('sku');
    expect(products.timeout_ms).toBe(3000);
    expect(products.values).toBeUndefined();
    expect(products.normalized_values).toBeUndefined();
  });

  it('defaults fuzzy_threshold to 0.85 when not specified', () => {
    const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  cities:
    source: inline
    values: [London, Paris, Tokyo]
    fuzzy_match: true
${FLOW_SECTION}
`;
    const ir = compileFromDSL(dsl);
    expect(ir.lookup_tables).toBeDefined();
    const cities = ir.lookup_tables!['cities'];
    expect(cities).toBeDefined();
    expect(cities.fuzzy_match).toBe(true);
    expect(cities.fuzzy_threshold).toBe(0.85);
  });

  it('warns that agent-local LOOKUP_TABLES remain experimental', () => {
    const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  cities:
    source: inline
    values: [London, Paris, Tokyo]
${FLOW_SECTION}
`;
    const ir = compileFromDSL(dsl);
    const diagnostics = validateIR(ir, [ir]);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.AGENT_LOOKUP_TABLE_EXPERIMENTAL,
          path: 'lookup_tables',
          severity: 'warning',
        }),
      ]),
    );
  });
});
