import { describe, expect, it } from 'vitest';
import type { AgentIR } from '@abl/compiler';

import {
  validateCompletionReachability,
  validateGatherCompleteness,
  validateHandoffConditionVariables,
  validateHandoffSummaryCoverage,
  validateHandoffReturnMappings,
  validateHandoffReturnContract,
  validatePassFieldExistence,
  validateReturnStateCoverage,
  validateQualityFloor,
} from '../../diagnostics/semantic-validators.js';
import type { ValidatorContext } from '../../diagnostics/types.js';

function makeAgent(name: string, overrides: Record<string, unknown> = {}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: { name, description: '', tags: [], version: '1.0.0' },
    execution: { hints: {}, timeouts: {} },
    identity: { goal: '', persona: '', limitations: [], system_prompt: '' },
    tools: [],
    gather: { fields: [] },
    memory: { session: [], persistent: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: { handoffs: [], delegates: [] },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_handler: { action: 'respond' } },
    ...overrides,
  } as unknown as AgentIR;
}

function makeContext(agents: Record<string, AgentIR>): ValidatorContext {
  return {
    agents,
    agentNames: Object.keys(agents),
  };
}

describe('validateCompletionReachability', () => {
  it('emits CO-02 when completion references undeclared state', () => {
    const findings = validateCompletionReachability(
      makeContext({
        BrokenAgent: makeAgent('BrokenAgent', {
          completion: {
            conditions: [{ when: 'resolution_confirmed == true', reason: 'Done.' }],
          },
        }),
      }),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'CO-02',
          severity: 'error',
          agentName: 'BrokenAgent',
          path: 'completion.conditions[0].when',
        }),
      ]),
    );
  });

  it('allows self-contained no-input completion conditions', () => {
    const findings = validateCompletionReachability(
      makeContext({
        SinkAgent: makeAgent('SinkAgent', {
          completion: {
            conditions: [{ when: 'true AND true', reason: 'Return immediately.' }],
          },
        }),
      }),
    );

    expect(findings.some((finding) => finding.code === 'SV-13')).toBe(false);
  });

  it('does not emit CO-02 for parent completion that uses ON_RETURN mapped state', () => {
    const findings = validateCompletionReachability(
      makeContext({
        ParentAgent: makeAgent('ParentAgent', {
          coordination: {
            handoffs: [
              {
                to: 'ChildAgent',
                when: 'true',
                context: { pass: [], summary: '' },
                return: true,
                on_return: { map: { child_status: 'booking_status' } },
              },
            ],
            delegates: [],
          },
          completion: {
            conditions: [{ when: 'booking_status == "confirmed"', reason: 'Done.' }],
          },
        }),
        ChildAgent: makeAgent('ChildAgent'),
      }),
    );

    expect(findings.some((finding) => finding.code === 'CO-02')).toBe(false);
  });

  it('errors when completion depends on undeclared state with no gather or flow', () => {
    const findings = validateCompletionReachability(
      makeContext({
        BrokenAgent: makeAgent('BrokenAgent', {
          completion: {
            conditions: [{ when: 'resolution_confirmed == true', reason: 'Done.' }],
          },
        }),
      }),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SV-13',
          severity: 'error',
          agentName: 'BrokenAgent',
        }),
      ]),
    );
  });

  it('allows completion based on declared session state without gather or flow', () => {
    const findings = validateCompletionReachability(
      makeContext({
        SessionDrivenAgent: makeAgent('SessionDrivenAgent', {
          memory: {
            session: [{ name: 'done', type: 'boolean', initial_value: false }],
            persistent: [],
          },
          completion: {
            conditions: [{ when: 'done == true', reason: 'Done.' }],
          },
        }),
      }),
    );

    expect(findings.some((finding) => finding.code === 'SV-13')).toBe(false);
  });

  it('emits CO-03 when every completion condition depends only on optional gather fields', () => {
    const findings = validateCompletionReachability(
      makeContext({
        OptionalOnlyAgent: makeAgent('OptionalOnlyAgent', {
          gather: {
            fields: [
              {
                name: 'loyalty_number',
                type: 'string',
                required: true,
                prompt: 'Share your loyalty number if you have one.',
                activation: 'optional',
              },
            ],
          },
          completion: {
            conditions: [{ when: 'loyalty_number IS SET', reason: 'Done.' }],
          },
        }),
      }),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'CO-03',
          severity: 'error',
          agentName: 'OptionalOnlyAgent',
        }),
      ]),
    );
  });

  it('does not emit CO-03 when completion can be satisfied by required gather state', () => {
    const findings = validateCompletionReachability(
      makeContext({
        RequiredGatherAgent: makeAgent('RequiredGatherAgent', {
          gather: {
            fields: [{ name: 'destination', type: 'string', required: true, prompt: 'Where?' }],
          },
          completion: {
            conditions: [{ when: 'destination IS SET', reason: 'Done.' }],
          },
        }),
      }),
    );

    expect(findings.some((finding) => finding.code === 'CO-03')).toBe(false);
  });
});

