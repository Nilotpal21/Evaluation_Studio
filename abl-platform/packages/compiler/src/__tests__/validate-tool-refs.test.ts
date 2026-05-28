/**
 * Tool Reference Validator Tests
 *
 * Tests validateToolReferences catches undefined tool calls
 * across all IR locations.
 */

import { describe, test, expect } from 'vitest';
import { validateToolReferences } from '../platform/ir/validate-ir.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';
import type { AgentIR, FlowStep, ToolDefinition } from '../platform/ir/schema.js';

/** Helper: create a minimal AgentIR with specified tools and flow */
function makeAgent(opts: {
  tools?: string[];
  mode?: string;
  steps?: Record<string, Partial<FlowStep>>;
  hooks?: Record<string, { call?: string }>;
  onStart?: { call?: string };
  globalDigressions?: Array<{ intent: string; call?: string }>;
}): AgentIR {
  const tools: ToolDefinition[] = (opts.tools ?? []).map((name) => ({
    name,
    description: `Tool ${name}`,
    parameters: [],
    returns: { type: 'object' },
    hints: {} as any,
  }));

  const definitions: Record<string, FlowStep> = {};
  if (opts.steps) {
    for (const [name, partial] of Object.entries(opts.steps)) {
      definitions[name] = { name, ...partial } as FlowStep;
    }
  }

  return {
    ir_version: '1.0',
    metadata: {
      name: 'test_agent',
      version: '1.0.0',
      type: 'agent',
      compiled_at: '',
      source_hash: '',
      compiler_version: '1.0.0',
    },
    // mode is deprecated — execution style derived from flow presence
    execution: { hints: {} as any, timeouts: {} as any },
    identity: { goal: '', persona: '', limitations: [], system_prompt: {} as any },
    tools,
    gather: { fields: [], strategy: 'pattern' },
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: { delegates: [], handoffs: [] },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_handler: {} as any },
    messages: {} as any,
    flow:
      Object.keys(definitions).length > 0
        ? {
            steps: Object.keys(definitions),
            entry_point: Object.keys(definitions)[0],
            definitions,
            global_digressions: opts.globalDigressions as any,
          }
        : undefined,
    on_start: opts.onStart as any,
    hooks: opts.hooks as any,
  } as AgentIR;
}

