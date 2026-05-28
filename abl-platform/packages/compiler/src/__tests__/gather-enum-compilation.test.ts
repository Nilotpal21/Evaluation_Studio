/**
 * Gather Enum Compilation Tests (GAP-2)
 *
 * Verifies that:
 * - Enum fields with options compile to ValidationRule type:'enum'
 * - enum_values is populated on the IR gather field
 * - Fields without options compile as type:'pattern' (regex validation)
 * - Enum validation rule contains pipe-delimited values
 */

import { describe, test, expect } from 'vitest';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import { parseAgentBasedABL } from '@abl/core';

function compileAgent(dsl: string, agentName: string) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.document).toBeDefined();
  expect(parseResult.errors).toHaveLength(0);
  const output = compileABLtoIR([parseResult.document!]);
  const agent = output.agents[agentName];
  expect(agent).toBeDefined();
  return agent;
}

describe('Enum field compilation', () => {
  test('enum field with options produces type:enum ValidationRule', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  cabin_class:
    PROMPT: "What cabin class?"
    TYPE: enum
    OPTIONS: [economy, business, first]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.name).toBe('cabin_class');
    expect(field.validation).toBeDefined();
    expect(field.validation!.type).toBe('enum');
    expect(field.validation!.rule).toBe('economy|business|first');
    expect(field.validation!.error_message).toContain('cabin_class');
    expect(field.validation!.error_message).toContain('economy');
  });

  test('enum_values is populated on the IR gather field', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  size:
    PROMPT: "What size?"
    TYPE: enum
    OPTIONS: small, medium, large
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.enum_values).toEqual(['small', 'medium', 'large']);
  });

  test('enum field without options produces no validation', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  cabin_class:
    PROMPT: "What cabin class?"
    TYPE: enum
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.validation).toBeUndefined();
    expect(field.enum_values).toBeUndefined();
  });

  test('non-enum field with validate produces type:pattern', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  phone:
    PROMPT: "Phone number?"
    TYPE: string
    VALIDATE: "^\\\\+?[0-9]{10,14}$"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.validation).toBeDefined();
    expect(field.validation!.type).toBe('pattern');
  });

  test('enum validation error message lists allowed values', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  priority:
    PROMPT: "Priority level?"
    TYPE: enum
    OPTIONS: [low, medium, high, critical]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.validation!.error_message).toBe(
      'Invalid priority. Allowed values: low, medium, high, critical',
    );
  });
});
