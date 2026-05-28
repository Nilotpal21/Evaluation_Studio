/**
 * Dual-Format Compilation Tests
 *
 * Verifies that both the legacy ABL format (AGENT:, MODE:, uppercase sections)
 * and the new YAML format (agent:, mode:, lowercase keys) compile to equivalent IR
 * via compileABLtoIR().
 *
 * Each format has its own syntax (e.g., legacy tools use `name(params) -> return`
 * while YAML tools use `- name:` / `parameters:` / `returns:`). The tests verify
 * that semantically equivalent agents produce the same core IR fields regardless
 * of which parser path was used.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL, parseYamlABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import type { AgentIR } from '../platform/ir/schema.js';

// =============================================================================
// TEST FIXTURES — YAML FORMAT
// =============================================================================

const YAML_REASONING_AGENT = `
agent: TestAgent
goal: "Help users with testing"
persona: "A helpful test assistant."
tools:
  - name: search
    description: "Search for information"
    parameters:
      - name: query
        type: string
        required: true
    returns:
      type: object
complete:
  - when: "task_done == true"
    respond: "Done."
`;

const YAML_SCRIPTED_AGENT = `
agent: OrderBot
goal: "Process customer orders"
persona: "A professional order processor."
gather:
  - name: item_name
    type: string
    prompt: "What item would you like to order?"
    required: true
  - name: quantity
    type: number
    prompt: "How many would you like?"
    required: true
flow:
  steps:
    - greet
    - collect_info
    - confirm
  greet:
    respond: "Welcome! I can help you place an order."
    then: collect_info
  collect_info:
    collect: [item_name, quantity]
    then: confirm
  confirm:
    respond: "Your order has been placed."
complete:
  - when: "order_placed == true"
    respond: "Order confirmed!"
`;

const YAML_WITH_CONSTRAINTS = `
agent: SafeBot
goal: "Help users safely"
persona: "A safety-conscious assistant."
constraints:
  - condition: "user.age >= 18"
    on_fail: "Must be 18 or older"
  - condition: "user.verified == true"
    on_fail: "Account must be verified"
complete:
  - when: "done == true"
    respond: "Goodbye!"
`;

// =============================================================================
// TEST FIXTURES — LEGACY ABL FORMAT
// =============================================================================

const LEGACY_REASONING_AGENT = `
AGENT: TestAgent

GOAL: "Help users with testing"
PERSONA: "A helpful test assistant."
TOOLS:
  search(query: string) -> {result: object}
    description: "Search for information"
COMPLETE:
  - WHEN: task_done == true
    RESPOND: "Done."
`;

const LEGACY_SCRIPTED_AGENT = `
AGENT: OrderBot

GOAL: "Process customer orders"
PERSONA: "A professional order processor."
GATHER:
  item_name:
    prompt: "What item would you like to order?"
    type: string
    required: true
  quantity:
    prompt: "How many would you like?"
    type: number
    required: true
FLOW:
  STEPS:
    - greet
    - collect_info
    - confirm
  greet:
    REASONING: false
    RESPOND: "Welcome! I can help you place an order."
    THEN: collect_info
  collect_info:
    REASONING: false
    COLLECT: [item_name, quantity]
    THEN: confirm
  confirm:
    REASONING: false
    RESPOND: "Your order has been placed."
COMPLETE:
  - WHEN: order_placed == true
    RESPOND: "Order confirmed!"
`;

const LEGACY_WITH_CONSTRAINTS = `
AGENT: SafeBot

GOAL: "Help users safely"
PERSONA: "A safety-conscious assistant."
CONSTRAINTS:
  always:
    - REQUIRE user.age >= 18
      ON_FAIL: "Must be 18 or older"
    - REQUIRE user.verified == true
      ON_FAIL: "Account must be verified"
COMPLETE:
  - WHEN: done == true
    RESPOND: "Goodbye!"
`;

// =============================================================================
// HELPERS
// =============================================================================

function compileFromLegacy(dsl: string): { ir: AgentIR; agentName: string } {
  const parsed = parseAgentBasedABL(dsl);
  expect(parsed.errors).toHaveLength(0);
  expect(parsed.document).not.toBeNull();
  const output = compileABLtoIR([parsed.document!]);
  const agentName = parsed.document!.name;
  const ir = output.agents[agentName];
  expect(ir).toBeDefined();
  return { ir, agentName };
}

function compileFromYaml(yamlContent: string): { ir: AgentIR; agentName: string } {
  const parsed = parseYamlABL(yamlContent);
  expect(parsed.errors).toHaveLength(0);
  expect(parsed.document).not.toBeNull();
  const output = compileABLtoIR([parsed.document!]);
  const agentName = parsed.document!.name;
  const ir = output.agents[agentName];
  expect(ir).toBeDefined();
  return { ir, agentName };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Dual-Format Compilation', () => {
  // ---------------------------------------------------------------------------
  // YAML format compilation
  // ---------------------------------------------------------------------------
  describe('YAML format compilation', () => {
    test('compiles a reasoning agent from YAML format', () => {
      const { ir } = compileFromYaml(YAML_REASONING_AGENT);

      expect(ir.metadata.name).toBe('TestAgent');
      expect(ir.metadata.type).toBe('agent');

      expect(ir.identity.goal).toBe('Help users with testing');
      expect(ir.identity.persona).toBe('A helpful test assistant.');
    });

    test('compiles a scripted agent from YAML format', () => {
      const { ir } = compileFromYaml(YAML_SCRIPTED_AGENT);

      expect(ir.metadata.name).toBe('OrderBot');

      expect(ir.identity.goal).toBe('Process customer orders');
    });

    test('compiles tools from YAML format', () => {
      const { ir } = compileFromYaml(YAML_REASONING_AGENT);

      const searchTool = ir.tools.find((t) => t.name === 'search');
      expect(searchTool).toBeDefined();
      expect(searchTool!.description).toBe('Search for information');
      expect(searchTool!.parameters).toHaveLength(1);
      expect(searchTool!.parameters[0].name).toBe('query');
      expect(searchTool!.parameters[0].type).toBe('string');
      expect(searchTool!.parameters[0].required).toBe(true);
    });

    test('compiles completion conditions from YAML format', () => {
      const { ir } = compileFromYaml(YAML_REASONING_AGENT);

      expect(ir.completion.conditions).toHaveLength(1);
      expect(ir.completion.conditions[0].when).toBe('task_done == true');
      expect(ir.completion.conditions[0].respond).toBe('Done.');
    });

    test('compiles gather fields from YAML format', () => {
      const { ir } = compileFromYaml(YAML_SCRIPTED_AGENT);

      expect(ir.gather.fields).toHaveLength(2);
      const itemField = ir.gather.fields.find((f) => f.name === 'item_name');
      expect(itemField).toBeDefined();
      expect(itemField!.type).toBe('string');
      expect(itemField!.required).toBe(true);
    });

    test('compiles constraints from YAML format', () => {
      const { ir } = compileFromYaml(YAML_WITH_CONSTRAINTS);

      expect(ir.constraints.constraints.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Legacy ABL format compilation
  // ---------------------------------------------------------------------------
  describe('Legacy ABL format compilation', () => {
    test('compiles a reasoning agent from legacy format', () => {
      const { ir } = compileFromLegacy(LEGACY_REASONING_AGENT);

      expect(ir.metadata.name).toBe('TestAgent');
      expect(ir.metadata.type).toBe('agent');

      expect(ir.identity.goal).toBe('Help users with testing');
      expect(ir.identity.persona).toBe('A helpful test assistant.');
    });

    test('compiles a scripted agent from legacy format', () => {
      const { ir } = compileFromLegacy(LEGACY_SCRIPTED_AGENT);

      expect(ir.metadata.name).toBe('OrderBot');

      expect(ir.identity.goal).toBe('Process customer orders');
    });

    test('compiles tools from legacy format', () => {
      const { ir } = compileFromLegacy(LEGACY_REASONING_AGENT);

      const searchTool = ir.tools.find((t) => t.name === 'search');
      expect(searchTool).toBeDefined();
      expect(searchTool!.description).toBe('Search for information');
      expect(searchTool!.parameters).toHaveLength(1);
      expect(searchTool!.parameters[0].name).toBe('query');
    });

    test('compiles completion conditions from legacy format', () => {
      const { ir } = compileFromLegacy(LEGACY_REASONING_AGENT);

      expect(ir.completion.conditions).toHaveLength(1);
      expect(ir.completion.conditions[0].when).toBe('task_done == true');
      expect(ir.completion.conditions[0].respond).toBe('Done.');
    });

    test('compiles gather fields from legacy format', () => {
      const { ir } = compileFromLegacy(LEGACY_SCRIPTED_AGENT);

      expect(ir.gather.fields).toHaveLength(2);
      const itemField = ir.gather.fields.find((f) => f.name === 'item_name');
      expect(itemField).toBeDefined();
      expect(itemField!.type).toBe('string');
      expect(itemField!.required).toBe(true);
    });

    test('compiles constraints from legacy format', () => {
      const { ir } = compileFromLegacy(LEGACY_WITH_CONSTRAINTS);

      expect(ir.constraints.constraints.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Format equivalence — both produce same IR for the same semantic agent
  // ---------------------------------------------------------------------------
  describe('Format equivalence', () => {
    test('reasoning agent: both formats produce equivalent core IR properties', () => {
      const yamlResult = compileFromYaml(YAML_REASONING_AGENT);
      const legacyResult = compileFromLegacy(LEGACY_REASONING_AGENT);

      // Metadata (name, type)
      expect(yamlResult.ir.metadata.name).toBe(legacyResult.ir.metadata.name);
      expect(yamlResult.ir.metadata.type).toBe(legacyResult.ir.metadata.type);

      // Execution mode

      // Identity
      expect(yamlResult.ir.identity.goal).toBe(legacyResult.ir.identity.goal);
      expect(yamlResult.ir.identity.persona).toBe(legacyResult.ir.identity.persona);

      // Tools — both should have the search tool with the same signature
      const yamlSearch = yamlResult.ir.tools.find((t) => t.name === 'search');
      const legacySearch = legacyResult.ir.tools.find((t) => t.name === 'search');
      expect(yamlSearch).toBeDefined();
      expect(legacySearch).toBeDefined();
      expect(yamlSearch!.description).toBe(legacySearch!.description);
      expect(yamlSearch!.parameters[0].name).toBe(legacySearch!.parameters[0].name);
      expect(yamlSearch!.parameters[0].type).toBe(legacySearch!.parameters[0].type);

      // Completion conditions
      expect(yamlResult.ir.completion.conditions.length).toBe(
        legacyResult.ir.completion.conditions.length,
      );
      expect(yamlResult.ir.completion.conditions[0].when).toBe(
        legacyResult.ir.completion.conditions[0].when,
      );
      expect(yamlResult.ir.completion.conditions[0].respond).toBe(
        legacyResult.ir.completion.conditions[0].respond,
      );
    });

    test('scripted agent: both formats produce equivalent gather IR and metadata', () => {
      const yamlResult = compileFromYaml(YAML_SCRIPTED_AGENT);
      const legacyResult = compileFromLegacy(LEGACY_SCRIPTED_AGENT);

      // Metadata
      expect(yamlResult.ir.metadata.name).toBe(legacyResult.ir.metadata.name);

      // Gather fields (compare names, types, required)
      const yamlFields = yamlResult.ir.gather.fields
        .map((f) => ({ name: f.name, type: f.type, required: f.required }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const legacyFields = legacyResult.ir.gather.fields
        .map((f) => ({ name: f.name, type: f.type, required: f.required }))
        .sort((a, b) => a.name.localeCompare(b.name));
      expect(yamlFields).toEqual(legacyFields);

      // Flow: legacy supports FLOW section; YAML parser does not yet support flow.
      // Verify the legacy agent has flow compiled with the expected step names.
      expect(legacyResult.ir.flow).toBeDefined();
      expect(legacyResult.ir.flow!.steps).toContain('greet');
      expect(legacyResult.ir.flow!.steps).toContain('collect_info');
      expect(legacyResult.ir.flow!.steps).toContain('confirm');
    });

    test('constraints: both formats produce constraints in IR', () => {
      const yamlResult = compileFromYaml(YAML_WITH_CONSTRAINTS);
      const legacyResult = compileFromLegacy(LEGACY_WITH_CONSTRAINTS);

      // Metadata
      expect(yamlResult.ir.metadata.name).toBe(legacyResult.ir.metadata.name);

      // Both should have the same number of constraints
      expect(yamlResult.ir.constraints.constraints.length).toBe(
        legacyResult.ir.constraints.constraints.length,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Auto-detection via parseAgentBasedABL
  // ---------------------------------------------------------------------------
  describe('Auto-detection via parseAgentBasedABL', () => {
    test('parseAgentBasedABL auto-detects YAML format and parses correctly', () => {
      const result = parseAgentBasedABL(YAML_REASONING_AGENT);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();
      expect(result.document!.name).toBe('TestAgent');
    });

    test('parseAgentBasedABL still handles legacy format', () => {
      const result = parseAgentBasedABL(LEGACY_REASONING_AGENT);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();
      expect(result.document!.name).toBe('TestAgent');
    });

    test('YAML passed through parseAgentBasedABL compiles to same IR as parseYamlABL', () => {
      // Parse YAML through the auto-detecting parseAgentBasedABL
      const autoDetectParsed = parseAgentBasedABL(YAML_REASONING_AGENT);
      expect(autoDetectParsed.errors).toHaveLength(0);
      const autoDetectOutput = compileABLtoIR([autoDetectParsed.document!]);
      const autoDetectIR = autoDetectOutput.agents['TestAgent'];

      // Parse YAML directly through parseYamlABL
      const directParsed = parseYamlABL(YAML_REASONING_AGENT);
      expect(directParsed.errors).toHaveLength(0);
      const directOutput = compileABLtoIR([directParsed.document!]);
      const directIR = directOutput.agents['TestAgent'];

      // Both paths should produce identical IR
      expect(autoDetectIR.metadata.name).toBe(directIR.metadata.name);

      expect(autoDetectIR.identity.goal).toBe(directIR.identity.goal);
      expect(autoDetectIR.identity.persona).toBe(directIR.identity.persona);
      expect(autoDetectIR.tools.length).toBe(directIR.tools.length);
      expect(autoDetectIR.completion.conditions.length).toBe(directIR.completion.conditions.length);
    });

    test('YAML and legacy produce equivalent core IR through parseAgentBasedABL', () => {
      // Both go through parseAgentBasedABL (which auto-detects format)
      const yamlParsed = parseAgentBasedABL(YAML_REASONING_AGENT);
      expect(yamlParsed.errors).toHaveLength(0);
      const yamlOutput = compileABLtoIR([yamlParsed.document!]);
      const yamlIR = yamlOutput.agents['TestAgent'];

      const legacyParsed = parseAgentBasedABL(LEGACY_REASONING_AGENT);
      expect(legacyParsed.errors).toHaveLength(0);
      const legacyOutput = compileABLtoIR([legacyParsed.document!]);
      const legacyIR = legacyOutput.agents['TestAgent'];

      // Core properties must match
      expect(yamlIR.metadata.name).toBe(legacyIR.metadata.name);

      expect(yamlIR.identity.goal).toBe(legacyIR.identity.goal);
      expect(yamlIR.identity.persona).toBe(legacyIR.identity.persona);
    });
  });
});
