/**
 * Flow Graph Validator Tests
 *
 * Tests validateFlowGraph for step connectivity, entry point validation,
 * orphan detection, and duplicate step names.
 */

import { describe, test, expect } from 'vitest';
import { validateFlowGraph, validateIR } from '../platform/ir/validate-ir.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';
import type { AgentIR, FlowStep } from '../platform/ir/schema.js';

/** Helper to create a minimal scripted AgentIR with flow */
function makeAgent(overrides: {
  steps?: string[];
  entryPoint?: string;
  definitions?: Record<string, Partial<FlowStep>>;
  mode?: string;
}): AgentIR {
  const steps = overrides.steps ?? ['step_a', 'step_b'];
  const definitions: Record<string, FlowStep> = {};
  if (overrides.definitions) {
    for (const [name, partial] of Object.entries(overrides.definitions)) {
      definitions[name] = { name, ...partial } as FlowStep;
    }
  } else {
    definitions.step_a = { name: 'step_a', then: 'step_b' } as FlowStep;
    definitions.step_b = { name: 'step_b' } as FlowStep;
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
    execution: {
      hints: {} as any,
      timeouts: {} as any,
    },
    identity: { goal: '', persona: '', limitations: [], system_prompt: {} as any },
    tools: [],
    gather: { fields: [], strategy: 'pattern' },
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: { delegates: [], handoffs: [] },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_handler: {} as any },
    messages: {} as any,
    flow: {
      steps,
      entry_point: overrides.entryPoint ?? steps[0],
      definitions,
    },
  } as AgentIR;
}

