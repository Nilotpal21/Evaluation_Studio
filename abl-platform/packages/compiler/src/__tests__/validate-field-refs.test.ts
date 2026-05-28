/**
 * Field Reference Validator Tests
 */

import { describe, test, expect } from 'vitest';

import {
  CONSTRAINT_CHECKPOINT_KIND_KEY,
  CONSTRAINT_CHECKPOINT_TARGET_KEY,
} from '../platform/constants.js';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import { validateFieldReferences } from '../platform/ir/validate-field-refs.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';
import { parseAgentBasedABL } from '@abl/core';
import type { AgentIR, FlowStep } from '../platform/ir/schema.js';

function makeAgent(overrides?: {
  gatherFields?: string[];
  sessionVars?: string[];
  steps?: Record<string, Partial<FlowStep>>;
  constraints?: Array<{ condition: string; on_fail: any }>;
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
    execution: { hints: {} as any, timeouts: {} as any }, // mode deprecated — derived from flow presence
    identity: { goal: '', persona: '', limitations: [], system_prompt: {} as any },
    tools: [],
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
    error_handling: { handlers: [], default_handler: {} as any },
    messages: {} as any,
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

describe('validateFieldReferences', () => {
  test('known gather field in condition produces no diagnostics', () => {
    const agent = makeAgent({
      gatherFields: ['destination'],
      constraints: [
        { condition: 'destination IS NOT SET OR destination != "NYC"', on_fail: 'respond' },
      ],
    });
    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('known session var in condition produces no diagnostics', () => {
    const agent = makeAgent({
      sessionVars: ['user_tier'],
      constraints: [{ condition: 'user_tier == "premium"', on_fail: 'respond' }],
    });
    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('UNDEFINED_CONDITION_VAR for unknown variable in constraint (warning)', () => {
    const agent = makeAgent({
      constraints: [{ condition: 'unknown_field == "test"', on_fail: 'respond' }],
    });
    const diags = validateFieldReferences(agent);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe(VALIDATION_CODES.UNDEFINED_CONDITION_VAR);
    expect(diags[0].severity).toBe('warning');
    expect(diags[0].message).toContain('unknown_field');
  });

  test('UNDEFINED_CONDITION_VAR for unknown variable in step condition (warning)', () => {
    const agent = makeAgent({
      gatherFields: [],
      steps: {
        check_step: { check: 'mystery_var > 10', then: 'check_step' },
      },
    });
    const diags = validateFieldReferences(agent);
    expect(diags.some((d) => d.code === VALIDATION_CODES.UNDEFINED_CONDITION_VAR)).toBe(true);
  });

  test('MISSING_VARIABLE_PRODUCER_WARNING for unknown template variable in tool input', () => {
    const agent = makeAgent({
      steps: {
        lookup: {
          call_spec: {
            tool: 'lookup_order',
            with: { orderId: '{{order_id}}' },
          },
          then: 'lookup',
        } as any,
      },
    });

    const diagnostics = validateFieldReferences(agent);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: VALIDATION_CODES.MISSING_VARIABLE_PRODUCER_WARNING,
        severity: 'warning',
        path: 'flow.steps.lookup.call_spec.with.orderId',
        message: expect.stringContaining('order_id'),
      }),
    );
    expect(diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.UNDEFINED_CONDITION_VAR,
        }),
      ]),
    );
  });

  test('MISSING_VARIABLE_PRODUCER_WARNING for unknown variable in non-condition expression', () => {
    const agent = makeAgent({
      steps: {
        total: {
          set: [{ variable: 'computed_total', expression: 'subtotal + tax' }],
          then: 'total',
        },
      },
    });

    const diagnostics = validateFieldReferences(agent);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.MISSING_VARIABLE_PRODUCER_WARNING,
          severity: 'warning',
          path: 'flow.steps.total.set[0].expression',
          message: expect.stringContaining('subtotal'),
        }),
        expect.objectContaining({
          code: VALIDATION_CODES.MISSING_VARIABLE_PRODUCER_WARNING,
          severity: 'warning',
          path: 'flow.steps.total.set[0].expression',
          message: expect.stringContaining('tax'),
        }),
      ]),
    );
  });

  test('does not warn when tool input template variable has a known producer', () => {
    const agent = makeAgent({
      gatherFields: ['order_id'],
      steps: {
        lookup: {
          call_spec: {
            tool: 'lookup_order',
            with: { orderId: '{{order_id}}' },
          },
          then: 'lookup',
        } as any,
      },
    });

    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('does not treat plain string tool input values as variable references', () => {
    const agent = makeAgent({
      steps: {
        lookup: {
          call_spec: {
            tool: 'lookup_order',
            with: { priority: 'urgent' },
          },
          then: 'lookup',
        } as any,
      },
    });

    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('step-level gather fields are recognized', () => {
    const agent = makeAgent({
      steps: {
        collect_info: {
          gather: {
            fields: [{ name: 'email', type: 'email', required: true }],
          } as any,
          check: 'email != ""',
          then: 'collect_info',
        },
      },
    });
    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('built-in variables (channel, language) are not flagged', () => {
    const agent = makeAgent({
      constraints: [{ condition: 'channel == "voice"', on_fail: 'respond' }],
    });
    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('CEL abl namespace is not flagged as an unknown variable', () => {
    const agent = makeAgent({
      gatherFields: ['email'],
      constraints: [{ condition: 'abl.lower(email) contains "@"', on_fail: 'respond' }],
    });
    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('compiler-injected checkpoint variables and offer state are treated as built-ins', () => {
    const agent = makeAgent({
      constraints: [
        {
          condition:
            `previous_system_message_was_offer OR ` +
            `${CONSTRAINT_CHECKPOINT_KIND_KEY} == "response" OR ` +
            `${CONSTRAINT_CHECKPOINT_TARGET_KEY} == "assistant"`,
          on_fail: 'respond',
        },
      ],
    });

    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('dot-path variables with a known root are not flagged', () => {
    const agent = makeAgent({
      sessionVars: ['lookup_result'],
      steps: {
        step_a: { check: 'lookup_result.status == "found"', then: 'step_a' },
      },
    });
    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('UNDEFINED_CONDITION_VAR for unknown dot-path root in routing condition', () => {
    const agent = makeAgent({});
    agent.coordination = {
      delegates: [],
      handoffs: [
        {
          to: 'fulfillment_agent',
          when: 'action_request.kind == "replacement"',
          context: { pass: [], summary: 'Route fulfillment action' },
          return: false,
        },
      ],
    };

    const diagnostics = validateFieldReferences(agent);

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: VALIDATION_CODES.UNDEFINED_CONDITION_VAR,
        severity: 'warning',
        path: 'coordination.handoffs[0].when',
        message: expect.stringContaining('action_request.kind'),
      }),
    ]);
  });

  test('warns when routing conditions mix routing_intent with intent.category', () => {
    const agent = makeAgent({ gatherFields: ['routing_intent'] });
    agent.coordination = {
      delegates: [],
      handoffs: [
        {
          to: 'orders_agent',
          when: 'routing_intent != null AND intent.category == "post_purchase_issue"',
          context: { pass: [], summary: 'Route order issue' },
          return: false,
        },
      ],
    };

    const diagnostics = validateFieldReferences(agent);

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: VALIDATION_CODES.MIXED_ROUTING_CONDITION_STATE,
        severity: 'warning',
        path: 'coordination.handoffs[0].when',
      }),
    ]);
  });

  test('does not warn for canonical intent.category-only routing', () => {
    const agent = makeAgent({});
    agent.routing = {
      rules: [
        {
          to: 'orders_agent',
          when: 'intent.category == "post_purchase_issue"',
          description: 'Route order issue',
          priority: 1,
        },
      ],
      default_agent: 'orders_agent',
      intent_classification: {} as any,
    };

    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('no diagnostics when agent has no conditions', () => {
    const agent = makeAgent({});
    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('validates additional top-level runtime condition surfaces', () => {
    const agent = makeAgent({});
    agent.routing = {
      rules: [
        {
          to: 'support_agent',
          when: 'route_flag == true',
          description: 'Route to support',
          priority: 1,
        },
      ],
      default_agent: 'support_agent',
      intent_classification: {} as any,
    };
    agent.coordination = {
      handoffs: [
        {
          to: 'support_agent',
          when: 'handoff_flag == true',
          context: { pass: [], summary: 'Route to support' },
          return: false,
        },
      ],
      delegates: [
        {
          agent: 'helper_agent',
          when: 'delegate_flag == true',
          purpose: 'Collect more detail',
          input: {},
          returns: {},
          use_result: 'delegate_result',
          on_failure: 'continue',
        },
      ],
    };
    agent.memory.remember = [
      {
        when: 'remember_flag == true',
        store: { value: 'input', target: 'remembered_value' },
      },
    ];
    agent.completion.conditions = [{ when: 'completion_flag == true' }];
    agent.coordination.escalation = {
      triggers: [{ when: 'escalation_flag == true', reason: 'Need help', priority: 'high' }],
      context_for_human: [],
      on_human_complete: [],
    };
    agent.action_handlers = [{ action_id: 'confirm', condition: 'action_flag == true' }];
    agent.flow = {
      steps: ['start'],
      entry_point: 'start',
      definitions: {
        start: { name: 'start', respond: 'Hello' },
      },
      global_digressions: [{ intent: 'help', condition: 'digression_flag == true' }],
    };

    const diagnostics = validateFieldReferences(agent);
    const paths = diagnostics.map((diag) => diag.path);

    expect(paths).toEqual(
      expect.arrayContaining([
        'routing.rules[0].when',
        'coordination.handoffs[0].when',
        'coordination.delegates[0].when',
        'memory.remember[0].when',
        'completion.conditions[0].when',
        'coordination.escalation.triggers[0].when',
        'action_handlers[0].condition',
        'flow.global_digressions[0].condition',
      ]),
    );
  });

  test('validates additional step-level runtime condition surfaces', () => {
    const agent = makeAgent({
      steps: {
        assess: {
          reasoning_zone: { goal: 'Assess request', max_turns: 1, exit_when: 'exit_flag == true' },
          gather: {
            fields: [
              {
                name: 'email',
                type: 'email',
                required: true,
                activation: { when: 'activation_flag == true' },
              },
            ],
          } as any,
          success_when: 'success_flag == true',
          on_input: [{ condition: 'input_flag == true', then: 'assess' }],
          on_result: [{ condition: 'result_flag == true', then: 'assess' }],
          on_success: { branches: [{ condition: 'success_branch_flag == true', then: 'assess' }] },
          on_failure: { branches: [{ condition: 'failure_branch_flag == true', then: 'assess' }] },
          on_action: [{ action_id: 'continue', condition: 'action_branch_flag == true' }],
          digressions: [{ intent: 'cancel', condition: 'digression_step_flag == true' }],
          respond: 'Assessing',
        } as any,
      },
    });

    const diagnostics = validateFieldReferences(agent);
    const paths = diagnostics.map((diag) => diag.path);

    expect(paths).toEqual(
      expect.arrayContaining([
        'flow.steps.assess.reasoning_zone.exit_when',
        'flow.steps.assess.success_when',
        'flow.steps.assess.gather.fields[0].activation.when',
        'flow.steps.assess.on_input[0].condition',
        'flow.steps.assess.on_result[0].condition',
        'flow.steps.assess.on_success.branches[0].condition',
        'flow.steps.assess.on_failure.branches[0].condition',
        'flow.steps.assess.on_action[0].condition',
        'flow.steps.assess.digressions[0].condition',
      ]),
    );
  });

  test('known variables from SET, mappings, and coordination return contracts are not flagged', () => {
    const agent = makeAgent({
      sessionVars: ['items'],
      constraints: [
        { condition: 'startup_status == "ready"', on_fail: 'respond' },
        { condition: 'remembered_preference == "beach"', on_fail: 'respond' },
        { condition: 'delegate_result == "done"', on_fail: 'respond' },
        { condition: 'delegate_score > 0', on_fail: 'respond' },
        { condition: 'handoff_answer == "yes"', on_fail: 'respond' },
        { condition: 'computed_total > 0', on_fail: 'respond' },
        { condition: 'filtered_options != null', on_fail: 'respond' },
        { condition: 'input_branch_seen == true', on_fail: 'respond' },
        { condition: 'result_branch_seen == true', on_fail: 'respond' },
        { condition: 'success_branch_seen == true', on_fail: 'respond' },
        { condition: 'failure_branch_seen == true', on_fail: 'respond' },
        { condition: 'action_selection == "approve"', on_fail: 'respond' },
        { condition: 'step_digression_seen == true', on_fail: 'respond' },
        { condition: 'global_digression_seen == true', on_fail: 'respond' },
        { condition: 'digression_return_value == "mapped"', on_fail: 'respond' },
        { condition: 'sub_intent_seen == true', on_fail: 'respond' },
      ],
    });
    agent.on_start = { set: { startup_status: '"ready"' } } as any;
    agent.memory.remember = [
      {
        when: 'input != ""',
        store: { value: 'input', target: 'remembered_preference' },
      },
    ];
    agent.coordination = {
      handoffs: [
        {
          to: 'specialist_agent',
          when: 'always',
          context: { pass: [], summary: 'Route to specialist' },
          return: true,
          on_return: { map: { answer: 'handoff_answer' } },
        },
      ],
      delegates: [
        {
          agent: 'helper_agent',
          when: 'always',
          purpose: 'Collect more detail',
          input: {},
          returns: { score: 'delegate_score' },
          use_result: 'delegate_result',
          on_failure: 'continue',
        },
      ],
    };
    agent.action_handlers = [{ action_id: 'approve', set: { action_selection: '"approve"' } }];
    agent.flow = {
      steps: ['start'],
      entry_point: 'start',
      definitions: {
        start: {
          name: 'start',
          respond: 'Hello',
          set: [{ variable: 'computed_total', expression: '1' }],
          transform: { source: 'items', item_var: 'item', target: 'filtered_options' },
          on_input: [{ then: 'start', set: { input_branch_seen: 'true' } }],
          on_result: [{ then: 'start', set: { result_branch_seen: 'true' } }],
          on_success: { branches: [{ then: 'start', set: { success_branch_seen: 'true' } }] },
          on_failure: { branches: [{ then: 'start', set: { failure_branch_seen: 'true' } }] },
          on_action: [{ action_id: 'continue', set: { action_selection: '"approve"' } }],
          digressions: [{ intent: 'cancel', do: [{ set: { step_digression_seen: 'true' } }] }],
          sub_intents: [{ intent: 'change destination', set: { sub_intent_seen: 'true' } }],
        } as any,
      },
      global_digressions: [
        {
          intent: 'help',
          do: [
            {
              set: { global_digression_seen: 'true' },
              on_return: { map: { child_value: 'digression_return_value' } },
            },
          ],
        },
      ],
    };

    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('known variables from tool result mappings and stored raw tool results are not flagged', () => {
    const agent = makeAgent({
      constraints: [
        { condition: 'order_status == "delayed"', on_fail: 'respond' },
        { condition: 'last_get_order_result.promised_delivery_date != null', on_fail: 'respond' },
      ],
    });
    agent.tools = [
      {
        name: 'get_order',
        description: 'Look up order status',
        parameters: [],
        returns: { fields: {} },
        hints: {},
        store_result: true,
        on_result: { set: { order_status: 'result.status' } },
      },
    ];

    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('canonical step ON_ACTION DO set and on_return map variables are recognized', () => {
    const agent = makeAgent({
      constraints: [
        { condition: 'step_action_choice == "approve"', on_fail: 'respond' },
        { condition: 'step_action_result == "mapped"', on_fail: 'respond' },
      ],
      steps: {
        review: {
          respond: 'Review',
          on_action: [
            {
              action_id: 'approve',
              do: [
                { set: { step_action_choice: '"approve"' } },
                {
                  delegate: 'review_helper',
                  return: true,
                  on_return: { map: { child_value: 'step_action_result' } },
                },
              ],
            },
          ],
        } as any,
      },
    });

    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('canonical agent ACTION_HANDLERS DO set and on_return map variables are recognized', () => {
    const agent = makeAgent({
      constraints: [
        { condition: 'agent_action_choice == "approve"', on_fail: 'respond' },
        { condition: 'agent_action_result == "mapped"', on_fail: 'respond' },
      ],
    });

    agent.action_handlers = [
      {
        action_id: 'approve',
        do: [
          { set: { agent_action_choice: '"approve"' } },
          {
            delegate: 'approval_helper',
            return: true,
            on_return: { map: { child_value: 'agent_action_result' } },
          },
        ],
      } as any,
    ];

    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('warns when a required top-level gather field has no known consumer', () => {
    const agent = makeAgent({
      gatherFields: ['account_id'],
    });

    const diagnostics = validateFieldReferences(agent);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: VALIDATION_CODES.UNUSED_REQUIRED_GATHER_FIELD,
        severity: 'warning',
        path: 'gather.fields[0]',
        message: expect.stringContaining('account_id'),
      }),
    );
  });

  test('does not warn when required gather fields feed COMPLETE, MEMORY, handoff context, or tool inputs', () => {
    const agent = makeAgent({
      gatherFields: [
        'account_id',
        'case_summary',
        'handoff_context',
        'lookup_key',
        'returned_status',
      ],
      steps: {
        lookup: {
          call_spec: {
            tool: 'lookup_case',
            with: { query: '{{lookup_key}}' },
          },
          then: 'lookup',
        },
      },
    });
    agent.completion.conditions = [{ when: 'account_id != ""' }];
    agent.memory.remember = [
      {
        when: 'case_summary != ""',
        store: { value: 'case_summary', target: 'last_case_summary' },
      },
    ];
    agent.coordination = {
      delegates: [],
      handoffs: [
        {
          to: 'support_agent',
          when: 'always',
          context: {
            pass: [{ name: 'handoff_context', type: 'string' }],
            summary: 'Pass collected context',
          },
          return: true,
          on_return: { map: { child_status: 'returned_status' } },
        },
      ],
    };

    const diagnostics = validateFieldReferences(agent);

    expect(
      diagnostics.filter((d) => d.code === VALIDATION_CODES.UNUSED_REQUIRED_GATHER_FIELD),
    ).toEqual([]);
  });

  test('warns when a required flow gather field has no downstream consumer', () => {
    const agent = makeAgent({
      steps: {
        collect: {
          gather: {
            fields: [{ name: 'unused_detail', type: 'string', required: true }],
          },
          then: 'collect',
        } as any,
      },
    });

    const diagnostics = validateFieldReferences(agent);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: VALIDATION_CODES.UNUSED_REQUIRED_GATHER_FIELD,
        severity: 'warning',
        path: 'flow.steps.collect.gather.fields[0]',
      }),
    );
  });

  test('compiler surfaces unused required gather fields as compilation warnings', () => {
    const parseResult = parseAgentBasedABL(`
AGENT: IntakeAgent
GOAL: "Collect intake details"

GATHER:
  unused_detail:
    type: string
    prompt: "What detail should we capture?"
`);
    expect(parseResult.errors).toHaveLength(0);

    const output = compileABLtoIR([parseResult.document!], { skipCrossAgentValidation: true });

    expect(output.compilation_warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.UNUSED_REQUIRED_GATHER_FIELD,
          severity: 'warning',
          path: 'gather.fields[0]',
        }),
      ]),
    );
    expect(output.compilation_errors ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.UNUSED_REQUIRED_GATHER_FIELD,
        }),
      ]),
    );
  });
});
