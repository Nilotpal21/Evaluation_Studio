/**
 * Integration tests for validate-field-refs.ts — tool return field recognition
 * Tool Lifecycle: tool return type fields should be recognized as known variables
 */

import { describe, test, expect } from 'vitest';
import { validateFieldReferences } from '../platform/ir/validate-field-refs.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';
import type { AgentIR, FlowStep, ToolDefinition, ToolReturnType } from '../platform/ir/schema.js';

function makeTool(name: string, returns?: ToolReturnType): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    parameters: [],
    returns: returns ?? { type: 'object' },
    hints: {
      cacheable: false,
      latency: 'fast',
      parallelizable: false,
      side_effects: false,
      requires_auth: false,
    },
  };
}

function makeAgent(overrides?: {
  gatherFields?: string[];
  sessionVars?: string[];
  tools?: ToolDefinition[];
  steps?: Record<string, Partial<FlowStep>>;
  constraints?: Array<{ condition: string; on_fail: string }>;
}): AgentIR {
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
    execution: {
      hints: {} as AgentIR['execution']['hints'],
      timeouts: {} as AgentIR['execution']['timeouts'],
    },
    identity: {
      goal: '',
      persona: '',
      limitations: [],
      system_prompt: {} as AgentIR['identity']['system_prompt'],
    },
    tools: overrides?.tools ?? [],
    gather: {
      fields: (overrides?.gatherFields ?? []).map((name) => ({
        name,
        prompt: '',
        type: 'string',
        required: true,
        extraction_hints: [],
      })),
      strategy: 'pattern',
    },
    memory: {
      session: (overrides?.sessionVars ?? []).map((name) => ({ name, description: '' })),
      persistent: [],
      remember: [],
      recall: [],
    },
    constraints: {
      constraints: overrides?.constraints ?? [],
      guardrails: [],
    },
    coordination: { delegates: [], handoffs: [] },
    completion: { conditions: [] },
    error_handling: {
      handlers: [],
      default_handler: {} as AgentIR['error_handling']['default_handler'],
    },
    messages: {} as AgentIR['messages'],
    flow: overrides?.steps
      ? {
          steps: Object.keys(overrides.steps),
          entry_point: Object.keys(overrides.steps)[0],
          definitions: Object.fromEntries(
            Object.entries(overrides.steps).map(([name, s]) => [name, { name, ...s } as FlowStep]),
          ),
        }
      : undefined,
  } as AgentIR;
}

describe('validateFieldReferences — tool return fields', () => {
  test('tool return fields are recognized as known vars (no W750)', () => {
    const lookupTool = makeTool('lookup_order', {
      type: 'object',
      fields: {
        status: { type: 'string' },
        total: { type: 'number' },
        tracking_id: { type: 'string' },
      },
    });

    const agent = makeAgent({
      tools: [lookupTool],
      constraints: [
        { condition: 'status == "shipped"', on_fail: 'respond' },
        { condition: 'total > 100', on_fail: 'respond' },
      ],
    });

    const diags = validateFieldReferences(agent);
    // status and total come from tool return fields — should not be flagged
    const conditionDiags = diags.filter((d) => d.code === VALIDATION_CODES.UNDEFINED_CONDITION_VAR);
    expect(conditionDiags).toEqual([]);
  });

  test('unknown vars still produce W750 when tool returns dont match', () => {
    const lookupTool = makeTool('lookup_order', {
      type: 'object',
      fields: {
        status: { type: 'string' },
      },
    });

    const agent = makeAgent({
      tools: [lookupTool],
      constraints: [{ condition: 'unknown_field == "test"', on_fail: 'respond' }],
    });

    const diags = validateFieldReferences(agent);
    const conditionDiags = diags.filter((d) => d.code === VALIDATION_CODES.UNDEFINED_CONDITION_VAR);
    expect(conditionDiags).toHaveLength(1);
    expect(conditionDiags[0].message).toContain('unknown_field');
  });

  test('multiple tools contribute return fields to known vars', () => {
    const orderTool = makeTool('lookup_order', {
      type: 'object',
      fields: {
        order_status: { type: 'string' },
      },
    });
    const paymentTool = makeTool('check_payment', {
      type: 'object',
      fields: {
        payment_status: { type: 'string' },
      },
    });

    const agent = makeAgent({
      tools: [orderTool, paymentTool],
      constraints: [
        { condition: 'order_status == "confirmed"', on_fail: 'respond' },
        { condition: 'payment_status == "paid"', on_fail: 'respond' },
      ],
    });

    const diags = validateFieldReferences(agent);
    const conditionDiags = diags.filter((d) => d.code === VALIDATION_CODES.UNDEFINED_CONDITION_VAR);
    expect(conditionDiags).toEqual([]);
  });

  test('tool return fields work alongside gather fields and session vars', () => {
    const tool = makeTool('verify_email', {
      type: 'object',
      fields: {
        verified: { type: 'boolean' },
      },
    });

    const agent = makeAgent({
      gatherFields: ['user_email'],
      sessionVars: ['user_tier'],
      tools: [tool],
      constraints: [
        { condition: 'user_email != ""', on_fail: 'respond' },
        { condition: 'user_tier == "premium"', on_fail: 'respond' },
        { condition: 'verified == true', on_fail: 'respond' },
      ],
    });

    const diags = validateFieldReferences(agent);
    const conditionDiags = diags.filter((d) => d.code === VALIDATION_CODES.UNDEFINED_CONDITION_VAR);
    expect(conditionDiags).toEqual([]);
  });

  test('tools without return fields do not add any known vars', () => {
    const tool = makeTool('do_something', { type: 'string' });

    const agent = makeAgent({
      tools: [tool],
      constraints: [{ condition: 'some_var == "test"', on_fail: 'respond' }],
    });

    const diags = validateFieldReferences(agent);
    const conditionDiags = diags.filter((d) => d.code === VALIDATION_CODES.UNDEFINED_CONDITION_VAR);
    expect(conditionDiags).toHaveLength(1);
    expect(conditionDiags[0].message).toContain('some_var');
  });

  test('tool return fields used in flow step conditions are recognized', () => {
    const tool = makeTool('check_availability', {
      type: 'object',
      fields: {
        available: { type: 'boolean' },
        slots: { type: 'number' },
      },
    });

    const agent = makeAgent({
      tools: [tool],
      steps: {
        check_step: {
          check: 'available == true',
          complete_when: 'slots > 0',
          then: 'check_step',
        },
      },
    });

    const diags = validateFieldReferences(agent);
    const conditionDiags = diags.filter((d) => d.code === VALIDATION_CODES.UNDEFINED_CONDITION_VAR);
    expect(conditionDiags).toEqual([]);
  });
});
