/**
 * Guardrail Compilation Tests
 *
 * Tests the compiler's transformation of parsed GuardrailDefinition (DSL)
 * into the expanded Guardrail IR shape:
 * - Tier inference (local, model, llm)
 * - 'both' expansion into input + output
 * - Kind preservation (input, output, tool_input, tool_output, handoff)
 * - Priority (explicit and default 100)
 * - Action mapping (all 7 action types)
 * - Fix/reask/filter action details
 * - Streaming field preservation
 * - Model-based fields (provider, category, threshold)
 * - LLM-based fields (llmCheck)
 */
import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../../platform/ir/compiler.js';

describe('Guardrail Compilation', () => {
  // =============================================================================
  // TIER INFERENCE
  // =============================================================================

  describe('Tier inference', () => {
    test('CEL-only guardrail infers tier=local', () => {
      const dsl = `
AGENT: Tier_Local

GOAL: "Test tier inference"

GUARDRAILS:
  cel_guard:
    kind: input
    check: "size(input) < 1000"
    action: block
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['Tier_Local'];
      const guard = agent.constraints.guardrails[0];

      expect(guard.tier).toBe('local');
      expect(guard.check).toBe('size(input) < 1000');
    });

    test('Provider-based guardrail infers tier=model', () => {
      const dsl = `
AGENT: Tier_Model

GOAL: "Test model tier"

GUARDRAILS:
  model_guard:
    kind: input
    provider: openai_moderation
    category: hate
    threshold: 0.8
    action: block
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['Tier_Model'];
      const guard = agent.constraints.guardrails[0];

      expect(guard.tier).toBe('model');
      expect(guard.provider).toBe('openai_moderation');
      expect(guard.category).toBe('hate');
      expect(guard.threshold).toBe(0.8);
      // Model tier guardrails have no check expression
      expect(guard.check).toBeUndefined();
    });

    test('LLM-check guardrail infers tier=llm', () => {
      const dsl = `
AGENT: Tier_LLM

GOAL: "Test llm tier"

GUARDRAILS:
  llm_guard:
    kind: output
    llm_check: "Does this response contain medical advice?"
    action: warn
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['Tier_LLM'];
      const guard = agent.constraints.guardrails[0];

      expect(guard.tier).toBe('llm');
      expect(guard.llmCheck).toBe('Does this response contain medical advice?');
      expect(guard.check).toBeUndefined();
    });

    test('Provider takes precedence over llm_check for tier inference', () => {
      const dsl = `
AGENT: Tier_Precedence

GOAL: "Test precedence"

GUARDRAILS:
  dual_guard:
    kind: input
    provider: custom_safety
    llm_check: "Is this safe?"
    action: block
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['Tier_Precedence'];
      const guard = agent.constraints.guardrails[0];

      // provider → model tier takes precedence
      expect(guard.tier).toBe('model');
    });
  });

  // =============================================================================
  // BOTH EXPANSION
  // =============================================================================

  describe('Both expansion', () => {
    test('kind=both expands to input + output', () => {
      const dsl = `
AGENT: Both_Expand

GOAL: "Test both expansion"

GUARDRAILS:
  safety_check:
    kind: both
    check: "is_safe(content)"
    action: warn
    message: "Content safety check"
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      // Parser should still have 'both'
      expect(result.document!.guardrails![0].kind).toBe('both');

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['Both_Expand'];
      const guardrails = agent.constraints.guardrails;

      // Compiler should expand to 2 guardrails
      expect(guardrails).toHaveLength(2);
      expect(guardrails[0].kind).toBe('input');
      expect(guardrails[1].kind).toBe('output');

      // Both should preserve all other fields
      for (const g of guardrails) {
        expect(g.name).toBe('safety_check');
        expect(g.check).toBe('is_safe(content)');
        expect(g.action.type).toBe('warn');
        expect(g.action.message).toBe('Content safety check');
        expect(g.tier).toBe('local');
      }
    });

    test('both expansion works alongside non-both guardrails', () => {
      const dsl = `
AGENT: Both_Mixed

GOAL: "Test mixed"

GUARDRAILS:
  input_only:
    kind: input
    check: "check_input(input)"
    action: block

  both_check:
    kind: both
    check: "general_check(text)"
    action: warn

  output_only:
    kind: output
    check: "check_output(output)"
    action: redact
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['Both_Mixed'];
      const guardrails = agent.constraints.guardrails;

      // 1 input_only + 2 from both_check expansion + 1 output_only = 4
      expect(guardrails).toHaveLength(4);
      const kinds = guardrails.map((g: { kind: string }) => g.kind);
      // input_only(input), both_check→input, both_check→output, output_only(output)
      expect(kinds).toEqual(['input', 'input', 'output', 'output']);
    });
  });

  // =============================================================================
  // KIND PRESERVATION
  // =============================================================================

  describe('Kind preservation', () => {
    test('tool_input kind is preserved', () => {
      const dsl = `
AGENT: Tool_Input_Kind

GOAL: "Test tool_input"

GUARDRAILS:
  tool_param_check:
    kind: tool_input
    check: "validate_params(params)"
    action: block
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['Tool_Input_Kind'];
      expect(agent.constraints.guardrails[0].kind).toBe('tool_input');
    });

    test('tool_output kind is preserved', () => {
      const dsl = `
AGENT: Tool_Output_Kind

GOAL: "Test tool_output"

GUARDRAILS:
  tool_result_check:
    kind: tool_output
    check: "validate_result(result)"
    action: warn
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['Tool_Output_Kind'];
      expect(agent.constraints.guardrails[0].kind).toBe('tool_output');
    });

    test('handoff kind is preserved', () => {
      const dsl = `
AGENT: Handoff_Kind

GOAL: "Test handoff"

GUARDRAILS:
  handoff_check:
    kind: handoff
    check: "can_handoff(context)"
    action: block
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['Handoff_Kind'];
      expect(agent.constraints.guardrails[0].kind).toBe('handoff');
    });
  });

  // =============================================================================
  // PRIORITY
  // =============================================================================

  describe('Priority', () => {
    test('explicit priority is preserved', () => {
      const dsl = `
AGENT: Priority_Explicit

GOAL: "Test priority"

GUARDRAILS:
  high_priority:
    kind: input
    check: "check_high(input)"
    action: block
    priority: 10

  low_priority:
    kind: input
    check: "check_low(input)"
    action: warn
    priority: 500
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['Priority_Explicit'];
      const guardrails = agent.constraints.guardrails;

      const high = guardrails.find((g: { name: string }) => g.name === 'high_priority');
      const low = guardrails.find((g: { name: string }) => g.name === 'low_priority');
      expect(high!.priority).toBe(10);
      expect(low!.priority).toBe(500);
    });

    test('default priority is 100', () => {
      const dsl = `
AGENT: Priority_Default

GOAL: "Test default priority"

GUARDRAILS:
  no_priority:
    kind: input
    check: "check(input)"
    action: warn
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['Priority_Default'];
      expect(agent.constraints.guardrails[0].priority).toBe(100);
    });
  });

  // =============================================================================
  // ACTION MAPPING
  // =============================================================================

  describe('Action mapping', () => {
    test('all 7 action types map correctly', () => {
      const actions = ['block', 'warn', 'redact', 'escalate', 'fix', 'reask', 'filter'];

      for (const actionType of actions) {
        const dsl = `
AGENT: Action_${actionType}

GOAL: "Test ${actionType} action"

GUARDRAILS:
  test_guard:
    kind: input
    check: "check(input)"
    action: ${actionType}
`;
        const result = parseAgentBasedABL(dsl);
        expect(result.errors).toHaveLength(0);

        const output = compileABLtoIR([result.document!]);
        const agent = output.agents[`Action_${actionType}`];
        expect(agent.constraints.guardrails[0].action.type).toBe(actionType);
      }
    });

    test('warn maps to warn (not respond)', () => {
      const dsl = `
AGENT: Warn_Action

GOAL: "Test warn fix"

GUARDRAILS:
  warn_guard:
    kind: output
    check: "check_output(output)"
    action: warn
    message: "Warning message"
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['Warn_Action'];
      const guard = agent.constraints.guardrails[0];

      // This was the old bug: warn was mapped to 'respond'
      expect(guard.action.type).toBe('warn');
      expect(guard.action.type).not.toBe('respond');
    });

    test('fix action includes fixStrategy and fixExpression', () => {
      const dsl = `
AGENT: Fix_Action

GOAL: "Test fix action"

GUARDRAILS:
  fix_guard:
    kind: output
    check: "has_html(output)"
    action: fix
    fix_strategy: strip_html
    fix_expression: "strip_tags(output)"
    message: "Stripping HTML from output"
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['Fix_Action'];
      const guard = agent.constraints.guardrails[0];

      expect(guard.action.type).toBe('fix');
      expect(guard.action.fixStrategy).toBe('strip_html');
      expect(guard.action.fixExpression).toBe('strip_tags(output)');
      expect(guard.action.message).toBe('Stripping HTML from output');
    });

    test('reask action includes maxReasks', () => {
      const dsl = `
AGENT: Reask_Action

GOAL: "Test reask action"

GUARDRAILS:
  reask_guard:
    kind: output
    check: "is_relevant(output)"
    action: reask
    max_reasks: 3
    message: "Output not relevant, retrying"
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['Reask_Action'];
      const guard = agent.constraints.guardrails[0];

      expect(guard.action.type).toBe('reask');
      expect(guard.action.maxReasks).toBe(3);
    });

    test('filter action includes filterMinLength', () => {
      const dsl = `
AGENT: Filter_Action

GOAL: "Test filter action"

GUARDRAILS:
  filter_guard:
    kind: output
    check: "contains_noise(output)"
    action: filter
    filter_min_length: 10
    message: "Filtering noisy content"
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['Filter_Action'];
      const guard = agent.constraints.guardrails[0];

      expect(guard.action.type).toBe('filter');
      expect(guard.action.filterMinLength).toBe(10);
    });
  });

  // =============================================================================
  // STREAMING
  // =============================================================================

  describe('Streaming fields', () => {
    test('streaming and streamingInterval are preserved', () => {
      const dsl = `
AGENT: Streaming_Guard

GOAL: "Test streaming"

GUARDRAILS:
  stream_guard:
    kind: output
    check: "is_safe(chunk)"
    action: block
    streaming: true
    streaming_interval: sentence
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['Streaming_Guard'];
      const guard = agent.constraints.guardrails[0];

      expect(guard.streaming).toBe(true);
      expect(guard.streamingInterval).toBe('sentence');
    });

    test('streaming defaults to undefined when not specified', () => {
      const dsl = `
AGENT: No_Streaming

GOAL: "Test no streaming"

GUARDRAILS:
  basic_guard:
    kind: input
    check: "check(input)"
    action: warn
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['No_Streaming'];
      const guard = agent.constraints.guardrails[0];

      expect(guard.streaming).toBeUndefined();
      expect(guard.streamingInterval).toBeUndefined();
    });
  });

  // =============================================================================
  // DESCRIPTION
  // =============================================================================

  describe('Description', () => {
    test('description uses message when available', () => {
      const dsl = `
AGENT: Desc_Message

GOAL: "Test description"

GUARDRAILS:
  desc_guard:
    kind: input
    check: "check(input)"
    action: warn
    message: "Custom description"
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['Desc_Message'];
      expect(agent.constraints.guardrails[0].description).toBe('Custom description');
    });

    test('description falls back to generated text when no message', () => {
      const dsl = `
AGENT: Desc_Fallback

GOAL: "Test description fallback"

GUARDRAILS:
  no_msg_guard:
    kind: input
    check: "check(input)"
    action: warn
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['Desc_Fallback'];
      expect(agent.constraints.guardrails[0].description).toBe('Guardrail: no_msg_guard');
    });
  });

  // =============================================================================
  // EMPTY / EDGE CASES
  // =============================================================================

  describe('Edge cases', () => {
    test('no guardrails section produces empty array', () => {
      const dsl = `
AGENT: No_Guards

GOAL: "No guardrails"
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['No_Guards'];
      expect(agent.constraints.guardrails).toHaveLength(0);
    });

    test('guardrail without check field still compiles (model/llm tier)', () => {
      const dsl = `
AGENT: No_Check

GOAL: "Test no check"

GUARDRAILS:
  model_guard:
    kind: input
    provider: openai_moderation
    action: block
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['No_Check'];
      const guard = agent.constraints.guardrails[0];

      expect(guard.name).toBe('model_guard');
      expect(guard.check).toBeUndefined();
      expect(guard.tier).toBe('model');
    });

    test('unknown action type defaults to warn', () => {
      const dsl = `
AGENT: Unknown_Action

GOAL: "Test unknown action"

GUARDRAILS:
  bad_action:
    kind: input
    check: "check(input)"
    action: unknown_action_type
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const output = compileABLtoIR([result.document!]);
      const agent = output.agents['Unknown_Action'];
      expect(agent.constraints.guardrails[0].action.type).toBe('warn');
    });
  });
});