describe('validateHandoffReturnContract', () => {
  it('does not accept an explicit handoff back to the source as a runtime return path', () => {
    const findings = validateHandoffReturnContract(
      makeContext({
        ParentAgent: makeAgent('ParentAgent', {
          coordination: {
            handoffs: [
              {
                to: 'ChildAgent',
                when: 'true',
                context: { pass: [], summary: '' },
                return: true,
              },
            ],
            delegates: [],
          },
        }),
        ChildAgent: makeAgent('ChildAgent', {
          coordination: {
            handoffs: [
              {
                to: 'ParentAgent',
                when: 'done == true',
                context: { pass: [], summary: '' },
                return: false,
              },
            ],
            delegates: [],
          },
        }),
      }),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'CO-04',
          severity: 'error',
          agentName: 'ParentAgent',
        }),
      ]),
    );
  });

  it('flags unconditional child handoff back to a return-waiting caller because it preempts COMPLETE', () => {
    const findings = validateHandoffReturnContract(
      makeContext({
        ParentAgent: makeAgent('ParentAgent', {
          coordination: {
            handoffs: [
              {
                to: 'ChildAgent',
                when: 'true',
                context: { pass: [], summary: '' },
                return: true,
              },
            ],
            delegates: [],
          },
        }),
        ChildAgent: makeAgent('ChildAgent', {
          completion: {
            conditions: [{ when: 'ready == true', reason: 'Done.' }],
          },
          coordination: {
            handoffs: [
              {
                to: 'ParentAgent',
                when: 'true',
                context: { pass: [], summary: '' },
                return: true,
              },
            ],
            delegates: [],
          },
        }),
      }),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'CO-04',
          severity: 'error',
          agentName: 'ChildAgent',
          message: expect.stringContaining('starts a new nested handoff instead of returning'),
        }),
      ]),
    );
  });

  it('still emits CO-04 when the target has no completion and no handoff back', () => {
    const findings = validateHandoffReturnContract(
      makeContext({
        ParentAgent: makeAgent('ParentAgent', {
          coordination: {
            handoffs: [
              {
                to: 'ChildAgent',
                when: 'true',
                context: { pass: [], summary: '' },
                return: true,
              },
            ],
            delegates: [],
          },
        }),
        ChildAgent: makeAgent('ChildAgent'),
      }),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'CO-04',
          severity: 'error',
          agentName: 'ParentAgent',
        }),
      ]),
    );
  });
});

describe('validateHandoffReturnMappings', () => {
  it('emits H-07 when ON_RETURN.map references a child field the target does not produce', () => {
    const findings = validateHandoffReturnMappings(
      makeContext({
        ParentAgent: makeAgent('ParentAgent', {
          coordination: {
            handoffs: [
              {
                to: 'ChildAgent',
                when: 'true',
                context: { pass: [], summary: '' },
                return: true,
                on_return: { map: { booking_ref: 'parent_booking_ref' } },
              },
            ],
            delegates: [],
          },
        }),
        ChildAgent: makeAgent('ChildAgent'),
      }),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'H-07',
          severity: 'warning',
          agentName: 'ParentAgent',
        }),
      ]),
    );
  });

  it('does not emit H-07 when the child gathers the mapped return field', () => {
    const findings = validateHandoffReturnMappings(
      makeContext({
        ParentAgent: makeAgent('ParentAgent', {
          coordination: {
            handoffs: [
              {
                to: 'ChildAgent',
                when: 'true',
                context: { pass: [], summary: '' },
                return: true,
                on_return: { map: { booking_ref: 'parent_booking_ref' } },
              },
            ],
            delegates: [],
          },
        }),
        ChildAgent: makeAgent('ChildAgent', {
          gather: {
            fields: [{ name: 'booking_ref', type: 'string', required: true, prompt: 'Ref?' }],
          },
        }),
      }),
    );

    expect(findings.some((finding) => finding.code === 'H-07')).toBe(false);
  });

  it('emits H-07 when the child only declares the mapped return field as uninitialized session state', () => {
    const findings = validateHandoffReturnMappings(
      makeContext({
        ParentAgent: makeAgent('ParentAgent', {
          coordination: {
            handoffs: [
              {
                to: 'ChildAgent',
                when: 'true',
                context: { pass: [], summary: '' },
                return: true,
                on_return: { map: { booking_ref: 'parent_booking_ref' } },
              },
            ],
            delegates: [],
          },
        }),
        ChildAgent: makeAgent('ChildAgent', {
          memory: {
            session: [{ name: 'booking_ref', type: 'string' }],
            persistent: [],
          },
        }),
      }),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'H-07',
          severity: 'warning',
          agentName: 'ParentAgent',
        }),
      ]),
    );
  });
});

