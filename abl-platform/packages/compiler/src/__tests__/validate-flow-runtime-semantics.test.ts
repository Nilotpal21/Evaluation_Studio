import { describe, expect, test } from 'vitest';
import type { AgentIR, FlowStep } from '../platform/ir/schema.js';
import { validateIR } from '../platform/ir/validate-ir.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';

function createFlowAgent(stepName: string, step: FlowStep): AgentIR {
  return {
    metadata: {
      name: 'flow_runtime_semantics_agent',
      type: 'agent',
    },
    execution: {},
    tools: [],
    flow: {
      entry_point: stepName,
      definitions: {
        [stepName]: step,
      },
    },
  } as AgentIR;
}

describe('validateFlowRuntimeSemantics', () => {
  test('warns when FLOW step uses COMPLETE_WHEN', () => {
    const ir = createFlowAgent('collect', {
      name: 'collect',
      complete_when: 'destination IS SET',
      then: 'COMPLETE',
    });

    const diagnostics = validateIR(ir, [ir]);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.FLOW_COMPLETE_WHEN_RISK,
          severity: 'warning',
        }),
      ]),
    );
  });

  test('warns when FLOW step mixes GATHER with ON_INPUT branches', () => {
    const ir = createFlowAgent('collect', {
      name: 'collect',
      gather: {
        fields: [{ name: 'request', required: true }],
      },
      on_input: [{ condition: 'input contains "cancel"', then: 'COMPLETE' }, { then: 'COMPLETE' }],
    });

    const diagnostics = validateIR(ir, [ir]);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.FLOW_ON_INPUT_GATHER_ORDER_AMBIGUITY,
          severity: 'warning',
        }),
      ]),
    );
  });

  test('warns when reasoning steps also declare post-step mutations', () => {
    const ir = createFlowAgent('verify', {
      name: 'verify',
      reasoning_zone: {
        goal: 'Validate the user',
      },
      set: [{ variable: 'verified', expression: 'true' }],
      then: 'COMPLETE',
    });

    const diagnostics = validateIR(ir, [ir]);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.FLOW_REASONING_MUTATION_TIMING,
          severity: 'warning',
        }),
      ]),
    );
  });

  test('errors when ON_ACTION terminal action is followed by another action', () => {
    const ir = createFlowAgent('menu', {
      name: 'menu',
      on_action: [
        {
          action_id: 'go',
          do: [{ goto: 'done' }, { respond: 'This should be unreachable' }],
        },
      ],
    });
    ir.flow!.definitions.done = { name: 'done' };

    const diagnostics = validateIR(ir, [ir]);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.ACTION_HANDLER_TERMINAL_NOT_LAST,
          path: 'flow.definitions.menu.on_action[0].do[0]',
          severity: 'error',
        }),
      ]),
    );
  });

  test('errors when agent-level action handler terminal action is followed by another action', () => {
    const ir = {
      metadata: {
        name: 'agent_level_action_handler_agent',
        type: 'agent',
      },
      execution: {},
      tools: [],
      action_handlers: [
        {
          action_id: 'go',
          do: [{ handoff: 'Other_Agent' }, { respond: 'This should be unreachable' }],
        },
      ],
    } as AgentIR;

    const diagnostics = validateIR(ir, [ir], { skipCrossAgentValidation: true });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.ACTION_HANDLER_TERMINAL_NOT_LAST,
          path: 'action_handlers[0].do[0]',
          severity: 'error',
        }),
      ]),
    );
  });

  test('warns when ON_ACTION rich response is followed by terminal routing', () => {
    const ir = createFlowAgent('menu', {
      name: 'menu',
      on_action: [
        {
          action_id: 'route',
          do: [
            {
              respond: 'Routing...',
              rich_content: { markdown: '**Routing card**' },
            },
            { handoff: 'Other_Agent' },
          ],
        },
      ],
    });

    const diagnostics = validateIR(ir, [ir], { skipCrossAgentValidation: true });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.ACTION_HANDLER_RICH_RESPONSE_BEFORE_TERMINAL,
          path: 'flow.definitions.menu.on_action[0].do[0]',
          severity: 'warning',
        }),
      ]),
    );
  });

  test('warns when ON_ACTION actions are followed by terminal routing', () => {
    const ir = createFlowAgent('menu', {
      name: 'menu',
      on_action: [
        {
          action_id: 'route',
          do: [
            {
              actions: {
                elements: [{ id: 'next', type: 'button', label: 'Next' }],
              },
            },
            { handoff: 'Other_Agent' },
          ],
        },
      ],
    });

    const diagnostics = validateIR(ir, [ir], { skipCrossAgentValidation: true });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.ACTION_HANDLER_RICH_RESPONSE_BEFORE_TERMINAL,
          path: 'flow.definitions.menu.on_action[0].do[0]',
          severity: 'warning',
        }),
      ]),
    );
  });
});
