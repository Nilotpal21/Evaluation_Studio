/**
 * Validation Integration Tests
 *
 * Tests that validation runs as part of compileABLtoIR()
 * and that diagnostics appear in CompilationOutput.
 */

import { describe, test, expect } from 'vitest';
import { validateIR } from '../platform/ir/validate-ir.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';
import type { AgentIR } from '../platform/ir/schema.js';

/**
 * Build a minimal agent IR to test the full validateIR orchestrator.
 */
function makeAgent(name: string): AgentIR {
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
    tools: [
      {
        name: 'my_tool',
        description: 'Execute my tool operation',
        parameters: [],
        returns: { type: 'object' },
        hints: {} as any,
      },
    ],
    gather: {
      fields: [
        { name: 'destination', prompt: '', type: 'string', required: true, extraction_hints: [] },
      ],
      strategy: 'pattern',
    },
    memory: {
      session: [{ name: 'need_help', type: 'boolean' }],
      persistent: [],
      remember: [],
      recall: [],
    },
    constraints: { constraints: [], guardrails: [] },
    coordination: {
      delegates: [],
      handoffs: [{ to: 'support_agent', when: 'need_help', context: { pass: [] } }],
    },
    completion: { conditions: [{ when: 'destination != ""' }] },
    error_handling: { handlers: [], default_handler: {} as any },
    messages: {} as any,
    flow: {
      steps: ['greet', 'collect', 'confirm'],
      entry_point: 'greet',
      definitions: {
        greet: { name: 'greet', call: 'my_tool', then: 'collect' } as any,
        collect: { name: 'collect', respond: 'Collecting info', then: 'confirm' } as any,
        confirm: { name: 'confirm', respond: 'Done' } as any,
      },
    },
  } as AgentIR;
}