describe('validateHandoffSummaryCoverage', () => {
  it('emits H-06 when history: summary_only has no CONTEXT.summary', () => {
    const findings = validateHandoffSummaryCoverage(
      makeContext({
        ParentAgent: makeAgent('ParentAgent', {
          coordination: {
            handoffs: [
              {
                to: 'ChildAgent',
                when: 'true',
                context: { pass: [], summary: '', history: 'summary_only' },
                return: false,
              },
            ],
            delegates: [],
          },
        }),
        ChildAgent: makeAgent('ChildAgent'),
      }),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'H-06',
          severity: 'warning',
          agentName: 'ParentAgent',
        }),
      ]),
    );
  });

  it('does not emit H-06 when summary_only carries a summary', () => {
    const findings = validateHandoffSummaryCoverage(
      makeContext({
        ParentAgent: makeAgent('ParentAgent', {
          coordination: {
            handoffs: [
              {
                to: 'ChildAgent',
                when: 'true',
                context: {
                  pass: [],
                  summary: 'User needs billing help for invoice {{invoice_id}}.',
                  history: 'summary_only',
                },
                return: false,
              },
            ],
            delegates: [],
          },
        }),
        ChildAgent: makeAgent('ChildAgent'),
      }),
    );

    expect(findings.some((finding) => finding.code === 'H-06')).toBe(false);
  });
});

describe('validateReturnStateCoverage', () => {
  it('emits H-15 when parent completion depends on child non-gather return state without ON_RETURN.map', () => {
    const findings = validateReturnStateCoverage(
      makeContext({
        ParentAgent: makeAgent('ParentAgent', {
          memory: {
            session: [{ name: 'booking_status', type: 'string' }],
            persistent: [],
          },
          coordination: {
            handoffs: [
              {
                to: 'ChildAgent',
                when: 'true',
                context: { pass: [], summary: '' },
                return: true,
              },
            ],
            delegates: [],
          },
          completion: {
            conditions: [{ when: 'booking_status == "confirmed"', reason: 'Done.' }],
          },
        }),
        ChildAgent: makeAgent('ChildAgent', {
          flow: {
            definitions: {
              lookup_booking: {
                set: [{ variable: 'booking_status', expression: 'last_lookup_result.status' }],
              },
            },
          },
        }),
      }),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'H-15',
          severity: 'warning',
          agentName: 'ParentAgent',
        }),
      ]),
    );
  });

  it('does not emit H-15 when the child gathers the same field name and default return merge covers it', () => {
    const findings = validateReturnStateCoverage(
      makeContext({
        ParentAgent: makeAgent('ParentAgent', {
          memory: {
            session: [{ name: 'booking_status', type: 'string' }],
            persistent: [],
          },
          coordination: {
            handoffs: [
              {
                to: 'ChildAgent',
                when: 'true',
                context: { pass: [], summary: '' },
                return: true,
              },
            ],
            delegates: [],
          },
          completion: {
            conditions: [{ when: 'booking_status == "confirmed"', reason: 'Done.' }],
          },
        }),
        ChildAgent: makeAgent('ChildAgent', {
          gather: {
            fields: [{ name: 'booking_status', type: 'string', required: true, prompt: 'Status?' }],
          },
        }),
      }),
    );

    expect(findings.some((finding) => finding.code === 'H-15')).toBe(false);
  });

  it('does not emit H-15 when ON_RETURN.map covers the parent variable', () => {
    const findings = validateReturnStateCoverage(
      makeContext({
        ParentAgent: makeAgent('ParentAgent', {
          memory: {
            session: [{ name: 'booking_status', type: 'string' }],
            persistent: [],
          },
          coordination: {
            handoffs: [
              {
                to: 'ChildAgent',
                when: 'true',
                context: { pass: [], summary: '' },
                return: true,
                on_return: { map: { child_booking_status: 'booking_status' } },
              },
            ],
            delegates: [],
          },
          completion: {
            conditions: [{ when: 'booking_status == "confirmed"', reason: 'Done.' }],
          },
        }),
        ChildAgent: makeAgent('ChildAgent', {
          flow: {
            definitions: {
              lookup_booking: {
                set: [
                  { variable: 'child_booking_status', expression: 'last_lookup_result.status' },
                ],
              },
            },
          },
        }),
      }),
    );

    expect(findings.some((finding) => finding.code === 'H-15')).toBe(false);
  });
});

