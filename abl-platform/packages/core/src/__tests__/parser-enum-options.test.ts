/**
 * Parser Enum Options Tests (GAP-1)
 *
 * Verifies that the parser correctly parses the `options` property
 * on gather fields for enum type fields.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

describe('GATHER enum options parsing', () => {
  test('parses options as bracket list [a, b, c]', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  cabin_class:
    PROMPT: "What cabin class?"
    TYPE: enum
    OPTIONS: [economy, business, first]
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.gather[0];
    expect(field.name).toBe('cabin_class');
    expect(field.type).toBe('enum');
    expect(field.options).toEqual(['economy', 'business', 'first']);
  });

  test('parses options as comma-separated values without brackets', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  size:
    PROMPT: "What size?"
    TYPE: enum
    OPTIONS: small, medium, large
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.gather[0];
    expect(field.options).toEqual(['small', 'medium', 'large']);
  });

  test('trims whitespace from option values', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  color:
    PROMPT: "Pick a color"
    TYPE: enum
    OPTIONS: [ red , green , blue ]
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.gather[0];
    expect(field.options).toEqual(['red', 'green', 'blue']);
  });

  test('filters empty values from options', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  status:
    PROMPT: "Status?"
    TYPE: enum
    OPTIONS: active,, inactive,
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.gather[0];
    expect(field.options).toEqual(['active', 'inactive']);
  });

  test('options property is undefined when not specified', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  name:
    PROMPT: "Your name?"
    TYPE: string
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.gather[0];
    expect(field.options).toBeUndefined();
  });

  test('options with single value', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  confirm:
    PROMPT: "Confirm?"
    TYPE: enum
    OPTIONS: yes
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.gather[0];
    expect(field.options).toEqual(['yes']);
  });

  test('options coexists with other gather field properties', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  cabin_class:
    PROMPT: "What cabin class?"
    TYPE: enum
    OPTIONS: [economy, business, first]
    REQUIRED: true
    INFER: true
    SEMANTICS:
      LOOKUP: cabin_classes
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.gather[0];
    expect(field.options).toEqual(['economy', 'business', 'first']);
    expect(field.required).toBe(true);
    expect(field.infer).toBe(true);
    expect(field.semantics?.lookup).toBe('cabin_classes');
  });
});