describe('validateFlowGraph', () => {
  test('valid flow produces no diagnostics', () => {
    const agent = makeAgent({
      steps: ['greet', 'collect', 'confirm'],
      entryPoint: 'greet',
      definitions: {
        greet: { then: 'collect' },
        collect: { then: 'confirm' },
        confirm: {},
      },
    });
    expect(validateFlowGraph(agent)).toEqual([]);
  });

  test('MISSING_ENTRY_POINT when entry_point references nonexistent step', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'nonexistent',
      definitions: { step_a: {} },
    });
    const diags = validateFlowGraph(agent);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe(VALIDATION_CODES.MISSING_ENTRY_POINT);
    expect(diags[0].severity).toBe('error');
  });

  test('DANGLING_STEP_REF for then target', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'step_a',
      definitions: {
        step_a: { then: 'nonexistent' },
      },
    });
    const diags = validateFlowGraph(agent);
    const dangling = diags.filter((d) => d.code === VALIDATION_CODES.DANGLING_STEP_REF);
    expect(dangling.length).toBeGreaterThanOrEqual(1);
    expect(dangling[0].severity).toBe('error');
    expect(dangling[0].path).toContain('step_a');
  });

  test('DANGLING_STEP_REF for on_fail target', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'step_a',
      definitions: {
        step_a: { on_fail: 'missing_step' },
      },
    });
    const diags = validateFlowGraph(agent);
    const dangling = diags.filter((d) => d.code === VALIDATION_CODES.DANGLING_STEP_REF);
    expect(dangling.length).toBeGreaterThanOrEqual(1);
    expect(dangling[0].message).toContain('missing_step');
  });

  test('DANGLING_STEP_REF for ON_ACTION GOTO target', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'step_a',
      definitions: {
        step_a: {
          on_action: [{ action_id: 'go', do: [{ goto: 'missing_step' }] }],
        },
      },
    });
    const diags = validateFlowGraph(agent);
    expect(diags).toContainEqual(
      expect.objectContaining({
        code: VALIDATION_CODES.DANGLING_STEP_REF,
        path: 'flow.steps.step_a.on_action[0].do[0].goto',
        severity: 'error',
      }),
    );
  });

  test('treats lowercase COMPLETE as a terminal target', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'step_a',
      definitions: {
        step_a: { then: 'complete' },
      },
    });

    const diags = validateFlowGraph(agent);
    expect(diags.some((d) => d.code === VALIDATION_CODES.DANGLING_STEP_REF)).toBe(false);
  });

  test('treats ESCALATE as a terminal target', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'step_a',
      definitions: {
        step_a: { then: 'ESCALATE' },
      },
    });

    const diags = validateFlowGraph(agent);
    expect(diags.some((d) => d.code === VALIDATION_CODES.DANGLING_STEP_REF)).toBe(false);
  });

  test('treats ESCALATE with REASON as a terminal target', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'step_a',
      definitions: {
        step_a: { then: 'ESCALATE with REASON: "Needs human support"' },
      },
    });

    const diags = validateFlowGraph(agent);
    expect(diags.some((d) => d.code === VALIDATION_CODES.DANGLING_STEP_REF)).toBe(false);
  });

  test('DANGLING_STEP_REF for on_input branch then', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'step_a',
      definitions: {
        step_a: {
          on_input: [{ then: 'ghost_step' }],
        },
      },
    });
    const diags = validateFlowGraph(agent);
    const dangling = diags.filter((d) => d.code === VALIDATION_CODES.DANGLING_STEP_REF);
    expect(dangling.length).toBeGreaterThanOrEqual(1);
  });

  test('DANGLING_STEP_REF for on_success.then and on_failure.then', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'step_a',
      definitions: {
        step_a: {
          on_success: { then: 'missing_a' },
          on_failure: { then: 'missing_b' },
        },
      },
    });
    const diags = validateFlowGraph(agent);
    const dangling = diags.filter((d) => d.code === VALIDATION_CODES.DANGLING_STEP_REF);
    expect(dangling.length).toBe(2);
  });

  test('DANGLING_STEP_REF for on_result branch then', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'step_a',
      definitions: {
        step_a: {
          on_result: [{ then: 'nowhere', condition: 'result.ok' }],
        },
      },
    });
    const diags = validateFlowGraph(agent);
    expect(diags.some((d) => d.code === VALIDATION_CODES.DANGLING_STEP_REF)).toBe(true);
  });

  test('DANGLING_STEP_REF for on_success.branches[].then', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'step_a',
      definitions: {
        step_a: {
          on_success: {
            branches: [{ then: 'missing_branch_target', condition: 'x > 1' }],
          },
        },
      },
    });
    const diags = validateFlowGraph(agent);
    expect(diags.some((d) => d.code === VALIDATION_CODES.DANGLING_STEP_REF)).toBe(true);
  });

  test('DANGLING_STEP_REF for digression goto', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'step_a',
      definitions: {
        step_a: {
          digressions: [{ intent: 'cancel', goto: 'no_such_step' }],
        },
      },
    });
    const diags = validateFlowGraph(agent);
    expect(diags.some((d) => d.code === VALIDATION_CODES.DANGLING_STEP_REF)).toBe(true);
  });

  test('validateIR flags constraint goto_step references to nonexistent steps', () => {
    const agent = makeAgent({
      steps: ['step_a', 'step_b'],
      entryPoint: 'step_a',
      definitions: {
        step_a: { then: 'step_b' },
        step_b: {},
      },
    });
    agent.constraints = {
      constraints: [
        {
          condition: 'destination IS SET',
          on_fail: {
            type: 'goto_step',
            then_step: 'missing_step',
          },
        } as AgentIR['constraints']['constraints'][number],
      ],
      guardrails: [],
    };

    const diags = validateIR(agent, [agent]);

    expect(
      diags.some(
        (d) =>
          d.code === VALIDATION_CODES.DANGLING_STEP_REF &&
          d.path === 'constraints[0].on_fail.then_step',
      ),
    ).toBe(true);
  });

  test('validateIR flags constraint collect_field gather and step targets', () => {
    const agent = makeAgent({
      steps: ['step_a', 'step_b'],
      entryPoint: 'step_a',
      definitions: {
        step_a: { then: 'step_b' },
        step_b: {},
      },
    });
    agent.constraints = {
      constraints: [
        {
          condition: 'destination IS SET',
          on_fail: {
            type: 'collect_field',
            collect_fields: ['missing_budget'],
            then_step: 'missing_step',
          },
        } as AgentIR['constraints']['constraints'][number],
      ],
      guardrails: [],
    };

    const diags = validateIR(agent, [agent]);

    expect(
      diags.some(
        (d) =>
          d.code === VALIDATION_CODES.INVALID_CONSTRAINT_COLLECT_FIELD &&
          d.path === 'constraints[0].on_fail.collect_fields[0]',
      ),
    ).toBe(true);
    expect(
      diags.some(
        (d) =>
          d.code === VALIDATION_CODES.DANGLING_STEP_REF &&
          d.path === 'constraints[0].on_fail.then_step',
      ),
    ).toBe(true);
  });

  test('ORPHANED_STEP for unreachable step (warning)', () => {
    const agent = makeAgent({
      steps: ['step_a', 'step_b', 'orphan'],
      entryPoint: 'step_a',
      definitions: {
        step_a: { then: 'step_b' },
        step_b: {},
        orphan: {},
      },
    });
    const diags = validateFlowGraph(agent);
    const orphans = diags.filter((d) => d.code === VALIDATION_CODES.ORPHANED_STEP);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].severity).toBe('warning');
    expect(orphans[0].message).toContain('orphan');
  });

  test('EMPTY_FLOW when scripted agent has no flow steps (warning)', () => {
    const agent = makeAgent({
      steps: [],
      entryPoint: undefined as any,
      definitions: {},
    });
    // Remove flow entry_point since there are no steps
    agent.flow!.entry_point = undefined;
    const diags = validateFlowGraph(agent);
    expect(diags.some((d) => d.code === VALIDATION_CODES.EMPTY_FLOW)).toBe(true);
    expect(diags.find((d) => d.code === VALIDATION_CODES.EMPTY_FLOW)?.severity).toBe('warning');
  });

  test('skips validation for interactive mode agents', () => {
    const agent = makeAgent({ mode: 'interactive' });
    const diags = validateFlowGraph(agent);
    expect(diags).toEqual([]);
  });

  test('skips validation when flow is undefined', () => {
    const agent = makeAgent({});
    agent.flow = undefined;
    const diags = validateFlowGraph(agent);
    expect(diags).toEqual([]);
  });
});
