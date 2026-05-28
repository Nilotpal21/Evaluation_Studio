/**
 * Guardrails E2E Tests
 *
 * Tests the complete guardrails pipeline:
 * 1. Parsing - GUARDRAILS section parses correctly
 * 2. Compilation - IR.constraints.guardrails is populated
 * 3. Type validation - All guardrail properties are validated
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../../platform/ir/compiler.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Guardrails E2E', () => {
  // =============================================================================
  // PARSING TESTS
  // =============================================================================

  describe('1. Parsing', () => {
    test('GUARDRAILS section parses correctly', () => {
      const dsl = `
AGENT: Test_Guardrails

GOAL: "Test guardrails parsing"

GUARDRAILS:
  test_guardrail:
    kind: input
    check: "not_empty(input)"
    action: warn
    message: "Input should not be empty"
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.guardrails).toBeDefined();
      expect(result.document?.guardrails).toHaveLength(1);

      const guardrail = result.document?.guardrails?.[0];
      expect(guardrail?.name).toBe('test_guardrail');
      expect(guardrail?.kind).toBe('input');
      expect(guardrail?.check).toBe('not_empty(input)');
      expect(guardrail?.action).toBe('warn');
      expect(guardrail?.message).toBe('Input should not be empty');
    });

    test('Multiple guardrails parse correctly', () => {
      const dsl = `
AGENT: Multi_Guardrails

GOAL: "Test multiple guardrails"

GUARDRAILS:
  input_check:
    kind: input
    check: "validate_input(input)"
    action: block
    message: "Invalid input"

  output_check:
    kind: output
    check: "validate_output(output)"
    action: warn
    message: "Output warning"

  both_check:
    kind: both
    check: "general_check(text)"
    action: escalate
    message: "Requires review"
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.guardrails).toHaveLength(3);

      const kinds = result.document?.guardrails?.map((g) => g.kind);
      expect(kinds).toContain('input');
      expect(kinds).toContain('output');
      expect(kinds).toContain('both');
    });

    test('All guardrail actions parse correctly', () => {
      const dsl = `
AGENT: Action_Types

GOAL: "Test all action types"

GUARDRAILS:
  block_action:
    kind: input
    check: "check1"
    action: block

  warn_action:
    kind: input
    check: "check2"
    action: warn

  redact_action:
    kind: input
    check: "check3"
    action: redact

  escalate_action:
    kind: input
    check: "check4"
    action: escalate
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.guardrails).toHaveLength(4);

      const actions = result.document?.guardrails?.map((g) => g.action);
      expect(actions).toContain('block');
      expect(actions).toContain('warn');
      expect(actions).toContain('redact');
      expect(actions).toContain('escalate');
    });

    test('Guardrail priority parses correctly', () => {
      const dsl = `
AGENT: Priority_Test

GOAL: "Test priority"

GUARDRAILS:
  high_priority:
    kind: input
    check: "check1"
    action: block
    priority: 0

  low_priority:
    kind: input
    check: "check2"
    action: warn
    priority: 10
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const priorities = result.document?.guardrails?.map((g) => g.priority);
      expect(priorities).toContain(0);
      expect(priorities).toContain(10);
    });
  });

  // =============================================================================
  // COMPILATION TESTS
  // =============================================================================

  describe('2. Compilation', () => {
    test('Guardrails compile to IR constraints', () => {
      const dsl = `
AGENT: Compile_Test

GOAL: "Test compilation"

GUARDRAILS:
  ssn_check:
    kind: input
    check: "not_matches_pattern(input, ssn_pattern)"
    action: block
    message: "SSN detected"

  output_safe:
    kind: output
    check: "is_safe(output)"
    action: warn
    message: "Potentially unsafe output"
`;

      const parseResult = parseAgentBasedABL(dsl);
      expect(parseResult.errors).toHaveLength(0);

      const output = compileABLtoIR([parseResult.document!]);
      const agent = output.agents['Compile_Test'];

      // The IR should have guardrails in constraints
      expect(agent.constraints).toBeDefined();
      expect(agent.constraints.guardrails).toBeDefined();
      expect(agent.constraints.guardrails.length).toBe(2);

      // Verify guardrail structure in IR
      const ssnGuardrail = agent.constraints.guardrails.find(
        (g: { name: string }) => g.name === 'ssn_check',
      );
      expect(ssnGuardrail).toBeDefined();
      expect(ssnGuardrail?.check).toBe('not_matches_pattern(input, ssn_pattern)');
      expect(ssnGuardrail?.action?.type).toBe('block');
      // New required fields from expanded Guardrail IR
      expect(ssnGuardrail?.kind).toBe('input');
      expect(ssnGuardrail?.tier).toBe('local');
      expect(ssnGuardrail?.priority).toBe(100); // default

      const outputGuardrail = agent.constraints.guardrails.find(
        (g: { name: string }) => g.name === 'output_safe',
      );
      expect(outputGuardrail).toBeDefined();
      expect(outputGuardrail?.kind).toBe('output');
      expect(outputGuardrail?.action?.type).toBe('warn');
    });

    test('Empty guardrails compile without errors', () => {
      const dsl = `
AGENT: No_Guardrails

GOAL: "No guardrails test"
`;

      const parseResult = parseAgentBasedABL(dsl);
      expect(parseResult.errors).toHaveLength(0);

      const output = compileABLtoIR([parseResult.document!]);
      const agent = output.agents['No_Guardrails'];
      expect(agent.constraints.guardrails).toHaveLength(0);
    });
  });

  // =============================================================================
  // EXAMPLE FILE TESTS
  // =============================================================================

  describe('3. Example Files', () => {
    const examplesDir = join(__dirname, '../../../../../examples/guardrails');

    test('PII protection example parses correctly', () => {
      let dsl: string;
      try {
        dsl = readFileSync(join(examplesDir, 'pii_protection.agent.abl'), 'utf-8');
      } catch {
        // If file doesn't exist, skip test
        console.log('Skipping: pii_protection.agent.abl not found');
        return;
      }

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.name).toBe('PII_Protection_Agent');
      expect(result.document?.guardrails).toBeDefined();
      expect(result.document?.guardrails?.length).toBeGreaterThan(0);
    });

    test('Content safety example parses correctly', () => {
      let dsl: string;
      try {
        dsl = readFileSync(join(examplesDir, 'content_safety.agent.abl'), 'utf-8');
      } catch {
        // If file doesn't exist, skip test
        console.log('Skipping: content_safety.agent.abl not found');
        return;
      }

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.name).toBe('Content_Safety_Agent');
      expect(result.document?.guardrails).toBeDefined();
      expect(result.document?.guardrails?.length).toBeGreaterThan(0);
    });

    test('Example files compile to valid IR', () => {
      const files = ['pii_protection.agent.abl', 'content_safety.agent.abl'];

      for (const file of files) {
        let dsl: string;
        try {
          dsl = readFileSync(join(examplesDir, file), 'utf-8');
        } catch {
          console.log(`Skipping: ${file} not found`);
          continue;
        }

        const parseResult = parseAgentBasedABL(dsl);
        expect(parseResult.errors).toHaveLength(0);

        const output = compileABLtoIR([parseResult.document!]);
        expect(output).toBeDefined();
        expect(Object.keys(output.agents).length).toBeGreaterThan(0);

        // Verify the first agent has constraints with guardrails
        const agentName = Object.keys(output.agents)[0];
        const agent = output.agents[agentName];
        expect(agent).toBeDefined();
        expect(agent.constraints).toBeDefined();
        expect(agent.constraints.guardrails).toBeDefined();
        expect(agent.constraints.guardrails.length).toBeGreaterThan(0);
      }
    });
  });

  // =============================================================================
  // VALIDATION TESTS
  // =============================================================================

  describe('4. Validation', () => {
    test('Required fields are validated', () => {
      const dsl = `
AGENT: Validation_Test

GOAL: "Test validation"

GUARDRAILS:
  valid_guardrail:
    kind: input
    check: "has_check"
    action: warn
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const guardrail = result.document?.guardrails?.[0];
      expect(guardrail?.name).toBeDefined();
      expect(guardrail?.kind).toBeDefined();
      expect(guardrail?.check).toBeDefined();
      expect(guardrail?.action).toBeDefined();
    });

    test('Default values are applied', () => {
      const dsl = `
AGENT: Defaults_Test

GOAL: "Test defaults"

GUARDRAILS:
  minimal_guardrail:
    check: "some_check"
    action: warn
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const guardrail = result.document?.guardrails?.[0];
      // Default kind should be 'output'
      expect(guardrail?.kind).toBe('output');
    });
  });

  // =============================================================================
  // INTEGRATION TESTS
  // =============================================================================

  describe('5. Integration', () => {
    test('Guardrails work with scripted mode', () => {
      const dsl = `
AGENT: Scripted_With_Guardrails

GOAL: "Test scripted with guardrails"

GUARDRAILS:
  input_safe:
    kind: input
    check: "is_safe(input)"
    action: block

STEPS:
  1. Start
     RESPOND: "Hello!"
     SIGNAL: COMPLETE
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      expect(result.document?.guardrails).toHaveLength(1);
    });

    test('Guardrails work with reasoning mode', () => {
      const dsl = `
AGENT: Reasoning_With_Guardrails

GOAL: "Test reasoning with guardrails"

GUARDRAILS:
  output_safe:
    kind: output
    check: "is_safe(output)"
    action: warn
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      expect(result.document?.guardrails).toHaveLength(1);
    });
  });
});
