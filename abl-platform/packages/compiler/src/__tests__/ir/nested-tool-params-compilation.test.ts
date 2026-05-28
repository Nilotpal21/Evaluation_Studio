/**
 * IR Compiler Tests for Nested Tool Parameters
 *
 * Verifies that nested parameter schemas (properties, items) are correctly
 * propagated from AST ToolParam to IR ToolParameter during compilation.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../../platform/ir/compiler.js';

function compileFromDSL(dsl: string, agentName: string) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.errors).toHaveLength(0);
  expect(parseResult.document).not.toBeNull();
  const output = compileABLtoIR([parseResult.document!]);
  const agent = output.agents[agentName];
  expect(agent).toBeDefined();
  return output;
}

describe('IR Compiler: nested tool parameter propagation', () => {
  test('compiles tool parameters with nested properties and items', () => {
    const dsl = `
AGENT: TestAgent
VERSION: "1.0"
DESCRIPTION: "Test"
GOAL: "Test nested params"

TOOLS:
  search(queries: object[], config: object) -> {results: object[]}
    parameters:
      queries:
        type: object[]
        description: "Search queries"
        required: true
        items:
          query:
            type: string
            description: "Search text"
            required: true
      config:
        type: object
        description: "Config object"
        properties:
          limit:
            type: integer
            description: "Max results"
            required: false

FLOW:
  STEP main:
    ACTION: respond
`;

    const output = compileFromDSL(dsl, 'TestAgent');
    const agent = output.agents['TestAgent'];
    const tool = agent.tools.find((t) => t.name === 'search')!;
    expect(tool).toBeDefined();

    // Verify queries param has items with nested properties
    const queriesParam = tool.parameters.find((p) => p.name === 'queries')!;
    expect(queriesParam).toBeDefined();
    expect(queriesParam.items).toBeDefined();
    expect(queriesParam.items!.properties).toHaveLength(1);
    expect(queriesParam.items!.properties![0].name).toBe('query');
    expect(queriesParam.items!.properties![0].type).toBe('string');
    expect(queriesParam.items!.properties![0].description).toBe('Search text');
    expect(queriesParam.items!.properties![0].required).toBe(true);

    // Verify config param has nested properties
    const configParam = tool.parameters.find((p) => p.name === 'config')!;
    expect(configParam).toBeDefined();
    expect(configParam.properties).toBeDefined();
    expect(configParam.properties).toHaveLength(1);
    expect(configParam.properties![0].name).toBe('limit');
    expect(configParam.properties![0].type).toBe('integer');
    expect(configParam.properties![0].description).toBe('Max results');
    expect(configParam.properties![0].required).toBe(false);
  });

  test('compiles single-level nested object properties', () => {
    const dsl = `
AGENT: NestedAgent
VERSION: "1.0"
DESCRIPTION: "Test nesting"
GOAL: "Test nested params"

TOOLS:
  create(data: object) -> {id: string}
    parameters:
      data:
        type: object
        description: "Creation data"
        required: true
        properties:
          city:
            type: string
            description: "City name"
            required: true

FLOW:
  STEP main:
    ACTION: respond
`;

    const output = compileFromDSL(dsl, 'NestedAgent');
    const agent = output.agents['NestedAgent'];
    const tool = agent.tools.find((t) => t.name === 'create')!;

    const dataParam = tool.parameters.find((p) => p.name === 'data')!;
    expect(dataParam.properties).toHaveLength(1);

    const cityProp = dataParam.properties![0];
    expect(cityProp.name).toBe('city');
    expect(cityProp.type).toBe('string');
    expect(cityProp.description).toBe('City name');
    expect(cityProp.required).toBe(true);
  });

  test('parameters without nested schemas compile normally', () => {
    const dsl = `
AGENT: FlatAgent
VERSION: "1.0"
DESCRIPTION: "Test flat params"
GOAL: "Test"

TOOLS:
  ping(host: string) -> {alive: boolean}

FLOW:
  STEP main:
    ACTION: respond
`;

    const output = compileFromDSL(dsl, 'FlatAgent');
    const agent = output.agents['FlatAgent'];
    const tool = agent.tools.find((t) => t.name === 'ping')!;
    const hostParam = tool.parameters.find((p) => p.name === 'host')!;
    expect(hostParam.properties).toBeUndefined();
    expect(hostParam.items).toBeUndefined();
  });
});
