/**
 * Pre-flight Validator Tests
 *
 * Tests for validateSupervisorReasoningStep, validateReasoningZoneModel,
 * validateFlowStepActions, validateDefaultRoutingTarget, and runPreflightValidation.
 */

import { describe, test, expect } from 'vitest';
import {
  validateSupervisorReasoningStep,
  validateReasoningZoneModel,
  validateFlowStepActions,
  validateDefaultRoutingTarget,
  runPreflightValidation,
} from '../platform/ir/validate-preflight.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';
import type { AgentIR, FlowStep } from '../platform/ir/schema.js';

/**
 * Creates a minimal valid AgentIR with overridable fields.
 * Only populates fields the pre-flight validators actually read.
 */
function makeAgentIR(
  overrides: Partial<{
    type: 'agent' | 'supervisor';
    model: string | undefined;
    routing: AgentIR['routing'];
    flow: AgentIR['flow'];
    coordination: AgentIR['coordination'];
  }> = {},
): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'test_agent',
      version: '1.0.0',
      type: overrides.type ?? 'agent',
      compiled_at: '',
      source_hash: '',
      compiler_version: '1.0.0',
    },
    execution: {
      model: overrides.model,
      hints: {} as any,
      timeouts: {} as any,
    },
    identity: { goal: '', persona: '', limitations: [], system_prompt: {} as any },
    tools: [],
    gather: { fields: [], strategy: 'pattern' },
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: overrides.coordination ?? { delegates: [], handoffs: [] },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_handler: {} as any },
    messages: {} as any,
    flow: overrides.flow,
    routing: overrides.routing,
  } as AgentIR;
}

/** Shorthand to build a FlowConfig with definitions */
function makeFlow(defs: Record<string, Partial<FlowStep>>): AgentIR['flow'] {
  const names = Object.keys(defs);
  const definitions: Record<string, FlowStep> = {};
  for (const [name, partial] of Object.entries(defs)) {
    definitions[name] = { name, ...partial } as FlowStep;
  }
  return {
    steps: names,
    entry_point: names[0],
    definitions,
  };
}

// =============================================================================
// validateSupervisorReasoningStep
// =============================================================================

describe('validateSupervisorReasoningStep', () => {
  test('PASS: supervisor with routing and at least one reasoning-enabled step', () => {
    const agent = makeAgentIR({
      type: 'supervisor',
      routing: { rules: [], default_agent: 'child', intent_classification: {} as any },
      flow: makeFlow({
        greet: { reasoning_zone: { instructions: '' } as any },
        collect: {},
      }),
    });
    expect(validateSupervisorReasoningStep(agent, 'sup')).toEqual([]);
  });

  test('PASS: non-supervisor agent is skipped', () => {
    const agent = makeAgentIR({
      type: 'agent',
      routing: { rules: [], default_agent: 'x', intent_classification: {} as any },
      flow: makeFlow({ step: {} }),
    });
    expect(validateSupervisorReasoningStep(agent, 'a')).toEqual([]);
  });

  test('PASS: supervisor with no routing is skipped', () => {
    const agent = makeAgentIR({
      type: 'supervisor',
      routing: undefined,
      flow: makeFlow({ step: {} }),
    });
    expect(validateSupervisorReasoningStep(agent, 'sup')).toEqual([]);
  });

  test('FAIL: supervisor with routing but ALL steps have reasoning_zone = null/undefined', () => {
    const agent = makeAgentIR({
      type: 'supervisor',
      routing: { rules: [], default_agent: 'child', intent_classification: {} as any },
      flow: makeFlow({
        step_a: {},
        step_b: { reasoning_zone: undefined },
      }),
    });
    const diags = validateSupervisorReasoningStep(agent, 'sup');
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe(VALIDATION_CODES.SUPERVISOR_NO_REASONING_STEP);
    expect(diags[0].severity).toBe('error');
    expect(diags[0].agent).toBe('sup');
    expect(diags[0].path).toBe('flow');
  });

  test('EDGE: supervisor with routing but no flow definitions (no flow)', () => {
    const agent = makeAgentIR({
      type: 'supervisor',
      routing: { rules: [], default_agent: 'child', intent_classification: {} as any },
      flow: undefined,
    });
    expect(validateSupervisorReasoningStep(agent, 'sup')).toEqual([]);
  });

  test('EDGE: supervisor with routing and empty definitions', () => {
    const agent = makeAgentIR({
      type: 'supervisor',
      routing: { rules: [], default_agent: 'child', intent_classification: {} as any },
      flow: makeFlow({}),
    });
    // No steps means steps.some() is false → emits error
    // But with 0 steps, hasReasoningStep is false, so it should emit
    const diags = validateSupervisorReasoningStep(agent, 'sup');
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe(VALIDATION_CODES.SUPERVISOR_NO_REASONING_STEP);
  });
});

// =============================================================================
// validateReasoningZoneModel
// =============================================================================