describe('validateIR integration', () => {
  test('valid agent with all references produces no diagnostics', () => {
    const agent = makeAgent('booking_agent');
    const support = makeAgent('support_agent');
    const diags = validateIR(agent, [agent, support]);
    expect(diags).toEqual([]);
  });

  test('agent with multiple issues returns combined diagnostics', () => {
    const agent = makeAgent('booking_agent');
    // Break: flow reference
    (agent.flow!.definitions.greet as any).then = 'nonexistent_step';
    // Break: tool reference
    (agent.flow!.definitions.collect as any).call = 'nonexistent_tool';
    // Break: handoff target (support_agent won't be in allAgents)
    const diags = validateIR(agent, [agent]);
    // Should have at least: DANGLING_STEP_REF + UNDEFINED_TOOL_CALL + INVALID_HANDOFF_TARGET
    expect(diags.length).toBeGreaterThanOrEqual(3);
    const codes = diags.map((d) => d.code);
    expect(codes).toContain('DANGLING_STEP_REF');
    expect(codes).toContain('UNDEFINED_TOOL_CALL');
    expect(codes).toContain('INVALID_HANDOFF_TARGET');
  });

  test('agent with self-handoff returns SELF_HANDOFF_TARGET', () => {
    const agent = makeAgent('booking_agent');
    agent.coordination = {
      delegates: [],
      handoffs: [{ to: 'booking_agent', when: 'always', context: { pass: [] } }],
    };

    const diags = validateIR(agent, [agent]);

    expect(diags.some((d) => d.code === VALIDATION_CODES.SELF_HANDOFF_TARGET)).toBe(true);
  });

  test('warns when SET targets a reserved variable name', () => {
    const agent = makeAgent('booking_agent');
    const support = makeAgent('support_agent');
    // Add a SET action targeting the reserved 'match' variable
    (agent.flow!.definitions.greet as any).set = [
      { variable: 'match', expression: '"some_value"' },
    ];
    const diags = validateIR(agent, [agent, support]);
    const reserved = diags.filter((d) => d.code === 'RESERVED_VARIABLE_NAME');
    expect(reserved).toHaveLength(1);
    expect(reserved[0].severity).toBe('warning');
    expect(reserved[0].message).toContain('match');
    expect(reserved[0].message).toContain('system-reserved');
  });

  test('does not warn for non-reserved SET variable names', () => {
    const agent = makeAgent('booking_agent');
    const support = makeAgent('support_agent');
    (agent.flow!.definitions.greet as any).set = [{ variable: 'total_price', expression: '100' }];
    const diags = validateIR(agent, [agent, support]);
    const reserved = diags.filter((d) => d.code === 'RESERVED_VARIABLE_NAME');
    expect(reserved).toHaveLength(0);
  });

  test('warnings and errors are correctly classified', () => {
    const agent = makeAgent('booking_agent');
    // Add constraint with unknown variable (warning)
    agent.constraints = {
      constraints: [
        { condition: 'unknown_var == "test"', on_fail: { type: 'respond', message: 'fail' } },
      ],
      guardrails: [],
    };
    // Break: missing step (error)
    (agent.flow!.definitions.greet as any).then = 'missing';

    const support = makeAgent('support_agent');
    const diags = validateIR(agent, [agent, support]);
    const errors = diags.filter((d) => d.severity === 'error');
    const warnings = diags.filter((d) => d.severity === 'warning');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  test('flags REMEMBER targets that are undeclared or read-only persistent paths', () => {
    const agent = makeAgent('booking_agent');
    const support = makeAgent('support_agent');

    agent.memory = {
      session: [],
      persistent: [
        {
          path: 'user.favorite_airline',
          scope: 'user',
          access: 'read',
          sensitive: true,
          sensitive_display: 'mask',
          mask_config: { show_first: 0, show_last: 4, char: '*' },
        },
      ],
      remember: [
        {
          when: 'destination IS SET',
          store: { value: 'destination', target: 'user.undeclared_preference' },
        },
        {
          when: 'destination IS SET',
          store: { value: 'destination', target: 'user.favorite_airline' },
        },
      ],
      recall: [],
    };

    const diags = validateIR(agent, [agent, support]);

    expect(
      diags.some(
        (d) =>
          d.code === VALIDATION_CODES.INVALID_PERSISTENT_MEMORY_REF &&
          d.path === 'memory.remember[0].store.target',
      ),
    ).toBe(true);
    expect(
      diags.some(
        (d) =>
          d.code === VALIDATION_CODES.INVALID_PERSISTENT_MEMORY_ACCESS &&
          d.path === 'memory.remember[1].store.target',
      ),
    ).toBe(true);
  });

  test('flags RECALL inject_context paths that are undeclared or write-only', () => {
    const agent = makeAgent('booking_agent');
    const support = makeAgent('support_agent');

    agent.memory = {
      session: [],
      persistent: [
        {
          path: 'user.write_only_profile',
          scope: 'user',
          access: 'write',
        },
      ],
      remember: [],
      recall: [
        {
          event: 'session:start',
          instruction: 'Load preferences',
          action: {
            type: 'inject_context',
            paths: ['user.unknown_profile', 'user.write_only_profile'],
          },
        },
      ],
    };

    const diags = validateIR(agent, [agent, support]);

    expect(
      diags.some(
        (d) =>
          d.code === VALIDATION_CODES.INVALID_PERSISTENT_MEMORY_REF &&
          d.path === 'memory.recall[0].action.paths[0]',
      ),
    ).toBe(true);
    expect(
      diags.some(
        (d) =>
          d.code === VALIDATION_CODES.INVALID_PERSISTENT_MEMORY_ACCESS &&
          d.path === 'memory.recall[0].action.paths[1]',
      ),
    ).toBe(true);
  });

  test('runs coordination config and delegate input validators as part of validateIR', () => {
    const agent = makeAgent('booking_agent');
    const support = makeAgent('support_agent');

    agent.coordination = {
      handoffs: [
        {
          to: 'support_agent',
          when: 'need_help',
          context: { pass: [], summary: 'Route to support' },
          return: true,
          timeout: 'forever',
          on_return: { action: 'complete' },
        },
      ],
      delegates: [
        {
          agent: 'support_agent',
          when: 'need_help',
          purpose: 'Collect supporting details',
          input: { formatted: 'abl.upper(user.name)' },
          returns: {},
          use_result: 'delegate_result',
          on_failure: 'continue',
        },
      ],
    };

    const diags = validateIR(agent, [agent, support]);

    expect(
      diags.some(
        (d) =>
          d.code === VALIDATION_CODES.INVALID_TIMEOUT_SYNTAX &&
          d.path === 'coordination.handoffs[0].timeout',
      ),
    ).toBe(true);
    expect(
      diags.some(
        (d) =>
          d.code === VALIDATION_CODES.UNSUPPORTED_HANDOFF_ON_RETURN_ACTION &&
          d.path === 'coordination.handoffs[0].on_return.action',
      ),
    ).toBe(true);
    expect(
      diags.some(
        (d) =>
          d.code === VALIDATION_CODES.CEL_IN_INPUT_MAPPING &&
          d.path === 'coordination.delegates[0].input.formatted',
      ),
    ).toBe(true);
  });

  test('flags self-targeting routing defaults as part of validateIR preflight validation', () => {
    const agent = makeAgent('booking_agent');
    const support = makeAgent('support_agent');

    agent.routing = {
      rules: [
        {
          to: 'support_agent',
          when: 'true',
          description: 'Route to support',
          priority: 1,
        },
      ],
      default_agent: 'booking_agent',
      intent_classification: { categories: [], min_confidence: 0.5, source: 'inferred' as const },
    };

    const diags = validateIR(agent, [agent, support]);

    expect(
      diags.some(
        (d) =>
          d.code === VALIDATION_CODES.SELF_ROUTING_TARGET && d.path === 'routing.default_agent',
      ),
    ).toBe(true);
  });
});
