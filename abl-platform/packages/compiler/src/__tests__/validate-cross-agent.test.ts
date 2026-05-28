/**
 * Cross-Agent Reference Validator Tests
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import { validateCrossAgentRefs } from '../platform/ir/validate-cross-agent.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';
import type { AgentIR } from '../platform/ir/schema.js';

function makeAgent(name: string, overrides?: Partial<AgentIR>): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name,
      version: '1.0.0',
      type: 'agent',
      compiled_at: '',
      source_hash: '',
      compiler_version: '1.0.0',
    },
    execution: { hints: {} as any, timeouts: {} as any }, // mode deprecated — derived from flow presence
    identity: { goal: '', persona: '', limitations: [], system_prompt: {} as any },
    tools: [],
    gather: { fields: [], strategy: 'pattern' },
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: { delegates: [], handoffs: [], ...overrides?.coordination },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_handler: {} as any, ...overrides?.error_handling },
    messages: {} as any,
    routing: overrides?.routing,
    on_start: overrides?.on_start,
    ...overrides,
  } as AgentIR;
}

describe('validateCrossAgentRefs', () => {
  const booking = makeAgent('booking_agent');
  const support = makeAgent('support_agent');
  const allAgents = [booking, support];

  test('valid handoff targets produce no diagnostics', () => {
    const supervisor = makeAgent('supervisor', {
      coordination: {
        delegates: [],
        handoffs: [{ to: 'booking_agent', when: 'intent.booking', context: { pass: [] } }],
      },
    });
    expect(validateCrossAgentRefs(supervisor, [...allAgents, supervisor])).toEqual([]);
  });

  test('INVALID_HANDOFF_TARGET for nonexistent handoff target', () => {
    const supervisor = makeAgent('supervisor', {
      coordination: {
        delegates: [],
        handoffs: [{ to: 'ghost_agent', when: 'always', context: { pass: [] } }],
      },
    });
    const diags = validateCrossAgentRefs(supervisor, [...allAgents, supervisor]);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe(VALIDATION_CODES.INVALID_HANDOFF_TARGET);
    expect(diags[0].severity).toBe('error');
    expect(diags[0].message).toContain('ghost_agent');
    expect(diags[0]).toMatchObject({ referenced_agent: 'ghost_agent' });
  });

  test('SELF_HANDOFF_TARGET for self-handoff target', () => {
    const supervisor = makeAgent('supervisor', {
      coordination: {
        delegates: [],
        handoffs: [{ to: 'supervisor', when: 'always', context: { pass: [] } }],
      },
    });
    const diags = validateCrossAgentRefs(supervisor, [...allAgents, supervisor]);
    expect(diags).toContainEqual(
      expect.objectContaining({
        code: VALIDATION_CODES.SELF_HANDOFF_TARGET,
        path: 'coordination.handoffs[0].to',
        severity: 'error',
      }),
    );
  });

  test('INVALID_DELEGATE_TARGET for nonexistent delegate agent', () => {
    const agent = makeAgent('main_agent', {
      coordination: {
        handoffs: [],
        delegates: [{ agent: 'missing_agent', when: 'need_help', purpose: 'help' }],
      },
    });
    const diags = validateCrossAgentRefs(agent, [...allAgents, agent]);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe(VALIDATION_CODES.INVALID_DELEGATE_TARGET);
    expect(diags[0]).toMatchObject({ referenced_agent: 'missing_agent' });
  });

  test('SELF_DELEGATE_TARGET for self-delegate target', () => {
    const agent = makeAgent('main_agent', {
      coordination: {
        handoffs: [],
        delegates: [{ agent: 'main_agent', when: 'need_help', purpose: 'help' }],
      },
    });
    const diags = validateCrossAgentRefs(agent, [...allAgents, agent]);
    expect(diags).toContainEqual(
      expect.objectContaining({
        code: VALIDATION_CODES.SELF_DELEGATE_TARGET,
        path: 'coordination.delegates[0].agent',
        severity: 'error',
      }),
    );
  });

  test('INVALID_ROUTING_TARGET for nonexistent routing rule target', () => {
    const supervisor = makeAgent('supervisor', {
      routing: {
        rules: [{ to: 'nowhere_agent', when: 'always', description: 'test', priority: 1 }],
        default_agent: 'fallback',
        intent_classification: { categories: [], min_confidence: 0.5, source: 'inferred' as const },
      },
    });
    const diags = validateCrossAgentRefs(supervisor, [...allAgents, supervisor]);
    expect(diags.some((d) => d.code === VALIDATION_CODES.INVALID_ROUTING_TARGET)).toBe(true);
  });

  test('INVALID_ROUTING_TARGET for nonexistent supervisor available_agents entry', () => {
    const supervisor = makeAgent('supervisor', {
      available_agents: ['booking_agent', 'ghost_agent'],
    });
    const diags = validateCrossAgentRefs(supervisor, [...allAgents, supervisor]);

    expect(diags).toContainEqual(
      expect.objectContaining({
        code: VALIDATION_CODES.INVALID_ROUTING_TARGET,
        path: 'available_agents[1]',
        severity: 'error',
      }),
    );
  });

  test('SELF_ROUTING_TARGET for supervisor available_agents entry that points to self', () => {
    const supervisor = makeAgent('supervisor', {
      available_agents: ['supervisor'],
    });
    const diags = validateCrossAgentRefs(supervisor, [...allAgents, supervisor]);

    expect(diags).toContainEqual(
      expect.objectContaining({
        code: VALIDATION_CODES.SELF_ROUTING_TARGET,
        path: 'available_agents[0]',
        severity: 'error',
      }),
    );
  });

  test('SELF_ROUTING_TARGET for routing rule that points to self', () => {
    const supervisor = makeAgent('supervisor', {
      routing: {
        rules: [{ to: 'supervisor', when: 'always', description: 'loop', priority: 1 }],
        default_agent: 'booking_agent',
        intent_classification: { categories: [], min_confidence: 0.5, source: 'inferred' as const },
      },
    });
    const diags = validateCrossAgentRefs(supervisor, [...allAgents, supervisor]);

    expect(diags).toContainEqual(
      expect.objectContaining({
        code: VALIDATION_CODES.SELF_ROUTING_TARGET,
        path: 'routing.rules[0].to',
        severity: 'error',
        referenced_agent: 'supervisor',
      }),
    );
  });

  test('INVALID_HANDOFF_TARGET for constraint handoff target that is missing from compilation', () => {
    const agent = makeAgent('main_agent', {
      constraints: {
        constraints: [
          {
            condition: 'needs_escalation',
            on_fail: { type: 'handoff', target: 'missing_agent include the raw reason' },
          },
        ],
        guardrails: [],
      } as any,
    });
    const diags = validateCrossAgentRefs(agent, [...allAgents, agent]);

    expect(diags).toContainEqual(
      expect.objectContaining({
        code: VALIDATION_CODES.INVALID_HANDOFF_TARGET,
        path: 'constraints[0].on_fail.target',
        severity: 'error',
        referenced_agent: 'missing_agent',
      }),
    );
  });

  test('SELF_HANDOFF_TARGET for constraint handoff target that resolves to self', () => {
    const agent = makeAgent('main_agent', {
      constraints: {
        constraints: [
          {
            condition: 'needs_escalation',
            on_fail: { type: 'handoff', target: 'main_agent include the raw reason' },
          },
        ],
        guardrails: [],
      } as any,
    });
    const diags = validateCrossAgentRefs(agent, [...allAgents, agent]);

    expect(diags).toContainEqual(
      expect.objectContaining({
        code: VALIDATION_CODES.SELF_HANDOFF_TARGET,
        path: 'constraints[0].on_fail.target',
        severity: 'error',
        referenced_agent: 'main_agent',
      }),
    );
  });

  test('INVALID_DELEGATE_TARGET for on_start.delegate', () => {
    const agent = makeAgent('main_agent', {
      on_start: { delegate: 'phantom_agent' } as any,
    });
    const diags = validateCrossAgentRefs(agent, [...allAgents, agent]);
    expect(diags.some((d) => d.code === VALIDATION_CODES.INVALID_DELEGATE_TARGET)).toBe(true);
  });

  test('INVALID_HANDOFF_TARGET for error_handling.handoff_target', () => {
    const agent = makeAgent('main_agent', {
      error_handling: {
        handlers: [{ type: 'tool_error', then: 'handoff', handoff_target: 'missing_agent' }],
        default_handler: {} as any,
      },
    });
    const diags = validateCrossAgentRefs(agent, [...allAgents, agent]);
    expect(diags.some((d) => d.code === VALIDATION_CODES.INVALID_HANDOFF_TARGET)).toBe(true);
  });

  test('remote handoffs are excluded (not flagged)', () => {
    const agent = makeAgent('main_agent', {
      coordination: {
        delegates: [],
        handoffs: [
          {
            to: 'external_agent',
            when: 'always',
            context: { pass: [] },
            remote: { location: 'remote', endpoint: 'https://example.com' },
          },
        ],
      },
    });
    // external_agent doesn't exist in allAgents, but it's remote so should be skipped
    expect(validateCrossAgentRefs(agent, [agent])).toEqual([]);
  });

  test('supervisor routing metadata inherits remote handoff targets without local existence errors', () => {
    const supervisor = makeAgent('supervisor', {
      available_agents: ['external_agent'],
      routing: {
        rules: [{ to: 'external_agent', when: 'always', description: 'route remote', priority: 1 }],
        default_agent: 'external_agent',
        intent_classification: { categories: [], min_confidence: 0.5, source: 'inferred' as const },
      },
      coordination: {
        delegates: [],
        handoffs: [
          {
            to: 'external_agent',
            when: 'always',
            context: { pass: [] },
            remote: { location: 'remote', endpoint: 'https://example.com' },
          },
        ],
      },
    });

    expect(validateCrossAgentRefs(supervisor, [supervisor])).toEqual([]);
  });

  test('remote delegates are excluded (not flagged)', () => {
    const agent = makeAgent('main_agent', {
      coordination: {
        handoffs: [],
        delegates: [
          {
            agent: 'external_delegate',
            when: 'always',
            purpose: 'help',
            remote: { location: 'remote', endpoint: 'https://example.com' },
          },
        ],
      },
    });
    expect(validateCrossAgentRefs(agent, [agent])).toEqual([]);
  });

  test('remote handoff still rejects self-targeting even when existence checks are skipped', () => {
    const agent = makeAgent('main_agent', {
      coordination: {
        delegates: [],
        handoffs: [
          {
            to: 'main_agent',
            when: 'always',
            context: { pass: [] },
            remote: { location: 'remote', endpoint: 'https://example.com' },
          },
        ],
      },
    });
    const diags = validateCrossAgentRefs(agent, [agent]);

    expect(diags).toContainEqual(
      expect.objectContaining({
        code: VALIDATION_CODES.SELF_HANDOFF_TARGET,
        path: 'coordination.handoffs[0].to',
        severity: 'error',
      }),
    );
  });

  test('errors when HANDOFF ON_RETURN maps a child field the target cannot produce', () => {
    const parent = makeAgent('parent_agent', {
      coordination: {
        delegates: [],
        handoffs: [
          {
            to: 'child_agent',
            when: 'always',
            context: { pass: [] },
            return: true,
            on_return: { map: { missing_child_field: 'parent_status' } },
          },
        ],
      },
    });
    const child = makeAgent('child_agent', {
      gather: {
        fields: [
          {
            name: 'known_child_field',
            prompt: 'Known',
            type: 'string',
            required: true,
            extraction_hints: [],
          },
        ],
        strategy: 'pattern',
      },
    });

    const diags = validateCrossAgentRefs(parent, [parent, child]);

    expect(diags).toContainEqual(
      expect.objectContaining({
        code: VALIDATION_CODES.UNKNOWN_HANDOFF_RETURN_FIELD,
        path: 'coordination.handoffs[0].on_return.map.missing_child_field',
        referenced_agent: 'child_agent',
        severity: 'error',
      }),
    );
  });

  test('compiler routes invalid HANDOFF ON_RETURN child keys to compilation_errors', () => {
    const parentDsl = `
AGENT: ParentAgent
GOAL: "Route to a specialist"

HANDOFF:
  - TO: ChildAgent
    WHEN: always
    RETURN: true
    ON_RETURN:
      MAP:
        missing_child_field: parent_status
    CONTEXT:
      pass: []
      summary: "Route to child"
`;

    const childDsl = `
AGENT: ChildAgent
GOAL: "Handle specialist work"

GATHER:
  known_child_field:
    type: string
    prompt: "Known field"
`;

    const parent = parseAgentBasedABL(parentDsl);
    const child = parseAgentBasedABL(childDsl);

    expect(parent.errors).toHaveLength(0);
    expect(child.errors).toHaveLength(0);

    const output = compileABLtoIR([parent.document!, child.document!]);

    expect(output.compilation_errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.UNKNOWN_HANDOFF_RETURN_FIELD,
          path: 'coordination.handoffs[0].on_return.map.missing_child_field',
          referenced_agent: 'ChildAgent',
          severity: 'error',
        }),
      ]),
    );
    expect(output.compilation_warnings ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.UNKNOWN_HANDOFF_RETURN_FIELD,
        }),
      ]),
    );
  });

  test('accepts HANDOFF ON_RETURN keys produced by child state', () => {
    const parent = makeAgent('parent_agent', {
      coordination: {
        delegates: [],
        handoffs: [
          {
            to: 'child_agent',
            when: 'always',
            context: { pass: [] },
            return: true,
            on_return: { map: { child_status: 'parent_status' } },
          },
        ],
      },
    });
    const child = makeAgent('child_agent', {
      flow: {
        steps: ['done'],
        entry_point: 'done',
        definitions: {
          done: {
            name: 'done',
            set: [{ variable: 'child_status', expression: '"complete"' }],
            then: 'COMPLETE',
          },
        },
      },
    });

    expect(validateCrossAgentRefs(parent, [parent, child])).toEqual([]);
  });

  test('warns when DELEGATE RETURNS maps a child field the target cannot produce', () => {
    const parent = makeAgent('parent_agent', {
      coordination: {
        handoffs: [],
        delegates: [
          {
            agent: 'child_agent',
            when: 'always',
            purpose: 'Assess request',
            input: {},
            returns: { missing_score: 'parent_score' },
            use_result: 'delegate_result',
            on_failure: 'continue',
          },
        ],
      },
    });
    const child = makeAgent('child_agent', {
      memory: {
        session: [{ name: 'known_score', description: 'Known score' }],
        persistent: [],
        remember: [],
        recall: [],
      },
    });

    const diags = validateCrossAgentRefs(parent, [parent, child]);

    expect(diags).toContainEqual(
      expect.objectContaining({
        code: VALIDATION_CODES.UNKNOWN_DELEGATE_RETURN_FIELD,
        path: 'coordination.delegates[0].returns.missing_score',
        referenced_agent: 'child_agent',
        severity: 'warning',
      }),
    );
  });

  test('valid ON_ACTION handoff target declared in coordination produces no diagnostics', () => {
    const supervisor = makeAgent('supervisor', {
      coordination: {
        delegates: [],
        handoffs: [{ to: 'booking_agent', when: 'always', context: { pass: [] } }],
      },
      flow: {
        entry_point: 'menu',
        definitions: {
          menu: {
            on_action: [{ action_id: 'book', do: [{ handoff: 'booking_agent' }] }],
          },
        },
      } as any,
    });

    expect(validateCrossAgentRefs(supervisor, [...allAgents, supervisor])).toEqual([]);
  });

  test('INVALID_HANDOFF_TARGET for ON_ACTION handoff target not declared in coordination', () => {
    const supervisor = makeAgent('supervisor', {
      coordination: { delegates: [], handoffs: [] },
      flow: {
        entry_point: 'menu',
        definitions: {
          menu: {
            on_action: [{ action_id: 'book', do: [{ handoff: 'booking_agent' }] }],
          },
        },
      } as any,
    });

    const diags = validateCrossAgentRefs(supervisor, [...allAgents, supervisor]);
    expect(diags).toContainEqual(
      expect.objectContaining({
        code: VALIDATION_CODES.INVALID_HANDOFF_TARGET,
        path: 'flow.steps.menu.on_action[0].do[0].handoff',
        severity: 'error',
        referenced_agent: 'booking_agent',
      }),
    );
  });

  test('INVALID_DELEGATE_TARGET for ON_ACTION delegate target not declared in coordination', () => {
    const agent = makeAgent('main_agent', {
      coordination: { delegates: [], handoffs: [] },
      flow: {
        entry_point: 'menu',
        definitions: {
          menu: {
            on_action: [{ action_id: 'help', do: [{ delegate: 'support_agent' }] }],
          },
        },
      } as any,
    });

    const diags = validateCrossAgentRefs(agent, [...allAgents, agent]);
    expect(diags).toContainEqual(
      expect.objectContaining({
        code: VALIDATION_CODES.INVALID_DELEGATE_TARGET,
        path: 'flow.steps.menu.on_action[0].do[0].delegate',
        severity: 'error',
        referenced_agent: 'support_agent',
      }),
    );
  });

  test('no diagnostics when no cross-agent references exist', () => {
    const agent = makeAgent('standalone');
    expect(validateCrossAgentRefs(agent, [agent])).toEqual([]);
  });

  test('compiles EXECUTION.pipeline config into IR execution settings', () => {
    const dsl = `
SUPERVISOR: Travel_Supervisor

GOAL: "Route customer inquiries to the right specialist agent"

EXECUTION:
  pipeline:
    enabled: true
    mode: parallel
    model: "gpt-4.1-mini"
    shortCircuit:
      enabled: true
      confidenceThreshold: 0.92
    toolFilter:
      enabled: true
      maxTools: 3
    keywordVeto:
      enabled: true
      keywords: ["refund", "fraud"]
    intentBridge:
      enabled: true
      programmaticThreshold: 0.8
      guidedThreshold: 0.65
      outOfScopeDecline: false
      multiIntentSignal: true
`;

    const parseResult = parseAgentBasedABL(dsl);
    expect(parseResult.errors).toHaveLength(0);
    expect(parseResult.document).not.toBeNull();

    const output = compileABLtoIR([parseResult.document!]);
    expect(output.compilation_errors).toBeUndefined();

    expect(output.agents.Travel_Supervisor.execution.pipeline).toEqual({
      enabled: true,
      mode: 'parallel',
      model: 'gpt-4.1-mini',
      shortCircuit: {
        enabled: true,
        confidenceThreshold: 0.92,
      },
      toolFilter: {
        enabled: true,
        maxTools: 3,
      },
      keywordVeto: {
        enabled: true,
        keywords: ['refund', 'fraud'],
      },
      intentBridge: {
        enabled: true,
        programmaticThreshold: 0.8,
        guidedThreshold: 0.65,
        outOfScopeDecline: false,
        multiIntentSignal: true,
      },
    });
  });
});