describe('validatePassFieldExistence', () => {
  it('emits H-03 when PASS references an uninitialized session variable', () => {
    const findings = validatePassFieldExistence(
      makeContext({
        RouterAgent: makeAgent('RouterAgent', {
          memory: {
            session: [{ name: 'customer_id', type: 'string' }],
            persistent: [],
          },
          coordination: {
            handoffs: [
              {
                to: 'BillingAgent',
                when: 'true',
                context: { pass: [{ name: 'customer_id', type: 'string' }], summary: '' },
                return: false,
              },
            ],
            delegates: [],
          },
        }),
        BillingAgent: makeAgent('BillingAgent'),
      }),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'H-03',
          severity: 'warning',
          agentName: 'RouterAgent',
        }),
      ]),
    );
  });

  it('does not emit H-03 when the session variable has an initial value', () => {
    const findings = validatePassFieldExistence(
      makeContext({
        RouterAgent: makeAgent('RouterAgent', {
          memory: {
            session: [{ name: 'customer_id', type: 'string', initial_value: 'guest' }],
            persistent: [],
          },
          coordination: {
            handoffs: [
              {
                to: 'BillingAgent',
                when: 'true',
                context: { pass: [{ name: 'customer_id', type: 'string' }], summary: '' },
                return: false,
              },
            ],
            delegates: [],
          },
        }),
        BillingAgent: makeAgent('BillingAgent'),
      }),
    );

    expect(findings.some((finding) => finding.code === 'H-03')).toBe(false);
  });

  it('does not emit H-03 when the session variable is populated by gather', () => {
    const findings = validatePassFieldExistence(
      makeContext({
        RouterAgent: makeAgent('RouterAgent', {
          gather: {
            fields: [{ name: 'customer_id', type: 'string', required: true, prompt: 'ID?' }],
          },
          memory: {
            session: [{ name: 'customer_id', type: 'string' }],
            persistent: [],
          },
          coordination: {
            handoffs: [
              {
                to: 'BillingAgent',
                when: 'true',
                context: { pass: [{ name: 'customer_id', type: 'string' }], summary: '' },
                return: false,
              },
            ],
            delegates: [],
          },
        }),
        BillingAgent: makeAgent('BillingAgent'),
      }),
    );

    expect(findings.some((finding) => finding.code === 'H-03')).toBe(false);
  });

  it('does not emit H-04 when target declares the passed field in MEMORY.session', () => {
    const findings = validatePassFieldExistence(
      makeContext({
        RouterAgent: makeAgent('RouterAgent', {
          gather: {
            fields: [{ name: 'customer_id', type: 'string', required: true, prompt: 'ID?' }],
          },
          coordination: {
            handoffs: [
              {
                to: 'BillingAgent',
                when: 'true',
                context: { pass: [{ name: 'customer_id', type: 'string' }], summary: '' },
                return: false,
              },
            ],
            delegates: [],
          },
        }),
        BillingAgent: makeAgent('BillingAgent', {
          memory: {
            session: [{ name: 'customer_id', type: 'string' }],
            persistent: [],
          },
        }),
      }),
    );

    expect(findings.some((finding) => finding.code === 'H-04')).toBe(false);
  });

  it('emits H-08 when PASS type is incompatible with the target declaration', () => {
    const findings = validatePassFieldExistence(
      makeContext({
        RouterAgent: makeAgent('RouterAgent', {
          gather: {
            fields: [{ name: 'customer_age', type: 'number', required: true, prompt: 'Age?' }],
          },
          coordination: {
            handoffs: [
              {
                to: 'BillingAgent',
                when: 'true',
                context: { pass: [{ name: 'customer_age', type: 'string' }], summary: '' },
                return: false,
              },
            ],
            delegates: [],
          },
        }),
        BillingAgent: makeAgent('BillingAgent', {
          memory: {
            session: [{ name: 'customer_age', type: 'boolean' }],
            persistent: [],
          },
        }),
      }),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'H-08',
          severity: 'warning',
          agentName: 'RouterAgent',
        }),
      ]),
    );
  });
});