describe('validateReasoningZoneModel', () => {
  test('PASS: agent with execution.model set', () => {
    const agent = makeAgentIR({
      model: 'gpt-4',
      flow: makeFlow({
        step: { reasoning_zone: { instructions: '' } as any },
      }),
    });
    expect(validateReasoningZoneModel(agent, 'a')).toEqual([]);
  });

  test('PASS: agent with no reasoning zones', () => {
    const agent = makeAgentIR({
      model: undefined,
      flow: makeFlow({
        step_a: {},
        step_b: {},
      }),
    });
    expect(validateReasoningZoneModel(agent, 'a')).toEqual([]);
  });

  test('WARN: agent with reasoning zone but no execution.model', () => {
    const agent = makeAgentIR({
      model: undefined,
      flow: makeFlow({
        collect: { reasoning_zone: { instructions: 'think' } as any },
        greet: {},
      }),
    });
    const diags = validateReasoningZoneModel(agent, 'myagent');
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe(VALIDATION_CODES.REASONING_ZONE_NO_MODEL);
    expect(diags[0].severity).toBe('warning');
    expect(diags[0].agent).toBe('myagent');
    expect(diags[0].path).toBe('flow.steps.collect.reasoning_zone');
    expect(diags[0].message).toContain('collect');
  });

  test('WARN: multiple reasoning zones without model emits multiple warnings', () => {
    const agent = makeAgentIR({
      model: undefined,
      flow: makeFlow({
        step_a: { reasoning_zone: { instructions: '' } as any },
        step_b: { reasoning_zone: { instructions: '' } as any },
      }),
    });
    const diags = validateReasoningZoneModel(agent, 'a');
    expect(diags).toHaveLength(2);
    expect(diags.every((d) => d.code === VALIDATION_CODES.REASONING_ZONE_NO_MODEL)).toBe(true);
  });

  test('EDGE: agent with no flow', () => {
    const agent = makeAgentIR({ flow: undefined });
    expect(validateReasoningZoneModel(agent, 'a')).toEqual([]);
  });
});

// =============================================================================
// validateFlowStepActions
// =============================================================================

describe('validateFlowStepActions', () => {
  test('PASS: step with reasoning_zone', () => {
    const agent = makeAgentIR({
      flow: makeFlow({ step: { reasoning_zone: { instructions: '' } as any } }),
    });
    expect(validateFlowStepActions(agent, 'a')).toEqual([]);
  });

  test('PASS: step with gather', () => {
    const agent = makeAgentIR({
      flow: makeFlow({ step: { gather: { fields: [] } as any } }),
    });
    expect(validateFlowStepActions(agent, 'a')).toEqual([]);
  });

  test('PASS: step with respond', () => {
    const agent = makeAgentIR({
      flow: makeFlow({ step: { respond: 'Hello!' } }),
    });
    expect(validateFlowStepActions(agent, 'a')).toEqual([]);
  });

  test('PASS: step with call', () => {
    const agent = makeAgentIR({
      flow: makeFlow({ step: { call: 'some_tool' } as any }),
    });
    expect(validateFlowStepActions(agent, 'a')).toEqual([]);
  });

  test('PASS: step with set', () => {
    const agent = makeAgentIR({
      flow: makeFlow({ step: { set: [{ variable: 'x', expression: '1' }] } as any }),
    });
    expect(validateFlowStepActions(agent, 'a')).toEqual([]);
  });

  test('PASS: step with transform', () => {
    const agent = makeAgentIR({
      flow: makeFlow({ step: { transform: {} } as any }),
    });
    expect(validateFlowStepActions(agent, 'a')).toEqual([]);
  });

  test('PASS: step with human_approval', () => {
    const agent = makeAgentIR({
      flow: makeFlow({ step: { human_approval: {} } as any }),
    });
    expect(validateFlowStepActions(agent, 'a')).toEqual([]);
  });

  test('WARN: step with NO actions at all', () => {
    const agent = makeAgentIR({
      flow: makeFlow({ empty_step: {} }),
    });
    const diags = validateFlowStepActions(agent, 'myagent');
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe(VALIDATION_CODES.FLOW_STEP_NO_ACTION);
    expect(diags[0].severity).toBe('warning');
    expect(diags[0].agent).toBe('myagent');
    expect(diags[0].path).toBe('flow.steps.empty_step');
    expect(diags[0].message).toContain('empty_step');
  });

  test('WARN: multiple empty steps emit multiple warnings', () => {
    const agent = makeAgentIR({
      flow: makeFlow({ noop_a: {}, noop_b: {} }),
    });
    const diags = validateFlowStepActions(agent, 'a');
    expect(diags).toHaveLength(2);
    expect(diags.every((d) => d.code === VALIDATION_CODES.FLOW_STEP_NO_ACTION)).toBe(true);
  });

  test('EDGE: agent with no flow', () => {
    const agent = makeAgentIR({ flow: undefined });
    expect(validateFlowStepActions(agent, 'a')).toEqual([]);
  });
});

