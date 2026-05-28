/**
 * Integration: Parser → Compiler Pipeline (INT-1, INT-2)
 *
 * Tests cross-package boundary: @abl/core parser → @abl/compiler IR compiler.
 * Verifies that DSL constructs survive the full parse→compile pipeline.
 */

import { describe, test, expect } from 'vitest';
import { compileABLtoIR } from '../../platform/ir/compiler.js';
import { parseAgentBasedABL } from '@abl/core';

function compileAgent(dsl: string, agentName: string) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.document).toBeDefined();
  expect(parseResult.errors).toHaveLength(0);
  const output = compileABLtoIR([parseResult.document!]);
  const agent = output.agents[agentName];
  expect(agent).toBeDefined();
  return { agent, output };
}

// ---------------------------------------------------------------------------
// INT-1: Enum field with options → enum ValidationRule + enum_values
// ---------------------------------------------------------------------------

describe('INT-1: Parser → Compiler — enum field with options', () => {
  const DSL = `
AGENT: BookingAgent
GOAL: "Help users book flights"
GATHER:
  cabin_class:
    PROMPT: "What cabin class?"
    TYPE: enum
    OPTIONS: [economy, business, first]
    REQUIRED: true
  destination:
    PROMPT: "Where to?"
    TYPE: string
`;

  test('enum options survive parse→compile to IR ValidationRule type:enum', () => {
    const { agent } = compileAgent(DSL, 'BookingAgent');
    const field = agent.gather.fields.find((f: any) => f.name === 'cabin_class');

    expect(field).toBeDefined();
    expect(field!.validation).toBeDefined();
    expect(field!.validation!.type).toBe('enum');
    expect(field!.validation!.rule).toBe('economy|business|first');
  });

  test('enum_values populated on IR gather field', () => {
    const { agent } = compileAgent(DSL, 'BookingAgent');
    const field = agent.gather.fields.find((f: any) => f.name === 'cabin_class');

    expect(field!.enum_values).toEqual(['economy', 'business', 'first']);
  });

  test('non-enum field in same agent is unaffected', () => {
    const { agent } = compileAgent(DSL, 'BookingAgent');
    const field = agent.gather.fields.find((f: any) => f.name === 'destination');

    expect(field).toBeDefined();
    expect(field!.validation).toBeUndefined();
    expect(field!.enum_values).toBeUndefined();
  });

  test('enum error message includes field name and allowed values', () => {
    const { agent } = compileAgent(DSL, 'BookingAgent');
    const field = agent.gather.fields.find((f: any) => f.name === 'cabin_class');

    expect(field!.validation!.error_message).toContain('cabin_class');
    expect(field!.validation!.error_message).toContain('economy');
    expect(field!.validation!.error_message).toContain('first');
  });

  test('semantics.lookup coexists with enum options', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test"
GATHER:
  cabin_class:
    PROMPT: "Class?"
    TYPE: enum
    OPTIONS: [economy, business, first]
    SEMANTICS:
      LOOKUP: cabin_classes
LOOKUP_TABLES:
  cabin_classes:
    source: inline
    values: economy, business, first
    case_sensitive: false
    fuzzy_match: true
    fuzzy_threshold: 0.85
`;
    const { agent, output } = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    // Enum validation from options
    expect(field.validation!.type).toBe('enum');
    expect(field.enum_values).toEqual(['economy', 'business', 'first']);

    // Lookup table also compiled
    expect(field.semantics?.lookup).toBe('cabin_classes');
    expect(output.agents['TestAgent'].lookup_tables?.['cabin_classes']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// INT-2: Lookup table with headers → IR LookupTableIR.headers
// ---------------------------------------------------------------------------

describe('INT-2: Parser → Compiler — lookup table with headers', () => {
  test('headers sub-block survives parse→compile to IR', () => {
    const dsl = `
AGENT: ProductAgent
GOAL: "Validate products"
GATHER:
  product:
    PROMPT: "Which product?"
    TYPE: string
    SEMANTICS:
      LOOKUP: products
LOOKUP_TABLES:
  products:
    source: api
    endpoint: https://api.example.com/products/lookup
    timeout_ms: 3000
    headers:
      Authorization: Bearer my-token-123
      X-API-Key: secret-key
    case_sensitive: false
    fuzzy_match: false
`;
    const { output } = compileAgent(dsl, 'ProductAgent');
    const table = output.agents['ProductAgent'].lookup_tables?.['products'];

    expect(table).toBeDefined();
    expect(table!.headers).toEqual({
      Authorization: 'Bearer my-token-123',
      'X-API-Key': 'secret-key',
    });
  });

  test('lookup table without headers has undefined headers in IR', () => {
    const dsl = `
AGENT: SimpleAgent
GOAL: "Validate cities"
GATHER:
  city:
    PROMPT: "Which city?"
    TYPE: string
    SEMANTICS:
      LOOKUP: cities
LOOKUP_TABLES:
  cities:
    source: inline
    values: NYC, LAX, CDG
    case_sensitive: false
    fuzzy_match: false
`;
    const { output } = compileAgent(dsl, 'SimpleAgent');
    const table = output.agents['SimpleAgent'].lookup_tables?.['cities'];

    expect(table).toBeDefined();
    expect(table!.headers).toBeUndefined();
  });

  test('all API source properties survive parse→compile', () => {
    const dsl = `
AGENT: FullApiAgent
GOAL: "Test"
GATHER:
  item:
    PROMPT: "Item?"
    TYPE: string
    SEMANTICS:
      LOOKUP: items
LOOKUP_TABLES:
  items:
    source: api
    endpoint: https://api.example.com/lookup
    timeout_ms: 5000
    field: name
    headers:
      Authorization: Bearer token
    case_sensitive: false
    fuzzy_match: true
    fuzzy_threshold: 0.9
`;
    const { output } = compileAgent(dsl, 'FullApiAgent');
    const table = output.agents['FullApiAgent'].lookup_tables?.['items'];

    expect(table!.source).toBe('api');
    expect(table!.endpoint).toBe('https://api.example.com/lookup');
    expect(table!.timeout_ms).toBe(5000);
    expect(table!.field).toBe('name');
    expect(table!.headers).toEqual({ Authorization: 'Bearer token' });
    expect(table!.case_sensitive).toBe(false);
    expect(table!.fuzzy_match).toBe(true);
    expect(table!.fuzzy_threshold).toBe(0.9);
  });

  test('multiple lookup tables with different sources compile correctly', () => {
    const dsl = `
AGENT: MultiAgent
GOAL: "Test"
GATHER:
  city:
    PROMPT: "City?"
    TYPE: string
    SEMANTICS:
      LOOKUP: cities
  product:
    PROMPT: "Product?"
    TYPE: string
    SEMANTICS:
      LOOKUP: products
LOOKUP_TABLES:
  cities:
    source: inline
    values: NYC, LAX
    case_sensitive: false
    fuzzy_match: false
  products:
    source: api
    endpoint: https://api.example.com/lookup
    headers:
      X-Key: abc
    case_sensitive: false
    fuzzy_match: false
`;
    const { output } = compileAgent(dsl, 'MultiAgent');
    const tables = output.agents['MultiAgent'].lookup_tables;

    expect(tables?.['cities']?.source).toBe('inline');
    expect(tables?.['cities']?.values).toEqual(['NYC', 'LAX']);
    expect(tables?.['cities']?.headers).toBeUndefined();

    expect(tables?.['products']?.source).toBe('api');
    expect(tables?.['products']?.headers).toEqual({ 'X-Key': 'abc' });
  });
});