describe('validateHandoffConditionVariables', () => {
  it('emits H-05 when HANDOFF WHEN references undeclared state', () => {
    const findings = validateHandoffConditionVariables(
      makeContext({
        RouterAgent: makeAgent('RouterAgent', {
          coordination: {
            handoffs: [
              {
                to: 'BillingAgent',
                when: 'route_flag == true',
                context: { pass: [], summary: '' },
                return: false,
              },
            ],
            delegates: [],
          },
        }),
        BillingAgent: makeAgent('BillingAgent'),
      }),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'H-05',
          severity: 'error',
          agentName: 'RouterAgent',
          path: 'coordination.handoffs[0].when',
        }),
      ]),
    );
  });

  it('does not emit H-05 for valid runtime-backed handoff conditions', () => {
    const findings = validateHandoffConditionVariables(
      makeContext({
        RouterAgent: makeAgent('RouterAgent', {
          coordination: {
            handoffs: [
              {
                to: 'VoiceAgent',
                when: 'channel == "voice"',
                context: { pass: [], summary: '' },
                return: false,
              },
            ],
            delegates: [],
          },
        }),
        VoiceAgent: makeAgent('VoiceAgent'),
      }),
    );

    expect(findings.some((finding) => finding.code === 'H-05')).toBe(false);
  });
});

describe('validateGatherCompleteness', () => {
  it('treats child gather fields consumed by parent default return merge as used', () => {
    const findings = validateGatherCompleteness(
      makeContext({
        ParentAgent: makeAgent('ParentAgent', {
          coordination: {
            handoffs: [
              {
                to: 'ChildAgent',
                when: 'true',
                context: { pass: [], summary: '' },
                return: true,
              },
            ],
            delegates: [],
          },
          completion: {
            conditions: [{ when: 'booking_status == "confirmed"', reason: 'Done.' }],
          },
        }),
        ChildAgent: makeAgent('ChildAgent', {
          gather: {
            fields: [
              {
                name: 'booking_status',
                type: 'string',
                required: true,
                prompt: 'What is the booking status?',
              },
            ],
          },
        }),
      }),
    );

    expect(findings.some((finding) => finding.code === 'G-09')).toBe(false);
  });

  it('warns return targets without recommending destructive completion removal', () => {
    const findings = validateGatherCompleteness(
      makeContext({
        ParentAgent: makeAgent('ParentAgent', {
          coordination: {
            handoffs: [
              {
                to: 'ChildAgent',
                when: 'true',
                context: { pass: [], summary: '' },
                return: true,
              },
            ],
            delegates: [],
          },
        }),
        ChildAgent: makeAgent('ChildAgent', {
          gather: {
            fields: [
              {
                name: 'loose_note',
                type: 'string',
                required: true,
                prompt: 'What should I note?',
              },
            ],
          },
        }),
      }),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'G-09',
          message: expect.stringContaining('do not remove GATHER or COMPLETE'),
          agentName: 'ChildAgent',
        }),
      ]),
    );
  });
});

describe('validateQualityFloor', () => {
  it('downgrades missing tools on specialists to informational guidance', () => {
    const findings = validateQualityFloor(
      makeContext({
        ConversationalSpecialist: makeAgent('ConversationalSpecialist', {
          constraints: {
            constraints: [],
            guardrails: [{ name: 'content_safety', condition: 'true', action: 'block' }],
          },
          memory: {
            session: [{ name: 'current_topic', type: 'string', initial_value: null }],
            persistent: [],
          },
        }),
      }),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'QG-02',
          severity: 'info',
          agentName: 'ConversationalSpecialist',
        }),
      ]),
    );
  });
});
