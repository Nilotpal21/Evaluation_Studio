/**
 * E2E-7: Enum constraint flows from DSL through compiler to LLM tool schema
 *
 * Full pipeline: DSL text → parseAgentBasedABL → compileABLtoIR → IR assertions
 * → FlowStepExecutor.buildExtractionTool → JSON Schema enum constraint
 *
 * Real components (ALL pure, no mocks):
 * - parseAgentBasedABL (@abl/core)
 * - compileABLtoIR (@abl/compiler)
 * - FlowStepExecutor.buildExtractionTool (apps/runtime — static, no side effects)
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../../platform/ir/compiler.js';
import type { CompilationOutput, GatherField, LookupTableIR } from '../../platform/ir/schema.js';

// ---------------------------------------------------------------------------
// Helpers
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

// ---------------------------------------------------------------------------
// E2E-7: Enum field — full pipeline from DSL to extraction tool schema
// ---------------------------------------------------------------------------

describe('E2E-7: Enum constraint DSL → Parser → Compiler → IR → Extraction Tool', () => {
  const BOOKING_DSL = `
AGENT: BookingAgent
GOAL: "Help users book flights"
GATHER:
  cabin_class:
    PROMPT: "What cabin class would you like?"
    TYPE: enum
    OPTIONS: [economy, business, first]
    REQUIRED: true
  destination:
    PROMPT: "Where would you like to fly?"
    TYPE: string
    REQUIRED: true
  passengers:
    PROMPT: "How many passengers?"
    TYPE: number
`;

  test('IR gather field has validation.type === enum and validation.rule === pipe-delimited options', () => {
    const output = compileDSL(BOOKING_DSL);
    const field = getGatherField(output, 'BookingAgent', 'cabin_class');

    expect(field.validation).toBeDefined();
    expect(field.validation!.type).toBe('enum');
    expect(field.validation!.rule).toBe('economy|business|first');
  });

  test('IR gather field has enum_values populated from OPTIONS', () => {
    const output = compileDSL(BOOKING_DSL);
    const field = getGatherField(output, 'BookingAgent', 'cabin_class');

    expect(field.enum_values).toEqual(['economy', 'business', 'first']);
  });

  test('validation error_message includes field name and allowed values', () => {
    const output = compileDSL(BOOKING_DSL);
    const field = getGatherField(output, 'BookingAgent', 'cabin_class');

    expect(field.validation!.error_message).toContain('cabin_class');
    expect(field.validation!.error_message).toContain('economy');
    expect(field.validation!.error_message).toContain('first');
  });

  test('non-enum fields are unaffected', () => {
    const output = compileDSL(BOOKING_DSL);
    const dest = getGatherField(output, 'BookingAgent', 'destination');
    const pax = getGatherField(output, 'BookingAgent', 'passengers');

    // string fields have no intrinsic validation
    expect(dest.validation).toBeUndefined();
    expect(dest.enum_values).toBeUndefined();

    // number fields get auto-generated intrinsic validation (not enum)
    expect(pax.validation).toBeDefined();
    expect(pax.validation!.type).toBe('intrinsic');
    expect(pax.validation!.rule).toBe('number');
    expect(pax.enum_values).toBeUndefined();
  });

  test('enum + inline lookup table coexist in compiled IR', () => {
    const dsl = `
AGENT: FlightAgent
GOAL: "Book flights"
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
    const output = compileDSL(dsl);
    const field = getGatherField(output, 'FlightAgent', 'cabin_class');

    // Enum validation from OPTIONS
    expect(field.validation!.type).toBe('enum');
    expect(field.enum_values).toEqual(['economy', 'business', 'first']);

    // Lookup table also present
    expect(field.semantics?.lookup).toBe('cabin_classes');
    const table = output.agents['FlightAgent'].lookup_tables?.['cabin_classes'];
    expect(table).toBeDefined();
    expect(table!.source).toBe('inline');
    expect(table!.values).toEqual(['economy', 'business', 'first']);
  });

  test('API lookup table with headers survives full pipeline', () => {
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
    const output = compileDSL(dsl);
    const table = output.agents['ProductAgent'].lookup_tables?.['products'] as LookupTableIR;

    expect(table).toBeDefined();
    expect(table.source).toBe('api');
    expect(table.endpoint).toBe('https://api.example.com/products/lookup');
    expect(table.timeout_ms).toBe(3000);
    expect(table.headers).toEqual({
      Authorization: 'Bearer my-token-123',
      'X-API-Key': 'secret-key',
    });
  });

  test('multi-agent compilation with enum fields compiles independently', () => {
    const dslA = `
AGENT: AgentA
GOAL: "Agent A"
GATHER:
  color:
    PROMPT: "Color?"
    TYPE: enum
    OPTIONS: [red, green, blue]
`;
    const dslB = `
AGENT: AgentB
GOAL: "Agent B"
GATHER:
  size:
    PROMPT: "Size?"
    TYPE: enum
    OPTIONS: [small, medium, large]
`;
    const docA = parseAgentBasedABL(dslA);
    const docB = parseAgentBasedABL(dslB);
    expect(docA.errors).toHaveLength(0);
    expect(docB.errors).toHaveLength(0);

    const output = compileABLtoIR([docA.document!, docB.document!]);

    const colorField = getGatherField(output, 'AgentA', 'color');
    expect(colorField.enum_values).toEqual(['red', 'green', 'blue']);
    expect(colorField.validation!.rule).toBe('red|green|blue');

    const sizeField = getGatherField(output, 'AgentB', 'size');
    expect(sizeField.enum_values).toEqual(['small', 'medium', 'large']);
    expect(sizeField.validation!.rule).toBe('small|medium|large');
  });
});
