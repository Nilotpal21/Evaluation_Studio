import { describe, expect, it } from 'vitest';

import { deriveScaffoldRuntimePlan } from '../runtime-flow';
import type { AblSkeleton } from '../types';

describe('scaffold runtime flow', () => {
  it('does not emit canned normal-path responses for tool-backed agents', () => {
    const skeleton = skeletonWith({
      agentName: 'OrderSpecialist',
      tools: [
        {
          name: 'get_order',
          signatureLiteral: 'get_order(order_id: string) -> { status: string }',
          descriptionLiteral: 'Look up the order status.',
          sideEffects: false,
          confirmPolicy: 'never',
          paramDescriptions: { order_id: 'Order identifier.' },
          signatureSlot: 'tools.get_order.signature',
          descriptionSlot: 'tools.get_order.description',
        },
      ],
      gatherFields: [{ name: 'order_id', type: 'string', askSlot: 'gather.order_id.prompt' }],
      memorySessionVars: ['order_id'],
    });

    const runtimePlan = deriveScaffoldRuntimePlan(skeleton);

    expect(runtimePlan.flow).toHaveLength(2);
    expect(runtimePlan.flow[0]).toMatchObject({ name: 'call_get_order', call: 'get_order' });
    expect(runtimePlan.flow[1]).toMatchObject({ name: 'finalize', complete: true });
    expect(runtimePlan.flow.map((step) => step.respond)).toEqual([undefined, undefined]);
  });

  it('does not synthesize customer-facing failure copy', () => {
    const runtimePatterns: AblSkeleton['runtimePattern'][] = [
      'tool_worker',
      'transaction',
      'escalation',
      'pipeline_stage',
    ];

    for (const runtimePattern of runtimePatterns) {
      const skeleton = skeletonWith({
        agentName: 'OrderSpecialist',
        runtimePattern,
        tools: [
          {
            name: 'get_order',
            signatureLiteral: 'get_order(order_id: string) -> { status: string }',
            descriptionLiteral: 'Look up the order status.',
            sideEffects: false,
            confirmPolicy: 'never',
            paramDescriptions: { order_id: 'Order identifier.' },
            signatureSlot: 'tools.get_order.signature',
            descriptionSlot: 'tools.get_order.description',
          },
        ],
      });

      const runtimePlan = deriveScaffoldRuntimePlan(skeleton);
      const failureResponses = runtimePlan.toolCalls.map((call) => call.onFailure.respond);

      expect(failureResponses).toEqual([undefined]);
    }
  });

  it('does not synthesize scripted transition copy for routing supervisors', () => {
    const skeleton = skeletonWith({
      agentName: 'Reception',
      keyword: 'SUPERVISOR',
      runtimePattern: 'router',
      handoffs: [
        { to: 'OrderSpecialist', returnExpected: false, whenSlot: null, whenLiteral: 'true' },
      ],
    });

    const runtimePlan = deriveScaffoldRuntimePlan(skeleton);

    expect(runtimePlan.flow).toEqual([]);
  });

  it('uses reasoning for decision-agent tool calls', () => {
    const skeleton = skeletonWith({
      agentName: 'PolicyAdvisor',
      runtimePattern: 'reasoning',
      tools: [
        {
          name: 'search_policies',
          signatureLiteral: 'search_policies(query: string) -> { summary: string }',
          descriptionLiteral: 'Search policy guidance.',
          sideEffects: false,
          confirmPolicy: 'never',
          paramDescriptions: { query: 'Policy search query.' },
          signatureSlot: 'tools.search_policies.signature',
          descriptionSlot: 'tools.search_policies.description',
        },
      ],
      gatherFields: [{ name: 'query', type: 'string', askSlot: 'gather.query.prompt' }],
    });

    const runtimePlan = deriveScaffoldRuntimePlan(skeleton);

    expect(runtimePlan.flow[0]).toMatchObject({
      name: 'call_search_policies',
      call: 'search_policies',
      reasoning: true,
    });
  });

  it('does not chain multiple side-effect tools in a deterministic flow', () => {
    const skeleton = skeletonWith({
      agentName: 'FulfillmentSpecialist',
      runtimePattern: 'transaction',
      tools: [
        {
          name: 'create_replacement',
          signatureLiteral: 'create_replacement(order_id: string) -> { success: boolean }',
          descriptionLiteral: 'Create a replacement.',
          sideEffects: true,
          confirmPolicy: 'never',
          paramDescriptions: { order_id: 'Order identifier.' },
          signatureSlot: 'tools.create_replacement.signature',
          descriptionSlot: 'tools.create_replacement.description',
        },
        {
          name: 'issue_refund',
          signatureLiteral: 'issue_refund(order_id: string) -> { success: boolean }',
          descriptionLiteral: 'Issue a refund.',
          sideEffects: true,
          confirmPolicy: 'never',
          paramDescriptions: { order_id: 'Order identifier.' },
          signatureSlot: 'tools.issue_refund.signature',
          descriptionSlot: 'tools.issue_refund.description',
        },
      ],
    });

    const runtimePlan = deriveScaffoldRuntimePlan(skeleton);

    expect(runtimePlan.toolCalls.map((call) => call.tool)).toEqual([
      'create_replacement',
      'issue_refund',
    ]);
    expect(runtimePlan.toolCalls.map((call) => call.onSuccess.then)).toEqual([
      'COMPLETE',
      'COMPLETE',
    ]);
    expect(runtimePlan.toolCalls.map((call) => call.onFailure.then)).toEqual([
      'COMPLETE',
      'COMPLETE',
    ]);
    expect(runtimePlan.flow).toEqual([
      { name: 'reason_with_tools', reasoning: true, complete: true },
    ]);
  });

  it('uses reasoning instead of unbound CALL inputs when no gather fields exist', () => {
    const skeleton = skeletonWith({
      agentName: 'PolicyAdvisor',
      runtimePattern: 'reasoning',
      tools: [
        {
          name: 'search_policies',
          signatureLiteral:
            'search_policies(policy_topic: string, order_status: string) -> { eligible: boolean }',
          descriptionLiteral: 'Search policy guidance.',
          sideEffects: false,
          confirmPolicy: 'never',
          paramDescriptions: {
            policy_topic: 'Policy topic.',
            order_status: 'Order status.',
          },
          signatureSlot: 'tools.search_policies.signature',
          descriptionSlot: 'tools.search_policies.description',
        },
      ],
    });

    const runtimePlan = deriveScaffoldRuntimePlan(skeleton);

    expect(runtimePlan.toolCalls[0]?.with).toEqual({
      policy_topic: 'input',
      order_status: 'input',
    });
    expect(runtimePlan.flow).toEqual([
      { name: 'reason_with_tools', reasoning: true, complete: true },
    ]);
  });

  it('uses reasoning instead of duplicate fallback bindings for tool inputs', () => {
    const skeleton = skeletonWith({
      agentName: 'RefundSpecialist',
      runtimePattern: 'transaction',
      tools: [
        {
          name: 'refunds_submit_refund',
          signatureLiteral:
            'refunds_submit_refund(order_id: string, reason: string) -> { success: boolean }',
          descriptionLiteral: 'Submit a refund.',
          sideEffects: true,
          confirmPolicy: 'when_side_effects',
          paramDescriptions: {
            order_id: 'Order identifier.',
            reason: 'Refund reason.',
          },
          signatureSlot: 'tools.refunds_submit_refund.signature',
          descriptionSlot: 'tools.refunds_submit_refund.description',
        },
      ],
      gatherFields: [{ name: 'order_number', type: 'string', askSlot: 'gather.order_number.ask' }],
    });

    const runtimePlan = deriveScaffoldRuntimePlan(skeleton);

    expect(runtimePlan.toolCalls[0]?.with).toEqual({
      order_id: 'order_number',
      reason: 'order_number',
    });
    expect(runtimePlan.flow).toEqual([
      { name: 'reason_with_tools', reasoning: true, complete: true },
    ]);
  });

  it('parses complex tool signatures without inventing nested input bindings', () => {
    const skeleton = skeletonWith({
      agentName: 'HotelSpecialist',
      runtimePattern: 'tool_worker',
      tools: [
        {
          name: 'search_hotels',
          signatureLiteral:
            'search_hotels(destination: string, filters: { rating: number, amenities: string[] }, guests: number = 2) -> { hotels: { name: string, rating: number }[], reason?: string }',
          descriptionLiteral: 'Search hotel inventory.',
          sideEffects: false,
          confirmPolicy: 'never',
          paramDescriptions: {
            destination: 'Destination.',
            filters: 'Structured search filters.',
            guests: 'Guest count.',
          },
          signatureSlot: 'tools.search_hotels.signature',
          descriptionSlot: 'tools.search_hotels.description',
        },
      ],
      gatherFields: [
        { name: 'destination', type: 'string', askSlot: 'gather.destination.ask' },
        { name: 'filters', type: 'object', askSlot: 'gather.filters.ask' },
        { name: 'guests', type: 'number', askSlot: 'gather.guests.ask' },
      ],
    });

    const runtimePlan = deriveScaffoldRuntimePlan(skeleton);

    expect(runtimePlan.toolCalls[0]?.with).toEqual({
      destination: 'destination',
      filters: 'filters',
      guests: 'guests',
    });
    expect(runtimePlan.toolCalls[0]?.resultFieldsUsed).toEqual([
      'searchHotelsResult.hotels',
      'searchHotelsResult.reason',
    ]);
  });
});

function skeletonWith(overrides: Partial<AblSkeleton>): AblSkeleton {
  return {
    agentName: 'Agent',
    keyword: 'AGENT',
    runtimePattern: 'tool_worker',
    goalSlot: 'goal',
    personaSlot: 'persona',
    handoffs: [],
    gatherFields: [],
    completeSlots: [],
    memorySessionVars: [],
    tools: [],
    includeGuardrails: false,
    ...overrides,
  };
}