// =============================================================================
// validateDefaultRoutingTarget
// =============================================================================

describe('validateDefaultRoutingTarget', () => {
  test('PASS: routing.default_agent exists in allAgentNames', () => {
    const agent = makeAgentIR({
      routing: { rules: [], default_agent: 'billing', intent_classification: {} as any },
    });
    const diags = validateDefaultRoutingTarget(agent, 'sup', ['billing', 'support']);
    expect(diags).toEqual([]);
  });

  test('PASS: no routing', () => {
    const agent = makeAgentIR({ routing: undefined });
    expect(validateDefaultRoutingTarget(agent, 'a', ['x'])).toEqual([]);
  });

  test('PASS: routing with no default_agent', () => {
    const agent = makeAgentIR({
      routing: { rules: [], default_agent: '', intent_classification: {} as any },
    });
    // empty string is falsy, so it returns early
    expect(validateDefaultRoutingTarget(agent, 'a', ['x'])).toEqual([]);
  });

  test('PASS: routing.default_agent can point to a remote handoff target', () => {
    const agent = makeAgentIR({
      routing: { rules: [], default_agent: 'remote_agent', intent_classification: {} as any },
      coordination: {
        handoffs: [
          {
            to: 'remote_agent',
            when: 'always',
            context: { pass: [] },
            remote: { location: 'remote', endpoint: 'https://example.com' },
          },
        ],
        delegates: [],
      } as any,
    });

    expect(validateDefaultRoutingTarget(agent, 'sup', [])).toEqual([]);
  });

  test('FAIL: routing.default_agent not in allAgentNames', () => {
    const agent = makeAgentIR({
      routing: { rules: [], default_agent: 'ghost', intent_classification: {} as any },
    });
    const diags = validateDefaultRoutingTarget(agent, 'sup', ['billing', 'support']);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe(VALIDATION_CODES.INVALID_DEFAULT_ROUTING_TARGET);
    expect(diags[0].severity).toBe('error');
    expect(diags[0].agent).toBe('sup');
    expect(diags[0].path).toBe('routing.default_agent');
    expect(diags[0].message).toContain('ghost');
    expect(diags[0].message).toContain('billing');
  });

  test('PASS: singleAgentScope suppresses missing default_agent validation', () => {
    const agent = makeAgentIR({
      routing: { rules: [], default_agent: 'ghost', intent_classification: {} as any },
    });
    const diags = validateDefaultRoutingTarget(agent, 'sup', [], { singleAgentScope: true });
    expect(diags).toEqual([]);
  });

  test('FAIL: routing.default_agent cannot point to the current agent', () => {
    const agent = makeAgentIR({
      routing: { rules: [], default_agent: 'sup', intent_classification: {} as any },
    });
    const diags = validateDefaultRoutingTarget(agent, 'sup', ['sup', 'billing']);

    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe(VALIDATION_CODES.SELF_ROUTING_TARGET);
    expect(diags[0].severity).toBe('error');
    expect(diags[0].path).toBe('routing.default_agent');
    expect(diags[0]).toMatchObject({ referenced_agent: 'sup' });
  });

  test('EDGE: empty allAgentNames list', () => {
    const agent = makeAgentIR({
      routing: { rules: [], default_agent: 'any', intent_classification: {} as any },
    });
    const diags = validateDefaultRoutingTarget(agent, 'sup', []);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe(VALIDATION_CODES.INVALID_DEFAULT_ROUTING_TARGET);
    expect(diags[0].message).toContain('(none)');
  });
});

// =============================================================================
// runPreflightValidation (integration)
// =============================================================================

describe('runPreflightValidation', () => {
  test('aggregates diagnostics from all validators', () => {
    // Supervisor with routing, no reasoning steps, no model, one empty step
    const agent = makeAgentIR({
      type: 'supervisor',
      model: undefined,
      routing: { rules: [], default_agent: 'ghost', intent_classification: {} as any },
      flow: makeFlow({ empty_step: {} }),
    });
    const diags = runPreflightValidation(agent, 'sup', ['billing']);
    const codes = diags.map((d) => d.code);
    expect(codes).toContain(VALIDATION_CODES.SUPERVISOR_NO_REASONING_STEP);
    expect(codes).toContain(VALIDATION_CODES.FLOW_STEP_NO_ACTION);
    expect(codes).toContain(VALIDATION_CODES.INVALID_DEFAULT_ROUTING_TARGET);
  });

  test('clean agent produces no diagnostics', () => {
    const agent = makeAgentIR({
      type: 'agent',
      model: 'gpt-4',
      flow: makeFlow({
        greet: { respond: 'Hello' },
      }),
    });
    expect(runPreflightValidation(agent, 'a', ['a'])).toEqual([]);
  });
});