describe('validateToolReferences', () => {
  test('valid tool references produce no diagnostics', () => {
    const agent = makeAgent({
      tools: ['lookup_order', 'send_email'],
      steps: {
        step_a: { call: 'lookup_order', then: 'step_b' },
        step_b: { call: 'send_email' },
      },
    });
    expect(validateToolReferences(agent)).toEqual([]);
  });

  test('UNDEFINED_TOOL_CALL for step.call', () => {
    const agent = makeAgent({
      tools: ['lookup_order'],
      steps: {
        step_a: { call: 'nonexistent_tool' },
      },
    });
    const diags = validateToolReferences(agent);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe(VALIDATION_CODES.UNDEFINED_TOOL_CALL);
    expect(diags[0].severity).toBe('error');
    expect(diags[0].message).toContain('nonexistent_tool');
  });

  test('UNDEFINED_TOOL_CALL for on_input[].call', () => {
    const agent = makeAgent({
      tools: [],
      steps: {
        step_a: { on_input: [{ then: 'step_a', call: 'bad_tool' }] },
      },
    });
    const diags = validateToolReferences(agent);
    expect(
      diags.some(
        (d) => d.code === VALIDATION_CODES.UNDEFINED_TOOL_CALL && d.message.includes('bad_tool'),
      ),
    ).toBe(true);
  });

  test('UNDEFINED_TOOL_CALL for ON_ACTION CALL action', () => {
    const agent = makeAgent({
      tools: [],
      steps: {
        step_a: {
          on_action: [
            { action_id: 'lookup', do: [{ call: 'missing_tool', result_key: 'result' }] },
          ],
        },
      },
    });
    const diags = validateToolReferences(agent);
    expect(diags).toContainEqual(
      expect.objectContaining({
        code: VALIDATION_CODES.UNDEFINED_TOOL_CALL,
        path: 'flow.steps.step_a.on_action[0].do[0].call',
        severity: 'error',
      }),
    );
  });

  test('UNDEFINED_TOOL_CALL for on_success.branches[].call', () => {
    const agent = makeAgent({
      tools: [],
      steps: {
        step_a: {
          on_success: {
            branches: [{ call: 'missing_tool', then: 'step_a', condition: 'x' }],
          },
        },
      },
    });
    const diags = validateToolReferences(agent);
    expect(diags.some((d) => d.code === VALIDATION_CODES.UNDEFINED_TOOL_CALL)).toBe(true);
  });

  test('UNDEFINED_TOOL_CALL for digressions[].call', () => {
    const agent = makeAgent({
      tools: [],
      steps: {
        step_a: {
          digressions: [{ intent: 'cancel', call: 'cancel_tool' }],
        },
      },
    });
    const diags = validateToolReferences(agent);
    expect(diags.some((d) => d.message.includes('cancel_tool'))).toBe(true);
  });

  test('UNDEFINED_TOOL_CALL for sub_intents[].call', () => {
    const agent = makeAgent({
      tools: [],
      steps: {
        step_a: {
          sub_intents: [{ intent: 'help', call: 'help_tool' }],
        },
      },
    });
    const diags = validateToolReferences(agent);
    expect(diags.some((d) => d.message.includes('help_tool'))).toBe(true);
  });

  test('UNDEFINED_TOOL_CALL for hooks.*.call', () => {
    const agent = makeAgent({
      tools: [],
      hooks: { before_turn: { call: 'hook_tool' } },
    });
    const diags = validateToolReferences(agent);
    expect(diags.some((d) => d.message.includes('hook_tool'))).toBe(true);
  });

  test('UNDEFINED_TOOL_CALL for on_start.call', () => {
    const agent = makeAgent({
      tools: [],
      onStart: { call: 'start_tool' },
    });
    const diags = validateToolReferences(agent);
    expect(diags.some((d) => d.message.includes('start_tool'))).toBe(true);
  });

  test('UNDEFINED_TOOL_CALL for call_spec-only references', () => {
    const agent = makeAgent({
      tools: [],
      steps: {
        step_a: {
          on_input: [{ then: 'step_a', call_spec: { tool: 'branch_tool', as: 'branchResult' } }],
          on_action: [
            {
              action_id: 'lookup',
              do: [{ call_spec: { tool: 'action_tool', as: 'actionResult' } }],
            },
          ],
          digressions: [
            {
              intent: 'help',
              do: [{ call_spec: { tool: 'digression_tool', as: 'digressionResult' } }],
            },
          ],
          sub_intents: [
            { intent: 'more', call_spec: { tool: 'sub_intent_tool', as: 'subResult' } },
          ],
        },
      },
      hooks: { before_turn: { call_spec: { tool: 'hook_tool' } } as any },
      onStart: { call_spec: { tool: 'start_tool' } } as any,
    });

    const diags = validateToolReferences(agent);
    expect(diags.some((d) => d.message.includes('branch_tool'))).toBe(true);
    expect(diags.some((d) => d.message.includes('action_tool'))).toBe(true);
    expect(diags.some((d) => d.message.includes('digression_tool'))).toBe(true);
    expect(diags.some((d) => d.message.includes('sub_intent_tool'))).toBe(true);
    expect(diags.some((d) => d.message.includes('hook_tool'))).toBe(true);
    expect(diags.some((d) => d.message.includes('start_tool'))).toBe(true);
  });

  test('UNDEFINED_TOOL_CALL for global_digressions[].call', () => {
    const agent = makeAgent({
      tools: [],
      globalDigressions: [{ intent: 'faq', call: 'faq_tool' }],
      steps: { step_a: {} },
    });
    const diags = validateToolReferences(agent);
    expect(diags.some((d) => d.message.includes('faq_tool'))).toBe(true);
  });

  test('system tools (starting with __) are not flagged', () => {
    // System tools like __handoff__, __delegate__ are auto-injected
    // and should not trigger UNDEFINED_TOOL_CALL
    const agent = makeAgent({
      tools: [],
      steps: {
        step_a: { call: '__handoff__' },
      },
    });
    // System tools are in agent.tools anyway (compiler adds them),
    // but even if they weren't, calls starting with __ should be skipped
    expect(validateToolReferences(agent)).toEqual([]);
  });

  test('no diagnostics when agent has no flow, hooks, or on_start', () => {
    const agent = makeAgent({ tools: [] });
    expect(validateToolReferences(agent)).toEqual([]);
  });
});
